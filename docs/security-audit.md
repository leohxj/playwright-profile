# Initial publication security audit

Audit date: 2026-11-13. Scope: the initial local Git snapshot, not a browser-profile export or a general application penetration test.

## Result and inspected files

No real credentials were identified in the candidate files. Gitleaks found no leaks. Targeted review found no API keys, access tokens, private keys, literal passwords, npm tokens, credential-bearing URLs or actual browser-state dumps. This finding is limited to the inspected snapshot and the detection methods below; it cannot prove that every possible secret is absent.

The intended snapshot contains these 23 files, including this report:

```text
.gitignore
README.md
docs/architecture.md
docs/delivery.md
docs/failure-modes.md
docs/security-audit.md
evidence/protocol.json
evidence/static.json
evidence/upstream.json
package-lock.json
package.json
scripts/sqlite_snapshot.py
scripts/verify-package.mjs
scripts/verify-upstream.mjs
scripts/verify.mjs
skills/playwright-profile/SKILL.md
src/browser.ts
src/cli.ts
src/core.ts
src/remote.ts
src/schedule.ts
src/session.ts
tsconfig.json
```

## Tools and methods

- Gitleaks 8.30.1, the official Darwin arm64 release from [gitleaks/gitleaks](https://github.com/gitleaks/gitleaks/releases/tag/v8.30.1), downloaded into a private temporary directory without a global installation. The archive SHA-256 matched the release checksum: `b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5`.
- Scan command: `gitleaks dir <snapshot> --redact=100 --no-banner --ignore-gitleaks-allow --report-format=json --report-path=<private-report.json>`. The snapshot is an explicit copy of candidate files, then an export of the Git index. Scanner config environment overrides are unset; the built-in rules are used without a project allowlist. Candidate and staged scans returned zero findings.
- Targeted expressions checked token formats, secret assignments, PEM private-key markers, authorization/cookie headers, credential-bearing URLs, dotenv assignments and personal home paths. Matching browser-state code was reviewed to distinguish schemas and synthetic data from real dumps. The evidence JSON files contain check names, results and limits, not cookie/localStorage/IndexedDB records.
- All nine lockfile `resolved` URLs use `registry.npmjs.org`; none contains URL credentials. Browser verification data uses synthetic values under `example.invalid`. The `.invalid` hosts and documented example domains are examples, not personal credentials. No scanner finding was suppressed to classify them this way.
- The initial repository had no HEAD, refs, remotes or commit objects, so there was no existing Git history to inspect. The first commit is also scanned with `gitleaks git . --log-opts=--all --redact=100 --no-banner --ignore-gitleaks-allow`.
- The only discovered personal absolute home path was removed from `docs/delivery.md`. Generic installation placeholders and standard platform application paths remain.

## Exclusions and prevention

The only hidden project file outside Git metadata and the ignored trees was `.gitignore`. `node_modules/`, `dist/` and `.verification-venv/` were inventoried by filename/count/size but their contents were excluded from this source audit. Git metadata was checked only for history availability; global credentials, SSH private keys, gh authentication stores and personal browser profiles were not read.

The ignore rules now cover `.env*`, credential tool config, private-key filenames/extensions, browser auth/profile directories, storage-state exports, named Chromium stores, conventional private runtime roots, loose root `config.json`, runtime logs and Python bytecode. `git check-ignore --no-index` accepted all 46 representative sensitive paths. Source files, verification scripts, TypeScript config, the lockfile and all evidence JSON remain eligible for staging. No sensitive sample file was created.

An arbitrary custom `--data-root` name or a renamed secret may evade these filename rules. Keep every private root outside the repository, inspect the staged snapshot before upload, and repeat the content scan after changes. Ignore rules do not remove already tracked files and are not an access-control boundary.

## Verification and acceptance limits

This preparation reran `npm run typecheck`, `npm run verify` and `npm run verify:package`: TypeScript checking and compilation passed, all 28 isolated protocol checks passed, and all three package checks passed. These checks launch no browser and contact no SSH host. No new unit tests were added.

`evidence/upstream.json` records earlier local integration with disposable synthetic profiles; it was inspected but was not rerun during this audit. No personal-profile export, real-site E2E, real login, real SSH-host acceptance, Linux-machine acceptance or launchd execution was performed. This preparation creates only a local commit; repository creation and push belong to the separate publication step.
