import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { atomic, check, dir, exec, exists, json, Store } from "./core.js";
const xml = (s: string) =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
export async function schedule(
  store: Store,
  name: string,
  enable: boolean,
  minutes = 60,
) {
  check(process.platform === "darwin", "launchd_requires_macos");
  check(
    Number.isInteger(minutes) && minutes >= 1 && minutes <= 1440,
    "invalid_schedule_interval",
  );
  const uid = process.getuid!();
  const hash = (await import("./core.js")).digest(store.root).slice(0, 12);
  const label = `local.playwright-profile.${hash}.${name}`;
  const folder = store.p("schedules");
  await dir(folder);
  const plist = path.join(folder, name + ".plist");
  const meta = path.join(folder, name + ".json");
  if (!enable) {
    if (await exists(meta)) {
      const saved = (await json(meta)) as { label: string; status: string };
      check(saved.label === label, "schedule_ownership_mismatch");
      if (saved.status === "disabled") return { status: "disabled", label };
      await exec("/bin/launchctl", ["bootout", `gui/${uid}/${label}`]);
      await atomic(meta, JSON.stringify({ label, status: "disabled" }));
    }
    return { status: "disabled", label };
  }
  const python = (
    await exec("python3", ["-c", "import sys; print(sys.executable)"])
  ).trim();
  check(path.isAbsolute(python), "python_executable_unresolved");
  const cli = fileURLToPath(new URL("./cli.js", import.meta.url));
  const args = [
    process.execPath,
    cli,
    "--data-root",
    store.root,
    "refresh",
    name,
  ];
  const data = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${xml(label)}</string><key>ProgramArguments</key><array>${args.map((s) => `<string>${xml(s)}</string>`).join("")}</array><key>WorkingDirectory</key><string>${xml(store.root)}</string><key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(path.dirname(process.execPath) + ":" + path.dirname(python) + ":/usr/bin:/bin:/usr/sbin:/sbin")}</string><key>PLAYWRIGHT_PROFILE_DATA_ROOT</key><string>${xml(store.root)}</string></dict><key>StartInterval</key><integer>${minutes * 60}</integer><key>RunAtLoad</key><false/><key>StandardOutPath</key><string>${xml(path.join(folder, name + ".out"))}</string><key>StandardErrorPath</key><string>${xml(path.join(folder, name + ".err"))}</string></dict></plist>`;
  check(
    !(await exists(meta)) ||
      ((await json(meta)) as { status: string }).status === "disabled",
    "schedule_already_configured",
  );
  await atomic(plist, data);
  for (const suffix of ["out", "err"])
    await atomic(path.join(folder, name + "." + suffix), "");
  await atomic(
    meta,
    JSON.stringify({ label, status: "enabling", minutes, plist }),
  );
  try {
    await exec("/bin/launchctl", ["bootstrap", `gui/${uid}`, plist]);
  } catch (error) {
    await atomic(
      meta,
      JSON.stringify({
        label,
        status: "enable_failed_inspect_launchd",
        minutes,
        plist,
      }),
    );
    throw error;
  }
  await atomic(
    meta,
    JSON.stringify({ label, status: "enabled", minutes, plist }),
  );
  return { status: "enabled", label, minutes, plist };
}
export async function scheduleStatus(store: Store) {
  const folder = store.p("schedules");
  if (!(await exists(folder))) return [];
  const all = [];
  for (const n of await fs.readdir(folder)) {
    if (!n.endsWith(".json")) continue;
    const meta = (await json(path.join(folder, n))) as {
      label: string;
      status: string;
    };
    let loaded = false;
    let lastExitCode: number | undefined;
    if (process.platform === "darwin")
      try {
        const output = await exec("/bin/launchctl", [
          "print",
          `gui/${process.getuid!()}/${meta.label}`,
        ]);
        const match = output.match(/last exit code\s*=\s*(-?\d+)/);
        if (match) lastExitCode = Number(match[1]);
        loaded = true;
      } catch {
        /* State is reported separately from configured status. */
      }
    all.push({
      ...meta,
      loaded,
      lastExitCode,
      failure:
        lastExitCode !== undefined && lastExitCode !== 0
          ? "last_job_exit_failed"
          : meta.status === "enabled" && !loaded
            ? "configured_job_not_loaded"
            : undefined,
    });
  }
  return all;
}
