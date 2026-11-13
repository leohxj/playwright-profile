# Delivery report

Project: `playwright-profile`.

The implementation provides `profiles list`, `source add`, `refresh`, `target add`, `sync`, `session start`, `session stop`, `schedule enable`, `schedule disable`, and `status`. The built executable is `dist/cli.js`; `package.json` exposes the `playwright-profile` bin. The packaged skill is `skills/playwright-profile/SKILL.md`. Project-local dependencies are locked in `package-lock.json`.

The implementation reads source profiles only, freezes SQLite DB/WAL/journal files into private staging, uses SQLite ONLINE BACKUP, verifies cookie identities through a matching headless browser, and activates validated immutable states atomically. It supports boundary-domain cookie filters and explicit origin storage capture. Target sessions use clean persistent profiles and conservative ownership locks. SSH uses a same-version installed-CLI receive/start/stop contract with explicit host/root paths. launchd is opt-in and was not enabled.

Validation passed:

| Evidence | Result | Meaning |
| :--- | :--- | :--- |
| `npm run typecheck` | 1 command passed | Strict TypeScript static check, run separately from package verification |
| `npm run build` | 1 command passed | TypeScript compilation and executable output |
| `npm run verify` | 28 checks passed | Isolated protocol and injected failures, including local SSH simulation |
| `npm run verify:upstream` | 11 checks passed | Actual original playwright-cli 0.1.24 and disposable macOS Chrome Beta profiles |
| `npm run verify:package` | 3 recorded checks passed | Package file allowlist, installed bin version and isolated status |
| skill-creator `quick_validate.py` | 1 command passed | Packaged skill format, run separately from package verification |

Reports: `evidence/protocol.json`, `evidence/upstream.json`, `evidence/static.json`. The legacy `static.json` filename now records package verification only; it does not claim TypeScript or skill validation. They contain no credential values or personal profile data. Verification scripts remove their temporary data and close their own browser sessions. No unit test suite was added. No live-site browser E2E was run.

The upstream integration verified synthetic persistent, session and empty-value cookies, synthetic IndexedDB records, source byte hashes, failed encrypted-cookie capture retaining the previous version, cross-cwd session invocation, concurrent start rejection, next-session version loading, removed-origin cleanup and owned-session stop. Source launch omits upstream mock-keychain/basic-password-store flags using the supported config interface. It retains session cookies while excluding old tab files and resetting only cloned startup preferences.

Genuine limits: no personal credential acceptance, real SSH host acceptance, Linux-machine acceptance, live origin navigation/login acceptance, or launchd execution acceptance. A running source is a best-effort snapshot without a cross-store transaction. Silently empty first-time origin storage has no independent source oracle. Decryption parity detects missing identities and loss of known nonempty plaintext. Ciphertext length cannot establish plaintext nonemptiness, so a retained encrypted identity with a silently wrong or empty value has no independent plaintext oracle. Abrupt process or machine termination can leave private data and locks requiring operator inspection.

At the implementation handoff, local git was initialized on `main` without a commit. Publication preparation subsequently created the initial local commit after the audit in `docs/security-audit.md`. Preparation did not push, change remotes, publish, deploy, install global packages, deploy a global skill or enable a real schedule. Development-only PyYAML was installed into the ignored project-local `.verification-venv` for the supplied skill validator.

Review corrections: package receipts now list only the three checks executed by the package script. TypeScript checking, compilation and skill validation have separate delivery counts. Cookie expiry is rejected before activation when outside the upstream range. Empty encrypted cookies are accepted when captured with their identity. Workspace preparation failures remove the newly created lock before any browser launch. Existing protocol validation covers each correction without a new unit test suite.
