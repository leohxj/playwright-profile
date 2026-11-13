# playwright-profile

[English](README.md) | [简体中文](README.zh-CN.md)

An independent TypeScript CLI for versioned browser storage snapshots. It uses the **unmodified, locally pinned `@playwright/cli` 0.1.24** for every browser operation, including `run-code`. It never attaches to your daily browser, changes its files, or asks it to close.

A source is a macOS Chrome or Chrome Beta profile. A target is an independent headless Chromium profile on macOS or Linux, or an explicitly configured SSH endpoint running this same CLI. A refresh exports a new source version. A sync activates that version on a target. A session loads the latest target version before returning control to the agent.

## Install locally

Requirements: Node 22+, npm, Python 3 with standard-library SQLite, and `ps`. Source export additionally requires macOS and the matching Google Chrome or Google Chrome Beta application. SSH targets require OpenSSH. Target-only Linux installations do not need macOS or Python unless cloning sources.

```sh
npm ci
npm run build
node dist/cli.js --help
# Optional target runtime when no suitable local Chromium executable exists:
npx --no-install playwright install chromium
```

There is no global install, postinstall action, skill deployment, schedule activation, or automatic credential export. Browser installation downloads into Playwright's normal browser cache only when you explicitly run that optional command. Alternatively supply `target add --executable`.

Use `node /absolute/path/playwright-profile/dist/cli.js` as `playwright-profile` in the examples. The package also exposes the `playwright-profile` bin when installed by your chosen package manager. `npm pack` includes compiled code, the SQLite helper and the skill. Build before packing. Do not publish a package containing your private data root.

## Commands

Names match `[a-z][a-z0-9-]{0,47}`. Each command supports `--help`. Put the global `--data-root` option before the command. The root defaults to `~/.local/share/playwright-profile`, or `PLAYWRIGHT_PROFILE_DATA_ROOT`. Use an absolute, non-symlink path. On macOS, `/tmp` and `/var` are symlink aliases: use their real paths when supplying a private verification root.

```sh
playwright-profile profiles list
playwright-profile profiles list --browser chrome-beta
playwright-profile profiles list --browser chrome-beta --user-data-dir /private/path/empty-profile --app '/Applications/Google Chrome Beta.app'

playwright-profile source add work --browser chrome-beta --profile 'Profile 1'
# Cookie filter is optional. Without it, ALL cookies are exported.
playwright-profile source add limited --browser chrome --profile Default \
  --domain example.com login.example.net \
  --origin https://app.example.com https://login.example.net

playwright-profile refresh work
playwright-profile target add local
# Explicit executable is optional; otherwise upstream uses its installed Chromium.
playwright-profile target add custom --executable '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta'
playwright-profile sync work local
playwright-profile session start local
playwright-profile session stop local
playwright-profile status

# Only these explicit commands modify launchd. Do not run just to inspect.
playwright-profile schedule enable work          # default hourly
playwright-profile schedule enable limited --minutes 120
playwright-profile schedule disable work
```

`source add` only registers metadata and reads profile names. It does not export credentials. Profiles bind to browser and directory, not the display name. Duplicate display names are supported. `--user-data-dir` and `--app` are explicit source overrides for nonstandard installations or disposable verification. `--app` must identify the correct bundle ID. When using a custom source root, the operator must choose the channel that created it; Chrome profile files do not reliably encode their distribution channel. A known default source root belonging to the other channel is rejected.

`--domain example.com` matches `example.com` and its subdomains. It does not match `evilexample.com` or `example.com.evil`. Do not include a scheme or leading dot. No SSO domains are added automatically. The private clone retains session cookies while discarding old tab/session files and clearing startup URLs, so daily tabs are not restored. Domains affect cookies only. Only explicit `--origin` entries export localStorage and IndexedDB. Origins must be exact HTTP(S) origins with no path, credentials, query or trailing slash. A failed request, HTTP error, redirect outside the origin, storage error or capture failure rejects the refresh. Navigation requests to a different origin are blocked during capture. Resource requests may still use other origins. Capture may execute site scripts and make normal site requests, so select origins deliberately. Without explicit origins no site is navigated.

Session storage, passwords, certificates, OPFS, service workers and other browser-specific stores are not exported. Cookie encryption stays in the copied browser databases until the matching browser exports plaintext storage state into the private root. Source clones omit upstream mock-keychain and basic-password-store launch flags through the supported config option. The matching app may need normal macOS Keychain authorization. Refusal fails closed. The state files are credentials. Keep the entire root private and out of source control.

## Session ownership and agent invocation

`session start` returns the random upstream session name, immutable version, checksum, private `cwd`, and exact original CLI examples. Copy the full example, including `cd` and environment assignments. Running only `playwright-cli -s=...` from an arbitrary directory may use another workspace and cannot reliably address this session. Do not use `open`, `attach`, `delete-data`, `close-all`, or `kill-all` on a managed session. Use this CLI's `session stop`.

The data root must be empty on first use. A private ownership marker prevents initialization from changing a nonempty unrelated directory. A root inside a browser user-data tree is rejected.

