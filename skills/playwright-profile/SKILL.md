---
name: playwright-profile
description: Register macOS Chrome or Chrome Beta sources, refresh private versioned browser storage, sync local or explicit SSH targets, and start or stop isolated headless sessions through the playwright-profile CLI. Use for profile snapshots and managed session ownership, not daily browser attachment or browser task navigation.
---

# Playwright Profile

Use the installed `playwright-profile` command, or `node /absolute/project/dist/cli.js`. Read `--help` and the project's README when the install path or flags are unknown. Dependencies are project-local. This skill does not authorize deployment, package installation, credential export, site navigation or SSH contacts beyond the user's requested scope.

## Workflow

1. Discover with `profiles list`. Bind a source by `--browser` and `--profile` directory. Display names can repeat.
2. Register with `source add <name>`. This reads metadata only. Without `--domain`, a refresh exports every cookie. Do not assume a previous request authorized all-cookie export. Additional storage requires exact explicit `--origin` entries. Do not invent SSO domains.
3. Run `refresh <source>` only within authorized credential scope. It clones into a private directory and calls the original pinned playwright-cli. Never attach to, open directly, write, or close a user's daily profile.
4. Register a local target with `target add <name>`, or use explicit SSH host, root, Node and same-version CLI paths. Remote targets must already exist as local targets in the remote CLI configuration.
5. Run `sync <source> <target>`, then `session start <target>` before the agent task. Sync during a running session applies at its next start.
6. Use the returned original playwright-cli invocation with its exact private cwd and environment. Keep the returned session name. Do not assume `-s` alone works across cwd. Perform browser work using the user's browser skill and authorized task scope.
7. Run `session stop <target>` after the task and inspect the receipt. It stops only the managed session. Do not use upstream `open`, `attach`, `close-all`, `kill-all` or `delete-data` to manage this session.

A session starts in a clean persistent profile and loads the latest immutable version. Its profile survives commands within the session. Stop discards task-written changes; this tool never saves them into the source version.

## Failure decisions

- Treat cookie decryption, missing-cookie identity, database corruption, origin capture and suspicious empty-state errors as failed refreshes. Inspect `status`. The previous version remains active. Do not accept empty replacement as success or bypass validation.
- Treat occupied, stale and unknown locks as occupied. Use explicit `session stop` to reconcile a stale owned session. Never delete a lock while a browser may be running. Unknown ownership or liveness requires operator inspection.
- A failed SSH response may follow successful remote activation. Inspect remote `status` before claiming its active checksum or retrying. Local `status` does not contact remote hosts.
- Preserve counts, origins, checksums, versions, warnings and failed collections as evidence. Never print or attach cookie values, localStorage, IndexedDB, raw storage files, browser logs or cloned profile data.
- A running source yields a best-effort snapshot. SQLite consistency is checked per copied database; cross-store consistency is not guaranteed. Silently empty origin storage has no independent source oracle. Do not claim login acceptance from a successful snapshot.
- Schedule enable is an explicit user action. Installation and this skill do not authorize enabling launchd or modifying global configuration.

Verification is `npm run typecheck`, `npm run verify`, and, when disposable local browser integration is authorized, `npm run verify:upstream`. Read `evidence/protocol.json` and `evidence/upstream.json` to distinguish local simulation from actual upstream evidence. These checks do not prove personal decryption, actual SSH, live-site login or launchd scheduling.
