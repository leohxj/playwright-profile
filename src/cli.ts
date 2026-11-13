#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { z } from "zod";
import {
  check,
  digest,
  envelopeSchema,
  exists,
  Fault,
  json,
  localSchema,
  mutex,
  nameSchema,
  Source,
  sourceSchema,
  sshSchema,
  Store,
  uid,
  validateEnvelope,
} from "./core.js";
import {
  defaultUserData,
  exportSource,
  findApp,
  profiles,
  verifyApp,
} from "./browser.js";
import {
  markSessionFailure,
  sessionStatus,
  startLocal,
  stopLocal,
} from "./session.js";
import { remote } from "./remote.js";
import { schedule, scheduleStatus } from "./schedule.js";

process.umask(0o077);
const program = new Command()
  .name("playwright-profile")
  .description(
    "Private immutable storage snapshots using unmodified playwright-cli 0.1.24",
  )
  .version("0.1.0")
  .option(
    "--data-root <absolute-path>",
    "private config/state root; env PLAYWRIGHT_PROFILE_DATA_ROOT",
  )
  .showHelpAfterError()
  .configureOutput({ outputError: (s) => process.stderr.write(s) });
let activeStore: Store | undefined,
  activeCommand = "command";
async function execute(
  command: string,
  fn: (s: Store) => Promise<Record<string, unknown>>,
) {
  activeCommand = command;
  const s = new Store(program.opts().dataRoot);
  await s.init();
  activeStore = s;
  try {
    const result = await fn(s);
    const receipt = await s.receipt(command, {
      status: "ok",
      failedCollections: [],
      warnings: [],
      ...result,
    });
    console.log(JSON.stringify(receipt, null, 2));
  } catch (e) {
    if (command.startsWith("session-"))
      await markSessionFailure(
        s,
        command.slice(command.indexOf("-") + 1).replace(/^(start|stop)-/, ""),
        e instanceof Fault ? e.code : "command_failed",
      ).catch(() => {});
    throw e;
  }
}
function getName(s: string) {
  return nameSchema.parse(s);
}
function getSource(c: Awaited<ReturnType<Store["config"]>>, n: string): Source {
  check(c.sources[n], "source_not_found");
  return c.sources[n];
}
function getTarget(c: Awaited<ReturnType<Store["config"]>>, n: string) {
  check(c.targets[n], "target_not_found");
  return c.targets[n];
}
const profilesCommand = program
  .command("profiles")
  .description("Discover macOS Chrome applications and profile directories");
profilesCommand
  .command("list")
  .option("--browser <browser>", "chrome or chrome-beta")
  .option("--user-data-dir <absolute-path>", "explicit discovery root")
  .option("--app <absolute-path>", "explicit .app path")
  .action(async (opts) =>
    execute("profiles-list", async () => {
      const list = [];
      const warnings = [];
      const browsers = opts.browser
        ? [z.enum(["chrome", "chrome-beta"]).parse(opts.browser)]
        : (["chrome", "chrome-beta"] as const);
      for (const browser of browsers)
        try {
          list.push(...(await profiles(browser, opts.userDataDir, opts.app)));
        } catch (e) {
          if (opts.browser) throw e;
          warnings.push(
            browser + ":" + (e instanceof Fault ? e.code : "discovery_failed"),
          );
        }
      return { profiles: list, warnings };
    }),
  );
program
  .command("source")
  .description("Register a source without exporting credentials")
  .command("add <name>")
  .requiredOption("--browser <browser>", "chrome or chrome-beta")
  .requiredOption(
    "--profile <directory>",
    "Default or Profile N; display name is never identity",
  )
  .option(
    "--user-data-dir <absolute-path>",
    "source root, macOS browser default otherwise",
  )
  .option("--app <absolute-path>", "matching .app path")
  .option(
    "--domain <domain...>",
    "cookie domain boundaries; absent means all cookies",
  )
  .option(
    "--origin <origin...>",
    "explicit exact origins for localStorage and IndexedDB",
  )
  .action(async (name, opts) =>
    execute("source-add", async (s) =>
      mutex(s.root, async () => {
        getName(name);
        const browser = z.enum(["chrome", "chrome-beta"]).parse(opts.browser);
        const source = sourceSchema.parse({
          browser,
          profile: opts.profile,
          userData: opts.userDataDir ?? defaultUserData(browser),
          app: opts.app ?? (await findApp(browser)),
          domains: opts.domain ?? [],
          origins: opts.origin ?? [],
        });
        await verifyApp(browser, source.app);
        const found = await profiles(browser, source.userData, source.app);
        check(
          found.some((p) => p.profile === source.profile),
          "source_profile_missing",
        );
        check(
          !source.userData.startsWith(s.root + path.sep) &&
            !s.root.startsWith(source.userData + path.sep) &&
            source.userData !== s.root,
          "source_overlaps_data_root",
        );
        const c = await s.config();
        check(!c.sources[name], "source_already_exists");
        c.sources[name] = source;
        await s.save(c);
        return {
          source: name,
          browser,
          profile: source.profile,
          domains: source.domains,
          origins: source.origins,
          status: "registered",
        };
      }),
    ),
  );
