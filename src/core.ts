import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { z } from "zod";

export class Fault extends Error {
  constructor(
    public code: string,
    public collection?: string,
  ) {
    super(code);
  }
}
export function check(ok: unknown, code: string): asserts ok {
  if (!ok) throw new Fault(code);
}
export const nameSchema = z.string().regex(/^[a-z][a-z0-9-]{0,47}$/);
export const abs = z
  .string()
  .refine(
    (p) => path.isAbsolute(p) && !p.includes("\0"),
    "absolute path required",
  );
const origin = z.string().refine((s) => {
  try {
    const u = new URL(s);
    return (
      ["http:", "https:"].includes(u.protocol) &&
      u.origin === s &&
      !u.username &&
      !u.password
    );
  } catch {
    return false;
  }
});
export const domain = z
  .string()
  .regex(
    /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/,
  )
  .max(253);
export const sourceSchema = z.strictObject({
  browser: z.enum(["chrome", "chrome-beta"]),
  profile: z.string().regex(/^(Default|Profile [0-9]+)$/),
  userData: abs,
  app: abs,
  domains: z.array(domain).max(200),
  origins: z.array(origin).max(100),
});
export const localSchema = z.strictObject({
  kind: z.literal("local"),
  executable: abs.optional(),
});
export const sshSchema = z.strictObject({
  kind: z.literal("ssh"),
  host: z.string().regex(/^(?:[a-zA-Z0-9_.-]+@)?[a-zA-Z0-9][a-zA-Z0-9_.-]*$/),
  root: abs,
  cli: abs,
  node: abs,
  target: nameSchema,
});
export const configSchema = z.strictObject({
  schema: z.literal(1),
  sources: z.record(nameSchema, sourceSchema),
  targets: z.record(nameSchema, z.union([localSchema, sshSchema])),
});
export type Config = z.infer<typeof configSchema>;
export type Source = z.infer<typeof sourceSchema>;
export type Target = z.infer<typeof localSchema> | z.infer<typeof sshSchema>;
const indexSchema = z.strictObject({
  name: z.string(),
  keyPath: z.string().optional(),
  keyPathArray: z.array(z.string()).optional(),
  unique: z.boolean(),
  multiEntry: z.boolean(),
});
const recordSchema = z
  .strictObject({
    key: z.json().optional(),
    keyEncoded: z.json().optional(),
    value: z.json().optional(),
    valueEncoded: z.json().optional(),
  })
  .refine((r) => "value" in r !== "valueEncoded" in r)
  .refine((r) => !("key" in r && "keyEncoded" in r));
const dbSchema = z.strictObject({
  name: z.string(),
  version: z.number().int().positive(),
  stores: z.array(
    z.strictObject({
      name: z.string(),
      autoIncrement: z.boolean(),
      keyPath: z.string().optional(),
      keyPathArray: z.array(z.string()).optional(),
      records: z.array(recordSchema),
      indexes: z.array(indexSchema),
    }),
  ),
});
export const stateSchema = z.strictObject({
  cookies: z
    .array(
      z.strictObject({
        name: z.string(),
        value: z.string(),
        domain: z.string().min(1),
        path: z.string().startsWith("/"),
        expires: z
          .number()
          .finite()
          .refine(
            (value) => value === -1 || (value >= 0 && value <= 253402300799),
          ),
        httpOnly: z.boolean(),
        secure: z.boolean(),
        sameSite: z.enum(["Strict", "Lax", "None"]),
        partitionKey: z.string().optional(),
        _crHasCrossSiteAncestor: z.boolean().optional(),
      }),
    )
    .max(100000),
  origins: z
    .array(
      z.strictObject({
        origin,
        localStorage: z.array(
          z.strictObject({ name: z.string(), value: z.string() }),
        ),
        indexedDB: z.array(dbSchema).optional(),
      }),
    )
    .max(100),
});
export type State = z.infer<typeof stateSchema>;
export const envelopeSchema = z.strictObject({
  schema: z.literal(1),
  version: z.string().regex(/^[0-9]{13}-[a-f0-9-]{36}$/),
  createdAt: z.string().datetime(),
  source: nameSchema,
  checksum: z.string().regex(/^[a-f0-9]{64}$/),
  state: stateSchema,
  warnings: z.array(z.string().max(300)).max(50),
});
export type Envelope = z.infer<typeof envelopeSchema>;
export const digest = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
export function validateState(value: unknown): State {
  const s = stateSchema.parse(value);
  check(
    new Set(s.origins.map((o) => o.origin)).size === s.origins.length,
    "duplicate_origins",
  );
  const keys = s.cookies.map((c) =>
    JSON.stringify([c.domain, c.path, c.name, c.partitionKey ?? ""]),
  );
  check(new Set(keys).size === keys.length, "duplicate_cookies");
  for (const o of s.origins) {
    check(
      new Set(o.localStorage.map((x) => x.name)).size === o.localStorage.length,
      "duplicate_localstorage_key",
    );
    check(
      new Set((o.indexedDB ?? []).map((x) => x.name)).size ===
        (o.indexedDB ?? []).length,
      "duplicate_indexeddb_database",
    );
    for (const db of o.indexedDB ?? []) {
      check(
        new Set(db.stores.map((x) => x.name)).size === db.stores.length,
        "duplicate_indexeddb_store",
      );
      for (const st of db.stores) {
        check(
          !(st.keyPath !== undefined && st.keyPathArray !== undefined),
          "invalid_indexeddb_keypath",
        );
        check(
          new Set(st.indexes.map((x) => x.name)).size === st.indexes.length,
          "duplicate_indexeddb_index",
        );
      }
    }
  }
  return s;
}
export function validateEnvelope(v: unknown): Envelope {
  const e = envelopeSchema.parse(v);
  validateState(e.state);
  check(digest(e.state) === e.checksum, "checksum_mismatch");
  return e;
}
export const matchesDomain = (host: string, filters: string[]) =>
  !filters.length ||
  filters.some(
    (d) =>
      host.replace(/^\./, "").toLowerCase() === d ||
      host
        .replace(/^\./, "")
        .toLowerCase()
        .endsWith("." + d),
  );
