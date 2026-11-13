import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import {
  check,
  dir,
  exec,
  exists,
  Fault,
  json,
  matchesDomain,
  noLinks,
  privateFile,
  secureTree,
  Source,
  State,
  Store,
  validateState,
  interrupted,
} from "./core.js";

export const cliPath = createRequire(import.meta.url).resolve(
  "@playwright/cli/playwright-cli.js",
);
const pythonScript = fileURLToPath(
  new URL("../scripts/sqlite_snapshot.py", import.meta.url),
);
const apps = {
  chrome: { name: "Google Chrome", id: "com.google.Chrome", folder: "Chrome" },
  "chrome-beta": {
    name: "Google Chrome Beta",
    id: "com.google.Chrome.beta",
    folder: "Chrome Beta",
  },
};
export function defaultUserData(browser: keyof typeof apps) {
  return path.join(
    os.homedir(),
    "Library/Application Support/Google",
    apps[browser].folder,
  );
}
export async function findApp(browser: keyof typeof apps) {
  for (const base of [
    "/Applications",
    path.join(os.homedir(), "Applications"),
  ]) {
    const p = path.join(base, apps[browser].name + ".app");
    if (await exists(p)) {
      await verifyApp(browser, p);
      return p;
    }
  }
  throw new Fault("browser_app_missing");
}
export async function verifyApp(browser: keyof typeof apps, app: string) {
  check(process.platform === "darwin", "macos_source_required");
  await noLinks(app);
  const id = (
    await exec("/usr/bin/plutil", [
      "-extract",
      "CFBundleIdentifier",
      "raw",
      "-o",
      "-",
      path.join(app, "Contents/Info.plist"),
    ])
  ).trim();
  check(id === apps[browser].id, "browser_identity_mismatch");
  const executable = path.join(app, "Contents/MacOS", apps[browser].name);
  check((await fs.stat(executable)).isFile(), "browser_executable_missing");
  return executable;
}
export function verifySourceChannel(
  browser: keyof typeof apps,
  userData: string,
) {
  const other = browser === "chrome" ? "chrome-beta" : "chrome";
  check(
    path.resolve(userData) !== defaultUserData(other),
    "source_channel_path_mismatch",
  );
}
export async function profiles(
  browser: keyof typeof apps,
  userData = defaultUserData(browser),
  app?: string,
) {
  verifySourceChannel(browser, userData);
  const appPath = app ?? (await findApp(browser));
  await verifyApp(browser, appPath);
  await noLinks(userData);
  const local = (await json(path.join(userData, "Local State"))) as {
    profile?: { info_cache?: Record<string, { name?: string }> };
  };
  const entries = [];
  for (const p of await fs.readdir(userData)) {
    if (!/^(Default|Profile [0-9]+)$/.test(p)) continue;
    await noLinks(path.join(userData, p));
    if (!(await exists(path.join(userData, p, "Preferences")))) continue;
    const prefs = (await json(path.join(userData, p, "Preferences"))) as {
      profile?: { name?: string };
    };
    entries.push({
      browser,
      profile: p,
      displayName:
        local.profile?.info_cache?.[p]?.name ?? prefs.profile?.name ?? p,
      userData,
      app: appPath,
    });
  }
  return entries;
}
export function cliEnv(store: Store): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (key.startsWith("PLAYWRIGHT_") || key.startsWith("PWTEST_"))
      delete env[key];
  return {
    ...env,
    NO_UPDATE_NOTIFIER: "1",
    PWTEST_CLI_GLOBAL_CONFIG: store.p("upstream-global"),
    PWTEST_DAEMON_SESSION_DIR: store.p("daemon"),
  };
}
export async function workspace(p: string) {
  await dir(p);
  await dir(path.join(p, ".playwright"));
  return p;
}
export async function pw(
  store: Store,
  cwd: string,
  session: string,
  args: string[],
) {
  if (args[0] !== "close") check(!interrupted, "interrupted");
  const out = await exec(
    process.execPath,
    [cliPath, `-s=${session}`, ...args],
    { cwd, env: cliEnv(store) },
  );
  check(
    !/### Error|"isError"\s*:\s*true/.test(out),
    "upstream_operation_failed",
  );
  return out;
}
export async function runCode(
  store: Store,
  cwd: string,
  session: string,
  code: string,
) {
  const file = path.join(cwd, "code-" + randomUUID() + ".js");
  await privateFile(file, code);
  try {
    return await pw(store, cwd, session, ["run-code", `--filename=${file}`]);
  } finally {
    await fs.rm(file, { force: true });
  }
}
export async function configFile(
  p: string,
  profile: string,
  executable?: string,
  profileDirectory = "Default",
  systemKeychain = false,
) {
  const config = {
    browser: {
      browserName: "chromium",
      isolated: false,
      userDataDir: profile,
      launchOptions: {
        headless: true,
        channel: "chromium",
        ...(executable ? { executablePath: executable } : {}),
        args: [
          `--profile-directory=${profileDirectory}`,
          ...(systemKeychain
            ? ["--restore-last-session", "--disable-extensions"]
            : []),
          "--enable-logging=stderr",
          "--log-level=1",
        ],
        ignoreDefaultArgs: systemKeychain
          ? ["--password-store=basic", "--use-mock-keychain"]
          : false,
      },
      contextOptions: { acceptDownloads: false, serviceWorkers: "block" },
    },
    extension: false,
    outputDir: path.join(p, "output"),
    saveSession: false,
    console: { level: "error" },
  };
  await dir(path.join(p, "output"));
  const f = path.join(p, "browser.json");
  await privateFile(f, JSON.stringify(config));
  return f;
}
const excluded = (n: string) =>
  /^(Singleton.*|LOCK|lockfile|DevToolsActivePort|BrowserMetrics.*|Crashpad|Crash Reports|Cache|Code Cache|GPUCache|Dawn.*Cache|ShaderCache|GrShaderCache|GraphiteDawnCache|Service Worker|Sessions|Current Session|Current Tabs|Last Session|Last Tabs|Session Storage|Login Data.*|Web Data.*|Trust Tokens.*|TransportSecurity|Safe Browsing.*|Certificate.*)$/i.test(
    n,
  );