program
  .command("refresh <name>")
  .description(
    "Clone source, export credentials and atomically activate new source version",
  )
  .action(async (name) =>
    execute("refresh-" + getName(name), async (s) =>
      mutex(s.p("sources", name), async () => {
        const source = getSource(await s.config(), name);
        const { state, warnings } = await exportSource(s, source);
        const e = envelopeSchema.parse({
          schema: 1,
          version: uid(),
          createdAt: new Date().toISOString(),
          source: name,
          checksum: digest(state),
          state,
          warnings,
        });
        await s.activate(s.p("sources", name), e);
        return {
          status: "refreshed",
          source: name,
          version: e.version,
          checksum: e.checksum,
          cookieCount: state.cookies.length,
          origins: state.origins.map((o) => o.origin),
          warnings,
        };
      }),
    ),
  );
program
  .command("target")
  .description("Register an independent local or explicit SSH target")
  .command("add <name>")
  .option("--ssh-host <host>", "explicit SSH host or user@host")
  .option("--remote-root <absolute-path>", "private remote data root")
  .option(
    "--remote-cli <absolute-path>",
    "same version installed remote dist/cli.js",
  )
  .option("--remote-node <absolute-path>", "remote Node 22+ executable")
  .option(
    "--remote-target <name>",
    "preconfigured local target on remote; default same name",
  )
  .option(
    "--executable <absolute-path>",
    "local Chromium executable; otherwise installed Playwright Chromium",
  )
  .action(async (name, opts) =>
    execute("target-add", async (s) =>
      mutex(s.root, async () => {
        getName(name);
        const c = await s.config();
        check(!c.targets[name], "target_already_exists");
        check(
          opts.sshHost ||
            !(
              opts.remoteRoot ||
              opts.remoteCli ||
              opts.remoteNode ||
              opts.remoteTarget
            ),
          "ssh_host_required",
        );
        check(!opts.sshHost || !opts.executable, "incompatible_target_options");
        const t = opts.sshHost
          ? sshSchema.parse({
              kind: "ssh",
              host: opts.sshHost,
              root: opts.remoteRoot,
              cli: opts.remoteCli,
              node: opts.remoteNode,
              target: opts.remoteTarget ?? name,
            })
          : localSchema.parse({ kind: "local", executable: opts.executable });
        c.targets[name] = t;
        await s.save(c);
        return { status: "registered", target: name, kind: t.kind };
      }),
    ),
  );
program
  .command("sync <source> <target>")
  .description(
    "Transfer latest source version; active sessions keep their loaded version",
  )
  .action(async (source, target) =>
    execute("sync-" + getName(source) + "-" + getName(target), async (s) => {
      const c = await s.config();
      getSource(c, source);
      const t = getTarget(c, target);
      const e = await s.current(s.p("sources", source));
      check(e, "source_state_missing");
      if (t.kind === "ssh") {
        const receipt = await remote(
          s,
          t,
          ["internal", "receive", t.target],
          JSON.stringify(e),
        );
        check(
          receipt.checksum === e.checksum,
          "remote_checksum_receipt_mismatch",
        );
        return {
          status: "synced",
          target,
          version: e.version,
          checksum: e.checksum,
          cookieCount: e.state.cookies.length,
          origins: e.state.origins.map((o) => o.origin),
        };
      }
      await mutex(s.p("targets", target), () =>
        s.activate(s.p("targets", target), e),
      );
      return {
        status: "synced",
        target,
        version: e.version,
        checksum: e.checksum,
        cookieCount: e.state.cookies.length,
        origins: e.state.origins.map((o) => o.origin),
        applies: "next_session",
      };
    }),
  );
const session = program
  .command("session")
  .description("Start with latest state or stop only a tool-owned browser");