export const uid = () => `${Date.now()}-${randomUUID()}`;
export const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
export async function exists(p: string) {
  try {
    await fs.lstat(p);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}
export async function noLinks(p: string) {
  check(path.isAbsolute(p), "unsafe_path");
  let current = path.parse(p).root;
  for (const part of p.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (await exists(current))
      check(!(await fs.lstat(current)).isSymbolicLink(), "symlink_rejected");
  }
}
export async function dir(p: string) {
  await noLinks(p);
  await fs.mkdir(p, { recursive: true, mode: 0o700 });
  await fs.chmod(p, 0o700);
}
export async function privateFile(p: string, data: string | Buffer) {
  await noLinks(p);
  await fs.writeFile(p, data, { mode: 0o600, flag: "wx" });
}
export async function atomic(p: string, data: string) {
  await noLinks(p);
  await dir(path.dirname(p));
  const t = p + ".tmp-" + randomUUID();
  try {
    await privateFile(t, data);
    const h = await fs.open(t, "r");
    await h.sync();
    await h.close();
    await fs.rename(t, p);
  } finally {
    await fs.rm(t, { force: true });
  }
}
export async function json(p: string) {
  await noLinks(p);
  const st = await fs.stat(p);
  check(st.isFile() && st.size <= 64 * 1024 * 1024, "file_size_invalid");
  return JSON.parse(await fs.readFile(p, "utf8")) as unknown;
}
export async function secureTree(p: string): Promise<void> {
  await noLinks(p);
  const st = await fs.lstat(p);
  check(st.isFile() || st.isDirectory(), "special_file_rejected");
  await fs.chmod(p, st.isDirectory() ? 0o700 : 0o600);
  if (st.isDirectory())
    for (const n of await fs.readdir(p)) await secureTree(path.join(p, n));
}
export let interrupted = false;
const children = new Set<ReturnType<typeof spawn>>();
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    interrupted = true;
    for (const child of children) child.kill("SIGTERM");
  });
