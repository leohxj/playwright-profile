import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  atomic,
  check,
  dir,
  exists,
  Fault,
  json,
  mutex,
  privateFile,
  quote,
  Store,
  validateState,
  interrupted,
} from "./core.js";
import {
  browserProcesses,
  cliEnv,
  cliPath,
  closeOwned,
  configFile,
  pw,
  runCode,
  workspace,
} from "./browser.js";

const ownerSchema = z.strictObject({
  session: z.string().regex(/^pp-[a-z0-9-]+$/),
  createdAt: z.string().datetime(),
  version: z.string(),
  checksum: z.string(),
});
export async function sessionStatus(store: Store, name: string) {
  const base = store.p("targets", name);
  const lock = path.join(base, "session-lock");
  if (!(await exists(lock))) return { status: "stopped" };
  try {
    const owner = ownerSchema.parse(await json(path.join(lock, "owner.json")));
    const running = await browserProcesses(path.join(lock, "profile"));
    return {
      ...owner,
      status: running ? "running" : "stale_lock_requires_stop",
    };
  } catch {
    return { status: "unknown_lock_requires_inspection" };
  }
}
export async function startLocal(
  store: Store,
  name: string,
  executable?: string,
) {
  const base = store.p("targets", name);
  return mutex(base, async () => {
    const e = await store.current(base);
    check(e, "target_state_missing");
    const lock = path.join(base, "session-lock");
    try {
      await fs.mkdir(lock, { mode: 0o700 });
    } catch {
      throw new Fault("session_occupied_requires_stop");
    }
    const session = "pp-" + name + "-" + randomUUID().slice(0, 8);
    const profile = path.join(lock, "profile");
    const cwd = path.join(lock, "workspace");
    let attempted = false;
    try {
      await workspace(cwd);
      await dir(profile);
      await privateFile(
        path.join(lock, "owner.json"),
        JSON.stringify({
          session,
          createdAt: new Date().toISOString(),
          version: e.version,
          checksum: e.checksum,
        }),
      );
      const cfg = await configFile(cwd, profile, executable);
      attempted = true;
      await pw(store, cwd, session, [
        "open",
        `--config=${cfg}`,
        `--profile=${profile}`,
        "--idle-timeout=0",
      ]);
      const stateFile = path.join(base, "versions", e.version, "state.json");
      await runCode(
        store,
        cwd,
        session,
        `async page => { await page.context().setStorageState(${JSON.stringify(stateFile)}); }`,
      );
      const probe = path.join(lock, "loaded.json");
      await runCode(
        store,
        cwd,
        session,
        `async page => { await page.context().storageState({path:${JSON.stringify(probe)},indexedDB:true}); }`,
      );
      const loaded = validateState(await json(probe));
      check(
        loaded.cookies.length ===
          e.state.cookies.filter(
            (c) => c.expires === -1 || c.expires > Date.now() / 1000,
          ).length,
        "state_load_cookie_count_mismatch",
      );
      for (const expected of e.state.cookies.filter(
        (c) => c.expires === -1 || c.expires > Date.now() / 1000,
      )) {
        check(
          loaded.cookies.some(
            (c) =>
              c.name === expected.name &&
              c.domain === expected.domain &&
              c.path === expected.path &&
              (c.partitionKey ?? "") === (expected.partitionKey ?? "") &&
              c.value === expected.value,
          ),
          "state_load_cookie_value_mismatch",
        );
      }
      for (const expected of e.state.origins) {
        const actual = loaded.origins.find((o) => o.origin === expected.origin);
        for (const item of expected.localStorage)
          check(
            actual?.localStorage.some(
              (x) => x.name === item.name && x.value === item.value,
            ),
            "state_load_localstorage_mismatch",
          );
        for (const db of expected.indexedDB ?? [])
          check(
            actual?.indexedDB?.some(
              (x) =>
                x.name === db.name &&
                x.version === db.version &&
                x.stores.length === db.stores.length,
            ),
            "state_load_indexeddb_mismatch",
          );
      }
      check(!interrupted, "interrupted");
      await fs.rm(probe, { force: true });
      return {
        status: "running",
        session,
        version: e.version,
        checksum: e.checksum,
        cookieCount: e.state.cookies.length,
        origins: e.state.origins.map((o) => o.origin),
        cwd,
        examples: [
          "snapshot",
          'run-code "async page => await page.title()"',
        ].map(
          (cmd) =>
            `cd ${quote(cwd)} && ${Object.entries(cliEnv(store))
              .filter(([k]) =>
                [
                  "NO_UPDATE_NOTIFIER",
                  "PWTEST_CLI_GLOBAL_CONFIG",
                  "PWTEST_DAEMON_SESSION_DIR",
                ].includes(k),
              )
              .map(([k, v]) => `${k}=${quote(v!)}`)
              .join(
                " ",
              )} ${quote(process.execPath)} ${quote(cliPath)} -s=${session} ${cmd}`,
        ),
      };
    } catch (error) {
      if (attempted) {
        try {
          await closeOwned(store, cwd, session, profile);
        } catch {
          throw new Fault("start_failed_session_lock_retained");
        }
      }
      await fs.rm(lock, { recursive: true, force: true });
      throw error;
    }
  });
}
export async function stopLocal(store: Store, name: string) {
  const base = store.p("targets", name);
  return mutex(base, async () => {
    const lock = path.join(base, "session-lock");
    if (!(await exists(lock))) return { status: "stopped" };
    const owner = ownerSchema.parse(await json(path.join(lock, "owner.json")));
    await closeOwned(
      store,
      path.join(lock, "workspace"),
      owner.session,
      path.join(lock, "profile"),
    );
    await fs.rm(lock, { recursive: true, force: true });
    return { status: "stopped", session: owner.session };
  });
}
// Config and immutable state changes never touch session-lock/profile.
export async function markSessionFailure(
  store: Store,
  name: string,
  code: string,
) {
  await atomic(
    store.p("targets", name, "last-session-error.json"),
    JSON.stringify({ code, time: new Date().toISOString() }),
  );
}
