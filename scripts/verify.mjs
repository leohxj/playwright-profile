// Isolated protocol validation and explicit failure injection. No real SSH/browser calls.
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import {
  Store,
  digest,
  uid,
  matchesDomain,
  validateEnvelope,
  validateState,
  sourceSchema,
  mutex,
  quote,
} from "../dist/core.js";
import {
  cloneSource,
  reconcileCookies,
  findApp,
  profiles,
  verifyApp,
} from "../dist/browser.js";
import { remote } from "../dist/remote.js";
process.umask(0o077);
await fs.rm("evidence/protocol.json", { force: true });
const temp = await fs.mkdtemp(
  path.join(await fs.realpath(os.tmpdir()), "pp-protocol-"),
);
const evidence = {
  schema: 1,
  kind: "isolated-protocol-and-failure-injection",
  checks: [],
  limits: [
    "SSH uses a local fake executable, no server contacted",
    "SQLite uses synthetic data",
    "No personal credentials or real-site E2E",
  ],
};
const mark = (name) => evidence.checks.push({ name, status: "passed" });
const cli = path.resolve("dist/cli.js");
const store = new Store(path.join(temp, "private"));
await store.init();
const cookie = {
  name: "synthetic",
  value: "not-personal",
  domain: ".example.invalid",
  path: "/",
  expires: -1,
  httpOnly: true,
  secure: true,
  sameSite: "Lax",
};
const state = {
  cookies: [cookie],
  origins: [
    {
      origin: "https://example.invalid",
      localStorage: [{ name: "a", value: "one" }],
      indexedDB: [],
    },
  ],
};
function envelope(s = state) {
  return {
    schema: 1,
    version: uid(),
    createdAt: new Date().toISOString(),
    source: "synthetic",
    state: s,
    checksum: digest(s),
    warnings: [],
  };
}
async function run(args, input, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], {
      env: env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "",
      err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => resolve({ code, out, err }));
    child.stdin.end(input);
  });
}
async function hashes(root) {
  const out = {};
  async function visit(p) {
    for (const d of await fs.readdir(p, { withFileTypes: true })) {
      const f = path.join(p, d.name);
      if (d.isDirectory()) await visit(f);
      else if (d.isFile())
        out[path.relative(root, f)] = digest(
          (await fs.readFile(f)).toString("base64"),
        );
    }
  }
  await visit(root);
  return out;
}
try {
  for (const host of [
    "example.invalid",
    ".example.invalid",
    "a.example.invalid",
  ])
    assert.equal(matchesDomain(host, ["example.invalid"]), true);
  for (const host of [
    "evilexample.invalid",
    "example.invalid.evil",
    "other.invalid",
  ])
    assert.equal(matchesDomain(host, ["example.invalid"]), false);
  mark("cookie filtering honors exact host and subdomain boundaries");
  assert.throws(() =>
    sourceSchema.parse({
      browser: "chrome",
      profile: "../Default",
      userData: "/safe",
      app: "/app",
      domains: [],
      origins: [],
    }),
  );
  assert.throws(() =>
    validateState({
      ...state,
      origins: [{ origin: "https://example.invalid/path", localStorage: [] }],
    }),
  );
  assert.throws(() => validateState({ ...state, passwords: [] }));
  mark(
    "unsafe profile paths, non-origin URLs and extra credential fields rejected",
  );
  const base = store.p("targets", "local");
  const old = envelope();
  await store.activate(base, old);
  await assert.rejects(
    () => store.activate(base, { ...envelope(), checksum: "0".repeat(64) }),
    /checksum/,
  );
  await assert.rejects(
    () => store.activate(base, envelope({ cookies: [], origins: [] })),
    /suspicious_empty/,
  );
  await assert.rejects(
    () =>
      store.activate(
        base,
        envelope({
          ...state,
          origins: [
            {
              origin: "https://example.invalid",
              localStorage: [],
              indexedDB: [],
            },
          ],
        }),
      ),
    /suspicious_empty_origin/,
  );
  assert.equal((await store.current(base)).version, old.version);
  mark(
    "checksum failure and suspicious empty cookie/origin replacement retain old version",
  );
  for (const expires of [-2, -0.5, 253402300800]) {
    await assert.rejects(() =>
      store.activate(
        base,
        envelope({ ...state, cookies: [{ ...cookie, expires }] }),
      ),
    );
    assert.equal((await store.current(base)).version, old.version);
  }
  for (const expires of [-1, 0, 253402300799])
    validateState({ ...state, cookies: [{ ...cookie, expires }] });
  for (const field of [
    "name",
    "value",
    "domain",
    "path",
    "expires",
    "httpOnly",
    "secure",
    "sameSite",
  ]) {
    const missing = { ...cookie };
    delete missing[field];
    assert.throws(() => validateState({ ...state, cookies: [missing] }));
  }
  validateState({ ...state, cookies: [{ ...cookie, name: "" }] });
  mark(
    "cookie expiry bounds and required stored-cookie fields match pinned upstream validation before activation",
  );
  const tamper = store.p(
    "targets",
    "local",
    "versions",
    old.version,
    "state.json",
  );
  await fs.writeFile(tamper, JSON.stringify({ cookies: [], origins: [] }));
  await assert.rejects(() => store.current(base), /checksum/);
  await fs.writeFile(tamper, JSON.stringify(state));
  mark("loading checks credential file checksum independently from envelope");
  await mutex(base, async () => {
    await assert.rejects(
      () => mutex(base, async () => {}),
      /operation_occupied/,
    );
  });
  mark("atomic operation lock rejects overlapping changes");
  let stop = false;
  const reader = (async () => {
    while (!stop) {
      const v = await store.current(base);
      assert(v && v.checksum === digest(v.state));
    }
  })();
  for (let n = 0; n < 5; n++) await store.activate(base, envelope());
  stop = true;
  await reader;
  mark("concurrent current readers see complete immutable versions");
  assert.equal((await fs.stat(base)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(tamper)).mode & 0o777, 0o600);
  mark("private directories 0700 and credential files 0600");
  const sourceRoot = path.join(temp, "source");
  await fs.mkdir(path.join(sourceRoot, "Default"), { recursive: true });
  await fs.writeFile(
    path.join(sourceRoot, "Local State"),
    JSON.stringify({
      profile: {
        info_cache: {
          Default: { name: "Same" },
          "Profile 1": { name: "Same" },
        },
      },
    }),
  );
  await fs.writeFile(path.join(sourceRoot, "Default", "Preferences"), "{}");
  await fs.mkdir(path.join(sourceRoot, "Profile 1"));
  await fs.writeFile(path.join(sourceRoot, "Profile 1", "Preferences"), "{}");
  const db = path.join(sourceRoot, "Default", "Cookies");
  execFileSync("python3", [
    "-c",
    `import sqlite3,sys\ndb=sqlite3.connect(sys.argv[1])\ndb.execute('CREATE TABLE cookies(host_key TEXT,name TEXT,path TEXT,expires_utc INTEGER,value TEXT,encrypted_value BLOB)')\ndb.execute("INSERT INTO cookies VALUES('.example.invalid','synthetic','/',0,'',X'010203')")\ndb.commit()\ndb.close()`,
    db,
  ]);
  const source = {
    browser: "chrome-beta",
    profile: "Default",
    userData: sourceRoot,
    app: "/not-used",
    domains: [],
    origins: [],
  };
  assert.throws(
    () =>
      reconcileCookies(
        [
          {
            domain: cookie.domain,
            name: cookie.name,
            path: "/",
            plaintextNonempty: true,
            partition: "",
          },
        ],
        { cookies: [], origins: [] },
        [],
      ),
    /decryption_or_capture/,
  );
  assert.throws(
    () =>
      reconcileCookies(
        [
          {
            domain: cookie.domain,
            name: cookie.name,
            path: "/",
            plaintextNonempty: true,
            partition: "",
          },
        ],
        { cookies: [{ ...cookie, value: "" }], origins: [] },
        [],
      ),
    /decryption_or_capture/,
  );
  mark(
    "identity loss and known nonempty source plaintext becoming empty are rejected",
  );
  const before = await hashes(sourceRoot);
  const refs = await cloneSource(source, path.join(temp, "clone"));
  assert.equal(refs.length, 1);
  assert.equal(refs[0].plaintextNonempty, false);
  reconcileCookies(
    refs,
    { cookies: [{ ...cookie, value: "" }], origins: [] },
    [],
  );
  mark(
    "encrypted source records allow legitimate empty cookie values without inferring plaintext from ciphertext length",
  );
  assert.deepEqual(await hashes(sourceRoot), before);
  mark(
    "SQLite ONLINE BACKUP from private staged DB, encrypted identity metadata, source byte hashes unchanged",
  );
  // Live WAL and SHM source. Connection remains open while copier runs.
  const walScript = `import sqlite3,sys\nd=sqlite3.connect(sys.argv[1]);d.execute('PRAGMA journal_mode=WAL');d.execute("INSERT INTO cookies VALUES('.example.invalid','wal','/',0,'x',X'')");d.commit();print('ready',flush=True);sys.stdin.read();d.close()`;
  const writer = spawn("python3", ["-c", walScript, db], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  await new Promise((r) => writer.stdout.once("data", r));
  const beforeWal = await hashes(sourceRoot);
  const walRefs = await cloneSource(source, path.join(temp, "clone-wal"));
  assert(walRefs.some((c) => c.name === "wal"));
  assert.deepEqual(await hashes(sourceRoot), beforeWal);
  writer.stdin.end();
  await new Promise((r) => writer.once("close", r));
  mark("live WAL included without source SHM writes or creation");
  await fs.writeFile(db, "SQLite format 3\0corrupted");
  await assert.rejects(() =>
    cloneSource(source, path.join(temp, "corrupt-clone")),
  );
  assert((await store.current(base)).state.cookies.length);
  mark("corrupt SQLite copy fails and prior version remains valid");
  await fs.rm(db);
  await assert.rejects(
    () => cloneSource(source, path.join(temp, "missing-clone")),
    /cookie_store_missing/,
  );
  mark("missing cookie database rejected");
  await fs.symlink("/etc/hosts", path.join(sourceRoot, "Default", "unsafe"));
  await assert.rejects(
    () => cloneSource(source, path.join(temp, "unsafe-clone")),
    /symlink/,
  );
  await fs.rm(path.join(sourceRoot, "Default", "unsafe"));
  mark("source symlink rejected without following it");
  if (process.platform === "darwin") {
    const app = await findApp("chrome-beta");
    const list = await profiles("chrome-beta", sourceRoot, app);
    assert.equal(list.filter((x) => x.displayName === "Same").length, 2);
    assert.deepEqual(
      new Set(list.map((x) => x.profile)),
      new Set(["Default", "Profile 1"]),
    );
    await assert.rejects(() => verifyApp("chrome", app), /identity_mismatch/);
    mark(
      "same display names remain distinct by directory, mismatched browser app rejected",
    );
  }
  const rr = path.join(temp, "remote root's private");
  const rs = new Store(rr);
  await rs.init();
  await rs.save({
    schema: 1,
    sources: {},
    targets: { dest: { kind: "local" } },
  });
  const initial = envelope();
  const init = await run(
    ["--data-root", rr, "internal", "receive", "dest"],
    JSON.stringify(initial),
  );
  assert.equal(init.code, 0);
  assert.equal(JSON.parse(init.out).origins[0], "https://example.invalid");
  mark("receiver validates envelope and reports origin list without values");
  for (const expires of [-2, 253402300800]) {
    const rejected = await run(
      ["--data-root", rr, "internal", "receive", "dest"],
      JSON.stringify(envelope({ ...state, cookies: [{ ...cookie, expires }] })),
    );
    assert.notEqual(rejected.code, 0);
    assert.equal(
      (await rs.current(rs.p("targets", "dest"))).version,
      initial.version,
    );
  }
  mark(
    "receiver rejects correctly checksummed invalid expiry and preserves previous current version",
  );
  const hook = path.join(temp, "workspace-failure.cjs");
  const failedWorkspace = rs.p("targets", "dest", "session-lock", "workspace");
  await fs.writeFile(
    hook,
    `const fs=require('node:fs/promises');const original=fs.mkdir;fs.mkdir=async function(p,...args){if(String(p)===${JSON.stringify(failedWorkspace)})throw Object.assign(new Error('injected workspace failure'),{code:'EACCES'});return original.call(this,p,...args);};`,
  );
  const prepFailure = await run(
    ["--data-root", rr, "session", "start", "dest"],
    undefined,
    { ...process.env, NODE_OPTIONS: "--require=" + hook },
  );
  assert.notEqual(prepFailure.code, 0);
  assert.equal(
    await fs.stat(rs.p("targets", "dest", "session-lock")).then(
      () => true,
      () => false,
    ),
    false,
  );
  assert.equal(
    await fs.stat(rs.p("targets", "dest", ".operation")).then(
      () => true,
      () => false,
    ),
    false,
  );
  mark(
    "injected workspace preparation failure removes the newly owned lock before browser launch",
  );
  const bin = path.join(temp, "bin");
  await fs.mkdir(bin);
  const ssh = path.join(bin, "ssh");
  await fs.writeFile(
    ssh,
    `#!/usr/bin/env node\nconst{spawnSync}=require('node:child_process');let text='';process.stdin.on('data',d=>text+=d);process.stdin.on('end',()=>{if(process.env.PP_FAULT==='interrupt')text=text.slice(0,32);if(process.env.PP_FAULT==='checksum'){let e=JSON.parse(text);e.checksum='0'.repeat(64);text=JSON.stringify(e);}const result=spawnSync('/bin/sh',['-c',process.argv.at(-1)],{input:text,encoding:'utf8',env:process.env});process.stdout.write(result.stdout||'');process.stderr.write(result.stderr||'');process.exit(result.status??1);});\n`,
    { mode: 0o700 },
  );
  const savedPath = process.env.PATH;
  process.env.PATH = bin + path.delimiter + savedPath;
  const target = {
    kind: "ssh",
    host: "explicit.invalid",
    root: rr,
    cli,
    node: process.execPath,
    target: "dest",
  };
  const newer = envelope();
  const received = await remote(
    store,
    target,
    ["internal", "receive", "dest"],
    JSON.stringify(newer),
  );
  assert.equal(received.checksum, newer.checksum);
  assert.equal(
    (await rs.current(rs.p("targets", "dest"))).version,
    newer.version,
  );
  mark(
    "SSH local simulation transfers latest state with shell-safe quote in root",
  );
  for (const fault of ["interrupt", "checksum"]) {
    process.env.PP_FAULT = fault;
    await assert.rejects(() =>
      remote(
        store,
        target,
        ["internal", "receive", "dest"],
        JSON.stringify(envelope()),
      ),
    );
    assert.equal(
      (await rs.current(rs.p("targets", "dest"))).version,
      newer.version,
    );
  }
  delete process.env.PP_FAULT;
  process.env.PATH = savedPath;
  mark(
    "SSH interruption and checksum simulation retain remote current version",
  );
  assert.equal(quote("a'b"), "'a'\\''b'");
  const fail = await run(
    ["--data-root", rr, "internal", "receive", "dest"],
    JSON.stringify({
      ...envelope(),
      state: { ...state, passwords: ["forbidden"] },
    }),
  );
  assert.notEqual(fail.code, 0);
  assert(!fail.err.includes("forbidden"));
  mark("failed receiver receipts expose no state values");
  const unknown = await run(
    ["--data-root", rr, "internal", "receive", "missing"],
    JSON.stringify(envelope()),
  );
  assert.notEqual(unknown.code, 0);
  mark("receiver rejects unknown target");
  const lock = rs.p("targets", "dest", "session-lock");
  await fs.mkdir(lock);
  const occupied = await run(["--data-root", rr, "session", "start", "dest"]);
  assert.notEqual(occupied.code, 0);
  const status = await run(["--data-root", rr, "status"]);
  assert(
    JSON.parse(status.out).targets.some(
      (t) => t.session.status === "unknown_lock_requires_inspection",
    ),
  );
  assert.equal(await fs.stat(lock).then(() => true), true);
  mark("unknown occupancy lock is reported and retained");
  await fs.writeFile(
    path.join(lock, "owner.json"),
    JSON.stringify({
      session: "pp-stale-verification",
      createdAt: new Date().toISOString(),
      version: initial.version,
      checksum: initial.checksum,
    }),
  );
  await fs.mkdir(path.join(lock, "workspace", ".playwright"), {
    recursive: true,
  });
  const holder = spawn(
    process.execPath,
    [
      "-e",
      "setInterval(()=>{},1000)",
      "--",
      `--user-data-dir=${path.join(lock, "profile")}`,
    ],
    { stdio: "ignore" },
  );
  try {
    const heldStop = await run(["--data-root", rr, "session", "stop", "dest"]);
    assert.notEqual(heldStop.code, 0);
    assert.equal(await fs.stat(lock).then(() => true), true);
    mark(
      "profile-owning process simulation prevents stop failure from freeing lock",
    );
  } finally {
    holder.kill("SIGTERM");
    await new Promise((r) => holder.once("close", r));
  }
  const staleStop = await run(["--data-root", rr, "session", "stop", "dest"]);
  assert.equal(staleStop.code, 0);
  assert.equal(
    await fs.stat(lock).then(
      () => true,
      () => false,
    ),
    false,
  );
  mark("explicit stop recovers stale owned session after process exit");
  const nonemptyRoot = path.join(temp, "not-owned");
  await fs.mkdir(nonemptyRoot);
  await fs.writeFile(path.join(nonemptyRoot, "keep"), "unchanged");
  const oldMode = (await fs.stat(nonemptyRoot)).mode;
  const rejectedRoot = await run(["--data-root", nonemptyRoot, "status"]);
  assert.notEqual(rejectedRoot.code, 0);
  assert.equal((await fs.stat(nonemptyRoot)).mode, oldMode);
  assert.deepEqual(await fs.readdir(nonemptyRoot), ["keep"]);
  mark("unowned nonempty data root rejected before chmod or writes");
  if (process.platform === "darwin") {
    const app = await findApp("chrome-beta");
    execFileSync("python3", [
      "-c",
      "import sqlite3,sys; d=sqlite3.connect(sys.argv[1]); d.execute('CREATE TABLE cookies(host_key TEXT,name TEXT,path TEXT,expires_utc INTEGER,value TEXT,encrypted_value BLOB)');d.commit();d.close()",
      db,
    ]);
    await store.save({
      schema: 1,
      sources: { synthetic: { ...source, app } },
      targets: {},
    });
    const prior = envelope();
    await store.activate(store.p("sources", "synthetic"), prior);
    const marker = path.join(temp, "copy-started");
    const fakePython = path.join(bin, "python3");
    await fs.writeFile(
      fakePython,
      `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)},'ready');setInterval(()=>{},1000);\n`,
      { mode: 0o700 },
    );
    const child = spawn(
      process.execPath,
      [cli, "--data-root", store.root, "refresh", "synthetic"],
      {
        env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    child.stdout.resume();
    const exit = new Promise((r) => child.once("close", r));
    try {
      for (let i = 0; i < 200; i++) {
        if (
          await fs.stat(marker).then(
            () => true,
            () => false,
          )
        )
          break;
        await new Promise((r) => setTimeout(r, 25));
      }
      assert(
        await fs.stat(marker).then(
          () => true,
          () => false,
        ),
      );
      child.kill("SIGTERM");
      const code = await exit;
      assert.notEqual(code, 0);
      assert.equal(JSON.parse(stderr).status, "failed");
      assert.equal(
        (await store.current(store.p("sources", "synthetic"))).version,
        prior.version,
      );
      assert.deepEqual(await fs.readdir(store.p("tmp")), []);
      mark(
        "SIGTERM during injected copy cleans private temp and retains previous source version",
      );
    } finally {
      child.kill("SIGTERM");
    }
  }
  validateEnvelope(envelope());
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}
evidence.status = "passed";
await fs.mkdir("evidence", { recursive: true });
await fs.writeFile(
  "evidence/protocol.json",
  JSON.stringify(evidence, null, 2) + "\n",
);
console.log(JSON.stringify(evidence, null, 2));
