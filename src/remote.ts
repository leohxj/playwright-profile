import { exec, quote, Store, Target, Fault } from "./core.js";
export async function remote(
  store: Store,
  target: Extract<Target, { kind: "ssh" }>,
  args: string[],
  input?: string,
) {
  const command = [target.node, target.cli, "--data-root", target.root, ...args]
    .map(quote)
    .join(" ");
  const output = await exec(
    "ssh",
    [
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=15",
      "--",
      target.host,
      command,
    ],
    { cwd: store.root, input, timeout: 180000 },
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Fault("remote_receipt_invalid");
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !("status" in parsed) ||
    parsed.status === "failed"
  )
    throw new Fault("remote_command_failed");
  const receipt = parsed as Record<string, unknown>;
  if (receipt.schema !== 1 || receipt.cliVersion !== "0.1.0")
    throw new Fault("remote_version_mismatch");
  return receipt;
}
