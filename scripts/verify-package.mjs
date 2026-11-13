// Local package installation and bin resolution, with no browser or remote contact.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
await fs.rm("evidence/static.json", { force: true });
const folder = await fs.mkdtemp(
  path.join(await fs.realpath(os.tmpdir()), "pp-package-"),
);
try {
  const packed = JSON.parse(
    execFileSync("npm", ["pack", "--json", "--pack-destination", folder], {
      encoding: "utf8",
    }),
  );
  const artifact = path.join(folder, packed[0].filename);
  execFileSync(
    "npm",
    [
      "install",
      "--prefix",
      path.join(folder, "installed"),
      "--ignore-scripts",
      "--registry=https://registry.npmjs.org",
      "--no-audit",
      "--no-fund",
      artifact,
    ],
    { stdio: "pipe" },
  );
  const bin = path.join(
    folder,
    "installed/node_modules/.bin/playwright-profile",
  );
  assert.equal(
    execFileSync(bin, ["--version"], { encoding: "utf8" }).trim(),
    "0.1.0",
  );
  const root = path.join(folder, "private");
  const status = JSON.parse(
    execFileSync(bin, ["--data-root", root, "status"], { encoding: "utf8" }),
  );
  assert.equal(status.status, "ok");
  assert(
    !packed[0].files.some(
      (f) =>
        f.path.startsWith("node_modules/") ||
        f.path.includes(".verification-venv") ||
        f.path.includes("state.json"),
    ),
  );
  const report = {
    schema: 1,
    kind: "local-package-install",
    status: "passed",
    checks: [
      "npm pack allowlist contains no credential files",
      "Installed package bin --version returns the expected version",
      "Installed package status with isolated private root",
    ],
    limits: [
      "No package publishing",
      "No global installation",
      "No browser launched",
    ],
  };
  await fs.writeFile(
    "evidence/static.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await fs.rm(folder, { recursive: true, force: true });
}