type CookieRef = {
  domain: string;
  name: string;
  path: string;
  plaintextNonempty: boolean;
  partition: string;
};
export async function cloneSource(
  source: Source,
  dest: string,
): Promise<CookieRef[]> {
  await noLinks(source.userData);
  check(
    !(
      dest === source.userData ||
      dest.startsWith(source.userData + path.sep) ||
      source.userData.startsWith(dest + path.sep)
    ),
    "source_overlaps_clone",
  );
  const root = path.join(source.userData, source.profile);
  await noLinks(root);
  check((await fs.stat(root)).isDirectory(), "source_profile_missing");
  const prefs = await json(path.join(root, "Preferences"));
  check(prefs && typeof prefs === "object", "invalid_preferences");
  await dir(dest);
  await privateFile(
    path.join(dest, "Local State"),
    JSON.stringify(await json(path.join(source.userData, "Local State"))),
  );
  let refs: CookieRef[] | undefined;
  async function copy(from: string, to: string): Promise<void> {
    await noLinks(from);
    const stat = await fs.lstat(from);
    if (stat.isDirectory()) {
      await dir(to);
      for (const n of await fs.readdir(from)) {
        if (excluded(n) || /-(wal|shm|journal)$/.test(n)) continue;
        await copy(path.join(from, n), path.join(to, n));
      }
    } else {
      check(stat.isFile(), "special_file_rejected");
      const h = await fs.open(from, "r");
      const b = Buffer.alloc(16);
      try {
        await h.read(b, 0, 16, 0);
      } finally {
        await h.close();
      }
      if (
        b.toString() === "SQLite format 3\0" ||
        ["Cookies", "History", "Favicons", "Top Sites"].includes(
          path.basename(from),
        ) ||
        /\.sqlite$/.test(from)
      ) {
        const out = await exec("python3", [pythonScript, from, to]);
        const parsed = JSON.parse(out) as {
          cookies: CookieRef[];
          cookie_table: boolean;
        };
        if (path.basename(from) === "Cookies") {
          check(parsed.cookie_table, "cookie_table_missing");
          check(refs === undefined, "multiple_cookie_stores");
          refs = parsed.cookies;
        }
      } else {
        await privateFile(to, await fs.readFile(from));
      }
    }
  }
  await copy(root, path.join(dest, source.profile));
  // Preserve session cookies without copying or restoring daily tabs.
  const preferences = path.join(dest, source.profile, "Preferences");
  const clonedPreferences = (await json(preferences)) as Record<
    string,
    unknown
  >;
  clonedPreferences.session = { restore_on_startup: 1, startup_urls: [] };
  clonedPreferences.pinned_tabs = [];
  clonedPreferences.homepage = "about:blank";
  clonedPreferences.homepage_is_newtabpage = false;
  await fs.writeFile(preferences, JSON.stringify(clonedPreferences), {
    mode: 0o600,
  });
  check(refs !== undefined, "cookie_store_missing");
  await secureTree(dest);
  return refs;
}
export function reconcileCookies(
  refs: CookieRef[],
  state: State,
  domains: string[],
) {
  for (const ref of refs) {
    if (!matchesDomain(ref.domain, domains)) continue;
    const c = state.cookies.find(
      (c) =>
        c.domain === ref.domain &&
        c.name === ref.name &&
        c.path === ref.path &&
        (c.partitionKey ?? "") === (ref.partition ?? ""),
    );
    if (!(c && (!ref.plaintextNonempty || c.value.length > 0)))
      throw new Fault("cookie_decryption_or_capture_failed", "cookies");
  }
}
export async function browserProcesses(profile: string): Promise<boolean> {
  const out = await exec("/bin/ps", ["-axo", "pid=,command="]);
  return out
    .split("\n")
    .some(
      (line) =>
        line.includes(`--user-data-dir=${profile}`) ||
        line.includes(`--profile=${profile}`),
    );
}
export async function closeOwned(
  store: Store,
  cwd: string,
  session: string,
  profile: string,
) {
  let closeError = false;
  try {
    await pw(store, cwd, session, ["close"]);
  } catch {
    closeError = true;
  }
  for (let i = 0; i < 40; i++) {
    if (!(await browserProcesses(profile))) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Fault(
    closeError
      ? "close_failed_lock_retained"
      : "browser_still_running_lock_retained",
  );
}
async function inspectErrors(store: Store, session: string) {
  if (!(await exists(store.p("daemon")))) return;
  const visit = async (p: string): Promise<void> => {
    for (const n of await fs.readdir(p)) {
      const f = path.join(p, n);
      if ((await fs.lstat(f)).isDirectory()) await visit(f);
      else if (n === session + ".err") {
        const t = await fs.readFile(f, "utf8");
        if (
          /(?:failed to decrypt|decryption failed|OSCrypt.*(?:error|fail)|corrupt(?:ion|ed)|leveldb.*(?:error|fail))/i.test(
            t,
          )
        )
          throw new Fault("browser_storage_error");
      }
    }
  };
  await visit(store.p("daemon"));
}
export async function exportSource(store: Store, source: Source) {
  verifySourceChannel(source.browser, source.userData);
  const executable = await verifyApp(source.browser, source.app);
  check(
    !source.userData.startsWith(store.root + path.sep) &&
      !store.root.startsWith(source.userData + path.sep) &&
      source.userData !== store.root,
    "source_overlaps_data_root",
  );
  const temp = await fs.mkdtemp(store.p("tmp", "export-"));
  await fs.chmod(temp, 0o700);
  const profile = path.join(temp, "clone");
  const cwd = await workspace(path.join(temp, "workspace"));
  const session = "pp-export-" + randomUUID().slice(0, 12);
  let opened = false,
    closed = false;
  try {
    const refs = await cloneSource(source, profile);
    const cfg = await configFile(
      cwd,
      profile,
      executable,
      source.profile,
      true,
    );
    opened = true;
    await pw(store, cwd, session, [
      "open",
      `--config=${cfg}`,
      `--profile=${profile}`,
      "--idle-timeout=0",
    ]);
    const raw = path.join(temp, "cookies.json");
    await runCode(
      store,
      cwd,
      session,
      `async page => { if(page.context().pages().some(p=>p.url()!=='about:blank')) throw new Error('unexpected_startup_page'); await page.context().storageState({path:${JSON.stringify(raw)},indexedDB:false}); }`,
    );
    const initial = validateState(await json(raw));
    reconcileCookies(refs, initial, source.domains);
    const collected: State["origins"] = [];
    for (const origin of source.origins) {
      try {
        const out = path.join(temp, "origin-" + collected.length + ".json");
        await runCode(
          store,
          cwd,
          session,
          `async page => {
      const allowed=${JSON.stringify(origin)};
      await page.route('**/*', route => { const request=route.request(); if(request.isNavigationRequest() && new URL(request.url()).origin!==allowed) return route.abort('blockedbyclient'); return route.continue(); });
      try { const response=await page.goto(allowed,{waitUntil:'domcontentloaded',timeout:30000}); if(!response||!response.ok()||new URL(page.url()).origin!==allowed) throw new Error('origin_unavailable'); await page.evaluate(async () => { localStorage.length; await indexedDB.databases(); }); await page.context().storageState({path:${JSON.stringify(out)},indexedDB:true}); } finally { await page.unrouteAll({behavior:'wait'}); }
    }`,
        );
        const state = validateState(await json(out));
        const captured = state.origins.find((o) => o.origin === origin) ?? {
          origin,
          localStorage: [],
          indexedDB: [],
        };
        collected.push(captured);
      } catch {
        throw new Fault("origin_capture_failed", origin);
      }
    }
    await inspectErrors(store, session);
    const result: State = {
      cookies: initial.cookies.filter((c) =>
        matchesDomain(c.domain, source.domains),
      ),
      origins: collected,
    };
    validateState(result);
    await closeOwned(store, cwd, session, profile);
    closed = true;
    return {
      state: result,
      warnings: [
        "best_effort_snapshot",
        "cross_store_consistency_not_guaranteed",
        "origin_silent_empty_storage_not_independently_verifiable",
        "encrypted_cookie_plaintext_nonemptiness_not_independently_verifiable",
      ],
    };
  } finally {
    if (opened && !closed) {
      try {
        await closeOwned(store, cwd, session, profile);
        closed = true;
      } catch {
        /* Keep clone when a process may still own it. */
      }
    }
    if (!opened || closed) await fs.rm(temp, { recursive: true, force: true });
    else throw new Fault("export_cleanup_failed_clone_retained");
  }
}