A target has one session lock. Every start creates a clean persistent profile under that lock and loads state with `page.context().setStorageState(path)` through `run-code`. This avoids old localStorage or IndexedDB surviving a scope reduction. The profile persists across agent commands within that session. Stopping deletes that session profile; task-written changes are not saved back to the immutable snapshot. Refresh and sync while it is running affect only the next session.

Concurrent starts fail. Unknown locks also fail. A crashed browser leaves a stale lock that requires explicit `session stop`. Stop calls only the tool-owned named session in its private workspace. It removes the lock only after `ps` confirms that no browser or CLI daemon uses its profile. If `ps` is unavailable, ownership metadata is corrupt, or a browser still runs, the lock stays. A stale `.operation` directory from SIGKILL must be inspected by the operator before manual removal. Never remove a lock to bypass a running browser.

## SSH contract

SSH is opt-in and has no default host. Install **this same CLI version and dependencies** on the remote machine. Provide absolute Node, CLI and private root paths. Explicitly register a **local** target there first. No command installs code or browsers remotely.

```sh
# Run on remote machine through your own authorized connection:
/absolute/node /absolute/playwright-profile/dist/cli.js \
  --data-root /absolute/private-root target add remote-browser

# Local registration and use:
playwright-profile target add server \
  --ssh-host user@explicit-host \
  --remote-root /absolute/private-root \
  --remote-node /absolute/node \
  --remote-cli /absolute/playwright-profile/dist/cli.js \
  --remote-target remote-browser
playwright-profile sync work server
playwright-profile session start server
playwright-profile session stop server
```

The SSH command is individually shell-quoted and uses BatchMode and a connection timeout. Authentication and host-key verification remain OpenSSH's responsibility. Transfer sends one envelope over stdin to `internal receive <target>`. The receiver validates JSON, size, schema, state and SHA-256 before staging credential files. It then renames the immutable version directory and atomically replaces `current.json`. A failed upload or checksum leaves the old pointer. A lost response can mean that activation succeeded remotely: inspect remote status before retrying. `status` on the local machine deliberately does not contact SSH. Remote `session start` receipts contain remote invocation examples; execute them on that host.

## State, config and receipts

```
private-root/
  config.json
  sources/<name>/versions/<timestamp-uuid>/{envelope.json,state.json}
  sources/<name>/current.json
  targets/<name>/versions/<timestamp-uuid>/{envelope.json,state.json}
  targets/<name>/current.json
  targets/<name>/session-lock/{owner.json,profile/,workspace/}
  receipts/<operation>.json
  daemon/                   # isolated upstream registry and error files
  upstream-global/          # isolated empty upstream global config root
  schedules/                # created only by schedule commands
  tmp/                      # source clone and export workspaces
```

Directories use 0700 and credential files use 0600. Credential versions are immutable and retained; there is no automatic deletion policy. Config is strict schema 1 JSON with `sources` and `targets` dictionaries. Source fields: `browser`, `profile`, `userData`, `app`, `domains`, `origins`. Local target fields: `kind: "local"`, optional `executable`. SSH fields: `kind: "ssh"`, `host`, `root`, `node`, `cli`, `target`. Unknown fields, invalid names and unsafe paths fail. Registration refuses to overwrite an existing name. To change scope, stop dependent sessions and edit your private config deliberately, then refresh and sync. The next start is always clean.

Commands emit JSON receipts. Successful receipts contain the status plus applicable `version`, `checksum`, `cookieCount`, `origins`, `failedCollections`, and `warnings`. Failures have nonzero exit status and a safe error code on stderr. Validation errors never dump input values. `status` reports local source versions, local target ownership, operation locks, retained temporary directories, schedule state and latest operation receipts. It has no cookie, localStorage or IndexedDB values. Launchd output uses the same safe receipt format.

## Verification

```sh
npm run typecheck
npm run verify
npm run verify:upstream
npm run verify:package
python3 /path/to/skill-creator/scripts/quick_validate.py skills/playwright-profile
```

`verify` is replayable isolated directory protocol validation with synthetic SQLite stores and a **local fake SSH executable**. It does not launch browsers or contact SSH servers. It covers filtering, malformed state, old-version retention, SQLite corruption, active WAL and unchanged source hashes, duplicate display names on macOS, browser mismatch on macOS, lock occupancy, receive receipts, interruption and checksum failures.

`verify:upstream` uses the actual pinned upstream CLI with **empty disposable Chrome Beta profiles on macOS**, or an installed Chromium on Linux. It uses `about:blank` and synthetic storage only. No real site, login or personal profile is used. It verifies file-based `run-code` capture, isolated environment, cross-cwd addressing, disposable source clone export with a synthetic cookie on macOS, synthetic encrypted-cookie rejection on macOS, independent target loading, concurrent occupancy, restart, scope shrink and cleanup. This is runtime integration evidence, not business E2E acceptance.

The scripts delete their temporary data and write secret-free reports to `evidence/protocol.json` and `evidence/upstream.json`. They contain check names and outcomes, not profile paths or state values. Both scripts must pass before claiming their respective evidence. No actual SSH, personal decryption, real login, or enabled launchd schedule is claimed. No unit test suite was added.

See [architecture](docs/architecture.md), [failure modes](docs/failure-modes.md), and the packaged [agent skill](skills/playwright-profile/SKILL.md).
