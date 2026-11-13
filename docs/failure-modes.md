# Failure modes and required behavior

Written before implementation. All state is credential material. Receipts contain counts, origins, digests and error codes, never values.

| Phase | Failure | Required behavior |
| :--- | :--- | :--- |
| Discovery | Duplicate display names, missing app, mismatched channel, unsafe profile directory | Bind browser identity and directory, verify executable identity, reject unsafe paths |
| Copy | Missing Local State or Preferences or Cookies, unreadable file, symlink, special file, SQLite corruption, WAL race, disk full | Abort; source remains read only; no state activation |
| Copy | Browser is running, stores change at different times | ONLINE BACKUP each SQLite database; report best effort and cross-store inconsistency |
| Decryption | Keychain refusal, dropped cookie identity, known nonempty source plaintext becoming empty, browser wrong channel | Compare every unexpired source cookie identity to browser output; abort on missing identity, browser decryption errors or loss of known nonempty plaintext |
| Export | Browser launch or run-code fails, inaccessible origin, redirect to another origin, IndexedDB capture fails | Close only own session; retain previous version; record failed collection |
| Export | Unexpected empty replacement, malformed state, excessive input | Reject before activation; retain previous version |
| Export | Signal or process crash | Cleanup in finally on catchable signals; preserve lock if liveness uncertain; crash leftovers are visible and need explicit stop |
| Transfer | SSH interrupted, bad checksum, malformed envelope, unknown target, wrong root | Upload one stdin envelope to same installed CLI; validate and stage before atomic activation; retain prior state |
| Transfer | Remote validation or activation fails, response lost | Fail receipt; remote may have activated after response loss; status reconciles digest; no blind retry guarantee |
| Load | Session occupied, stale lock, unknown liveness, persistent profile in use | Reject start; explicit stop recovers only after no matching browser or launcher process remains |
| Load | Invalid checksum/schema, state load error, browser dies during load | Retain previous valid version; close own session; keep lock when process remains or liveness unknown |
| Load | Refresh while context running | Activate immutable version for next start only; never mutate running context |
| Schedule | launchd failure, missing executable, non-macOS | Fail safely; install never enables schedule; explicit disable affects only own label |

No guarantees: a live multi-store copy is not a transaction. A copied database that passes SQLite integrity checks may still omit concurrent writes. Cookie identity parity detects dropped encrypted records. Only a nonempty source plaintext value proves that the exported value must be nonempty. Ciphertext length cannot prove plaintext nonemptiness because legitimate empty cookies also have ciphertext. A retained encrypted identity with a silently empty value cannot be distinguished from a legitimate empty cookie without an independent plaintext oracle. Browser decryption errors still fail closed. All expired cookies are excluded from parity. Origin storage has no independent plaintext source oracle; browser read errors fail closed, but silently empty origin storage cannot be proven complete. Session storage, passwords and certificates are not exported. Empty disposable browser evidence does not prove personal credential decryption, site login, or remote SSH acceptance.