session.command("start <target>").action(async (target) =>
  execute("session-start-" + getName(target), async (s) => {
    const t = getTarget(await s.config(), target);
    return t.kind === "ssh"
      ? remote(s, t, ["session", "start", t.target])
      : startLocal(s, target, t.executable);
  }),
);
session.command("stop <target>").action(async (target) =>
  execute("session-stop-" + getName(target), async (s) => {
    const t = getTarget(await s.config(), target);
    return t.kind === "ssh"
      ? remote(s, t, ["session", "stop", t.target])
      : stopLocal(s, target);
  }),
);
const sch = program
  .command("schedule")
  .description(
    "Explicit macOS launchd refresh scheduling; never enabled on install",
  );
sch
  .command("enable <source>")
  .option(
    "--minutes <integer>",
    "refresh interval minutes, default hourly",
    "60",
  )
  .action(async (name, opts) =>
    execute("schedule-enable-" + getName(name), async (s) => {
      getSource(await s.config(), name);
      return schedule(s, name, true, Number(opts.minutes));
    }),
  );
sch.command("disable <source>").action(async (name) =>
  execute("schedule-disable-" + getName(name), async (s) => {
    getSource(await s.config(), name);
    return schedule(s, name, false);
  }),
);
program
  .command("status")
  .description(
    "Report safe local state/session/schedule receipts, no SSH contact",
  )
  .action(async () =>
    execute("status", async (s) => {
      const c = await s.config();
      const sources = [],
        targets = [],
        receipts = [];
      for (const name of Object.keys(c.sources)) {
        try {
          const e = await s.current(s.p("sources", name));
          sources.push({
            name,
            version: e?.version,
            checksum: e?.checksum,
            cookieCount: e?.state.cookies.length,
            origins: e?.state.origins.map((o) => o.origin),
            status: e ? "ready" : "not_refreshed",
            operationLockPresent: await exists(
              s.p("sources", name, ".operation"),
            ),
          });
        } catch {
          sources.push({ name, status: "invalid_state" });
        }
      }
      for (const [name, t] of Object.entries(c.targets)) {
        try {
          const e =
            t.kind === "local"
              ? await s.current(s.p("targets", name))
              : undefined;
          targets.push({
            name,
            kind: t.kind,
            operationLockPresent: await exists(
              s.p("targets", name, ".operation"),
            ),
            version: e?.version,
            checksum: e?.checksum,
            session:
              t.kind === "local"
                ? await sessionStatus(s, name)
                : { status: "remote_not_queried" },
          });
        } catch {
          targets.push({ name, status: "invalid_state" });
        }
      }
      for (const f of await fs.readdir(s.p("receipts"))) {
        if (f !== "status.json" && f.endsWith(".json"))
          receipts.push(await json(s.p("receipts", f)));
      }
      return {
        sources,
        targets,
        schedules: await scheduleStatus(s),
        receipts,
        temporaryDirectories: await fs.readdir(s.p("tmp")),
      };
    }),
  );
program
  .command("internal", { hidden: true })
  .description("Same-version SSH receiver protocol")
  .command("receive <target>")
  .action(async (target) =>
    execute("receive-" + getName(target), async (s) => {
      const t = getTarget(await s.config(), target);
      check(t.kind === "local", "receive_requires_local_target");
      let input = "";
      for await (const chunk of process.stdin) {
        input += chunk;
        check(
          Buffer.byteLength(input) <= 64 * 1024 * 1024,
          "transfer_size_limit",
        );
      }
      const e = validateEnvelope(JSON.parse(input));
      await mutex(s.p("targets", target), () =>
        s.activate(s.p("targets", target), e),
      );
      return {
        status: "received",
        target,
        version: e.version,
        checksum: e.checksum,
        cookieCount: e.state.cookies.length,
        origins: e.state.origins.map((o) => o.origin),
      };
    }),
  );
try {
  await program.parseAsync();
} catch (e) {
  const code =
    e instanceof Fault
      ? e.code
      : e instanceof z.ZodError
        ? "validation_failed"
        : e instanceof SyntaxError
          ? "invalid_json"
          : "command_failed";
  const result = {
    status: "failed",
    code,
    failedCollections: e instanceof Fault && e.collection ? [e.collection] : [],
    warnings: [],
  };
  if (activeStore) {
    const r = await activeStore
      .receipt(activeCommand, result)
      .catch(() => ({ schema: 1, command: activeCommand, ...result }));
    console.error(JSON.stringify(r, null, 2));
  } else console.error(JSON.stringify(result));
  process.exitCode = 1;
}
