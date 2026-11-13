// Actual unmodified upstream, disposable profiles only. No real-site requests.
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { Store, digest, uid } from "../dist/core.js";
import {
  cliPath,
  cliEnv,
  closeOwned,
  configFile,
  findApp,
  pw,
  runCode,
  workspace,
} from "../dist/browser.js";
import { startLocal, stopLocal } from "../dist/session.js";
process.umask(0o077);
await fs.rm("evidence/upstream.json", { force: true });
const root = await fs.mkdtemp(
  path.join(await fs.realpath(os.tmpdir()), "pp-upstream-"),
);
const s = new Store(path.join(root, "private"));
await s.init();
const evidence = {
  schema: 1,
  kind: "actual-upstream-disposable-profile",
  upstream: "0.1.24",
  checks: [],
  limits: [
    "No personal credentials",
    "No real-site E2E or login",
    "No actual SSH server",
    "Synthetic storage does not prove personal decryption",
  ],
};
const mark = (name) => evidence.checks.push({ name, status: "passed" });
let sourceOpened = false;
const session = "pp-verification-" + Date.now();
const sourceRoot = path.join(root, "empty-source");
const cwd = await workspace(path.join(root, "export-workspace"));
let targetStarted = false;
try {
  const browser = process.platform === "darwin" ? "chrome-beta" : undefined;
  const app = browser ? await findApp(browser) : undefined;
  const executable = app
    ? path.join(app, "Contents/MacOS/Google Chrome Beta")
    : process.env.PP_VERIFY_EXECUTABLE;
  const cfg = await configFile(
    cwd,
    sourceRoot,
    executable,
    "Default",
    process.platform === "darwin",
  );
  // Hostile PLAYWRIGHT environment must not attach or run scripts.
  process.env.PLAYWRIGHT_MCP_CDP_ENDPOINT = "http://127.0.0.1:1";
  process.env.PLAYWRIGHT_MCP_EXTENSION = "true";
  const env = cliEnv(s);
  assert.equal(env.PLAYWRIGHT_MCP_EXTENSION, undefined);
  assert.equal(env.PLAYWRIGHT_MCP_CDP_ENDPOINT, undefined);
  await fs.mkdir(path.join(s.p("upstream-global"), ".playwright"), {
    recursive: true,
  });
  // The isolated empty global entry has no user's hooks or connection endpoints.
  sourceOpened = true;
  await pw(s, cwd, session, [
    "open",
    `--profile=${sourceRoot}`,
    `--config=${cfg}`,
    "--idle-timeout=0",
  ]);
  mark("headless isolated open with hostile MCP environment scrubbed");
  const raw = path.join(root, "raw.json");
  await runCode(
    s,
    cwd,
    session,
    `async page => { if(page.url()!=='about:blank') throw new Error('unexpected_navigation'); await page.context().storageState({path:${JSON.stringify(raw)},indexedDB:true}); }`,
  );
  assert.deepEqual(JSON.parse(await fs.readFile(raw, "utf8")), {
    cookies: [],
    origins: [],
  });
  mark(
    "run-code storageState writes file without require/process or secret stdout",
  );
  // Verify explicit cwd identity through unmodified CLI from a different caller cwd.
  const probe = execFileSync(
    process.execPath,
    [cliPath, `-s=${session}`, "run-code", "async page => ({url:page.url()})"],
    { cwd, env: cliEnv(s), encoding: "utf8" },
  );
  assert.match(probe, /about:blank/);
  mark("cross-cwd invocation through receipt workspace");
  if (process.platform === "darwin")
    await runCode(
      s,
      cwd,
      session,
      `async page => { await page.context().addCookies([{name:'disposable-positive',value:'synthetic-not-personal',domain:'.example.invalid',path:'/',expires:Math.floor(Date.now()/1000)+86400,httpOnly:true,secure:true,sameSite:'Lax'},{name:'disposable-session',value:'synthetic-session-only',domain:'.example.invalid',path:'/',expires:-1,httpOnly:true,secure:true,sameSite:'Lax'},{name:'disposable-empty',value:'',domain:'.example.invalid',path:'/',expires:Math.floor(Date.now()/1000)+86400,httpOnly:true,secure:true,sameSite:'Lax'}]); }`,
    );
  await closeOwned(s, cwd, session, sourceRoot);
  sourceOpened = false;
  if (process.platform === "darwin") {
    const config = {
      schema: 1,
      sources: {
        empty: {
          browser: "chrome-beta",
          profile: "Default",
          app,
          userData: sourceRoot,
          domains: [],
          origins: [],
        },
      },
      targets: {},
    };
    await s.save(config);
    const before = await treeDigest(sourceRoot);
    const receipt = JSON.parse(
      execFileSync(
        process.execPath,
        [
          path.resolve("dist/cli.js"),
          "--data-root",
          s.root,
          "refresh",
          "empty",
        ],
        { encoding: "utf8" },
      ),
    );
    assert.equal(receipt.cookieCount, 3);
    const exported = (await s.current(s.p("sources", "empty"))).state.cookies;
    assert(
      exported.some(
        (c) =>
          c.name === "disposable-positive" &&
          c.value === "synthetic-not-personal",
      ),
    );
    assert(
      exported.some((c) => c.name === "disposable-empty" && c.value === ""),
    );
    assert.equal(receipt.status, "refreshed");
    assert.deepEqual(await treeDigest(sourceRoot), before);
    mark(
      "actual macOS synthetic persistent/session/empty cookie clone round-trip and unchanged source",
    );
  }
  if (process.platform === "darwin") {
    const before = (await s.current(s.p("sources", "empty"))).version;
    const cookies = await fs
      .stat(path.join(sourceRoot, "Default", "Cookies"))
      .then(
        () => path.join(sourceRoot, "Default", "Cookies"),
        () => path.join(sourceRoot, "Default", "Network", "Cookies"),
      );
    execFileSync("python3", [
      "-c",
      `import sqlite3,sys
d=sqlite3.connect(sys.argv[1]);cols=d.execute('PRAGMA table_info(cookies)').fetchall();values={c[1]:('' if 'TEXT' in c[2] else 0) for c in cols};values.update(host_key='.example.invalid',name='bad-encryption',path='/',encrypted_value=b'v10invalidciphertext',value='');d.execute('INSERT INTO cookies('+','.join(values)+') VALUES('+','.join('?' for _ in values)+')',list(values.values()));d.commit();d.close()`,
      cookies,
    ]);
    let failed = false;
    try {
      execFileSync(
        process.execPath,
        [
          path.resolve("dist/cli.js"),
          "--data-root",
          s.root,
          "refresh",
          "empty",
        ],
        { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
      );
    } catch (e) {
      failed = true;
      const receipt = JSON.parse(e.stderr);
      assert.equal(receipt.status, "failed");
      assert(
        [
          "cookie_decryption_or_capture_failed",
          "browser_storage_error",
          "decryption_failed",
        ].includes(receipt.code),
      );
    }
    assert(failed);
    assert.equal((await s.current(s.p("sources", "empty"))).version, before);
    assert.equal((await fs.readdir(s.p("tmp"))).length, 0);
    mark(
      "actual disposable encrypted-cookie failure retains old version and cleans clone",
    );
  }
  const state = {
    cookies: [
      {
        name: "synthetic",
        value: "not-a-personal-credential",
        domain: "example.invalid",
        path: "/",
        expires: -1,
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
      },
    ],
    origins: [
      {
        origin: "https://example.invalid",
        localStorage: [{ name: "synthetic", value: "one" }],
        indexedDB: [
          {
            name: "synthetic-db",
            version: 1,
            stores: [
              {
                name: "items",
                autoIncrement: false,
                records: [{ key: "key", value: { synthetic: "one" } }],
                indexes: [],
              },
            ],
          },
        ],
      },
    ],
  };
  const envState = {
    schema: 1,
    version: uid(),
    createdAt: new Date().toISOString(),
    source: "synthetic",
    checksum: digest(state),
    state,
    warnings: [],
  };
  await s.activate(s.p("targets", "local"), envState);
  const started = await startLocal(s, "local", executable);
  targetStarted = true;
  assert.equal(started.cookieCount, 1);
  const idbProbe = path.join(root, "idb-probe.json");
  await runCode(
    s,
    s.p("targets", "local", "session-lock", "workspace"),
    started.session,
    `async page => { await page.context().storageState({path:${JSON.stringify(idbProbe)},indexedDB:true}); }`,
  );
  const captured = JSON.parse(await fs.readFile(idbProbe, "utf8"));
  assert.equal(
    captured.origins[0].indexedDB[0].stores[0].records[0].value.synthetic,
    "one",
  );
  mark(
    "actual synthetic IndexedDB record round-trip through run-code storage APIs",
  );
  mark(
    "actual persistent target loads synthetic state with unmodified run-code",
  );
  await assert.rejects(
    () => startLocal(s, "local", executable),
    /session_occupied/,
  );
  mark("concurrent target start rejected");
  const next = {
    ...envState,
    version: uid(),
    state: { cookies: state.cookies, origins: [] },
  };
  next.checksum = digest(next.state);
  await s.activate(s.p("targets", "local"), next);
  const owner = JSON.parse(
    await fs.readFile(
      s.p("targets", "local", "session-lock", "owner.json"),
      "utf8",
    ),
  );
  assert.equal(owner.version, envState.version);
  mark("refresh does not mutate occupied session");
  await stopLocal(s, "local");
  targetStarted = false;
  await startLocal(s, "local", executable);
  targetStarted = true;
  const newOwner = JSON.parse(
    await fs.readFile(
      s.p("targets", "local", "session-lock", "owner.json"),
      "utf8",
    ),
  );
  assert.equal(newOwner.version, next.version);
  const out = path.join(root, "narrow.json");
  await runCode(
    s,
    s.p("targets", "local", "session-lock", "workspace"),
    newOwner.session,
    `async page => { await page.context().storageState({path:${JSON.stringify(out)},indexedDB:true}); }`,
  );
  assert.equal(JSON.parse(await fs.readFile(out, "utf8")).origins.length, 0);
  mark(
    "restart loads latest version in clean profile after origin scope shrink",
  );
  await stopLocal(s, "local");
  targetStarted = false;
  assert.equal(
    await fs.stat(s.p("targets", "local", "session-lock")).then(
      () => true,
      () => false,
    ),
    false,
  );
  mark("owned target stop and profile cleanup");
} finally {
  if (sourceOpened) await closeOwned(s, cwd, session, sourceRoot);
  if (targetStarted) await stopLocal(s, "local");
  await fs.rm(root, { recursive: true, force: true });
}
evidence.status = "passed";
await fs.mkdir("evidence", { recursive: true });
await fs.writeFile(
  "evidence/upstream.json",
  JSON.stringify(evidence, null, 2) + "\n",
);
console.log(JSON.stringify(evidence, null, 2));
async function treeDigest(base) {
  const result = {};
  async function walk(p) {
    for (const e of await fs.readdir(p, { withFileTypes: true })) {
      const f = path.join(p, e.name);
      const rel = path.relative(base, f);
      if (e.isDirectory()) await walk(f);
      else if (e.isSymbolicLink())
        result[rel] = "link:" + (await fs.readlink(f));
      else result[rel] = digest((await fs.readFile(f)).toString("base64"));
    }
  }
  await walk(base);
  return result;
}