export async function exec(
  bin: string,
  args: string[],
  opts: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    input?: string;
    timeout?: number;
  } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const c = spawn(bin, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.add(c);
    let out = "",
      err = "",
      done = false;
    const timer = setTimeout(() => {
      c.kill("SIGTERM");
      setTimeout(() => c.kill("SIGKILL"), 5000).unref();
    }, opts.timeout ?? 120000);
    c.stdout.on("data", (d) => {
      out += d;
      if (out.length > 70 * 1024 * 1024) c.kill("SIGTERM");
    });
    c.stderr.on("data", (d) => {
      err += d;
      if (err.length > 1000000) err = err.slice(-1000000);
    });
    c.on("error", () => {
      clearTimeout(timer);
      if (!done) {
        done = true;
        reject(new Fault("executable_unavailable"));
      }
    });
    c.on("close", (code) => {
      children.delete(c);
      clearTimeout(timer);
      if (done) return;
      done = true;
      if (code === 0) resolve(out);
      else
        reject(
          new Fault(
            /decrypt|keychain|OSCrypt/i.test(err + out)
              ? "decryption_failed"
              : "external_command_failed",
          ),
        );
    });
    c.stdin.on("error", () => {});
    c.stdin.end(opts.input);
  });
}
export class Store {
  root: string;
  constructor(
    root = process.env.PLAYWRIGHT_PROFILE_DATA_ROOT ??
      path.join(os.homedir(), ".local/share/playwright-profile"),
  ) {
    abs.parse(root);
    this.root = path.resolve(root);
  }
  async init() {
    await noLinks(this.root);
    check(this.root !== path.parse(this.root).root, "unsafe_data_root");
    let ancestor = this.root;
    while (true) {
      check(
        !(await exists(path.join(ancestor, "Local State"))),
        "data_root_inside_browser_profile",
      );
      const parent = path.dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
    }
    const marker = this.p(".playwright-profile-owner.json");
    if ((await exists(this.root)) && !(await exists(marker)))
      check((await fs.readdir(this.root)).length === 0, "data_root_not_owned");
    if (await exists(marker))
      z.strictObject({
        schema: z.literal(1),
        product: z.literal("playwright-profile"),
      }).parse(await json(marker));
    await dir(this.root);
    if (!(await exists(marker)))
      await privateFile(
        marker,
        JSON.stringify({ schema: 1, product: "playwright-profile" }),
      );
    for (const d of [
      "sources",
      "targets",
      "tmp",
      "receipts",
      "daemon",
      "upstream-global",
    ])
      await dir(this.p(d));
    // This is the pinned upstream's isolated global root, never the user's global config.
    check(
      !(await exists(
        this.p("upstream-global", ".playwright", "cli.config.json"),
      )),
      "isolated_global_config_not_empty",
    );
  }
  p(...parts: string[]) {
    return path.join(this.root, ...parts);
  }
  async config(): Promise<Config> {
    return (await exists(this.p("config.json")))
      ? configSchema.parse(await json(this.p("config.json")))
      : { schema: 1, sources: {}, targets: {} };
  }
  async save(c: Config) {
    await atomic(
      this.p("config.json"),
      JSON.stringify(configSchema.parse(c), null, 2),
    );
  }
  async receipt(command: string, result: Record<string, unknown>) {
    const r = {
      schema: 1,
      cliVersion: "0.1.0",
      time: new Date().toISOString(),
      command,
      ...result,
    };
    await atomic(
      this.p("receipts", command.replace(/[^a-z0-9-]/g, "-") + ".json"),
      JSON.stringify(r, null, 2),
    );
    return r;
  }
  async current(base: string): Promise<Envelope | undefined> {
    const cp = path.join(base, "current.json");
    if (!(await exists(cp))) return;
    const c = z
      .strictObject({ version: z.string().regex(/^[0-9]{13}-[a-f0-9-]{36}$/) })
      .parse(await json(cp));
    const versionDir = path.join(base, "versions", c.version);
    const envelope = validateEnvelope(
      await json(path.join(versionDir, "envelope.json")),
    );
    check(envelope.version === c.version, "version_pointer_mismatch");
    check(
      digest(validateState(await json(path.join(versionDir, "state.json")))) ===
        envelope.checksum,
      "state_file_checksum_mismatch",
    );
    return envelope;
  }
  async activate(base: string, e: Envelope) {
    check(!interrupted, "interrupted");
    validateEnvelope(e);
    await dir(base);
    const previous = await this.current(base);
    if (previous && previous.state.cookies.length && !e.state.cookies.length)
      throw new Fault("suspicious_empty_replacement");
    if (previous)
      for (const o of previous.state.origins) {
        const n = e.state.origins.find((x) => x.origin === o.origin);
        if (
          n &&
          ((o.localStorage.length && !n.localStorage.length) ||
            (o.indexedDB?.length && !n.indexedDB?.length))
        )
          throw new Fault("suspicious_empty_origin");
      }
    const versions = path.join(base, "versions");
    await dir(versions);
    const dest = path.join(versions, e.version);
    if (await exists(dest)) {
      check(
        (await this.currentEnvelope(dest)).checksum === e.checksum,
        "version_collision",
      );
    } else {
      const tmp = path.join(versions, ".staging-" + randomUUID());
      await dir(tmp);
      try {
        await privateFile(path.join(tmp, "envelope.json"), JSON.stringify(e));
        await privateFile(
          path.join(tmp, "state.json"),
          JSON.stringify(e.state),
        );
        await fs.rename(tmp, dest);
      } finally {
        await fs.rm(tmp, { recursive: true, force: true });
      }
    }
    check(!interrupted, "interrupted");
    await atomic(
      path.join(base, "current.json"),
      JSON.stringify({ version: e.version }),
    );
  }
  async currentEnvelope(p: string) {
    const envelope = validateEnvelope(
      await json(path.join(p, "envelope.json")),
    );
    check(
      digest(validateState(await json(path.join(p, "state.json")))) ===
        envelope.checksum,
      "state_file_checksum_mismatch",
    );
    check(path.basename(p) === envelope.version, "version_directory_mismatch");
    return envelope;
  }
}
export async function mutex<T>(base: string, fn: () => Promise<T>): Promise<T> {
  await dir(base);
  const p = path.join(base, ".operation");
  try {
    await fs.mkdir(p, { mode: 0o700 });
  } catch {
    throw new Fault("operation_occupied");
  }
  try {
    await privateFile(
      path.join(p, "owner.json"),
      JSON.stringify({ pid: process.pid, time: new Date().toISOString() }),
    );
    return await fn();
  } finally {
    await fs.rm(p, { recursive: true, force: true });
  }
}
