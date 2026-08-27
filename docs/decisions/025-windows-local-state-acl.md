# ADR-025: Harden `~/.sii` on Windows — POSIX modes are a no-op there

## Status

Accepted — 2026-07-25. Closes finding **F-02** of the internal code review. Extends ADR-006
(secrets never land in plaintext) to the platform the project actually runs on.

## Context

`FileKeyValueStore` and `FileAuditSink` create `~/.sii` with `mode: 0o700` and write files with
`mode: 0o600`, and the code comment states "dir 0700 / files 0600" as a guarantee.

**On Windows that guarantee is false.** Node's `mode` argument maps only to the read-only
attribute; NTFS ACLs are inherited from the parent directory and the POSIX bits are otherwise
ignored. So `%USERPROFILE%\.sii\session.json` — a live SII cookie jar carrying the taxpayer's
full portal authority until SII expires it — is protected by nothing but default profile ACLs.

This is not hypothetical positioning:

- `docs/STACK.md` claims a macOS-only posture ("No Windows-specific bits"), yet the packages are
  published to public npm with a `sii` binary and the project is being developed and run on
  Windows 11.
- ADR-024 has since added a **second** artifact, `~/.sii/monitor.json`, so the directory now
  holds more than the jar.
- The same review found `prepack` used `rm -rf`, which also only breaks on Windows. The pattern
  is a codebase that assumes POSIX while shipping cross-platform.

## Decision

**Harden the directory explicitly on `win32`, best-effort, and stop asserting a guarantee the
platform does not honour.**

- On directory creation, when `process.platform === 'win32'`, apply a restrictive ACL:
  `icacls <dir> /inheritance:r /grant:r <user>:(OI)(CI)F` — break inheritance from the profile
  and grant full control to the current user only.
- **Best-effort, never throws, never blocks a write.** Same posture as the audit sink: local
  state is a convenience, and a user on a locked-down machine where `icacls` is unavailable must
  still be able to use the tool. A failure is silent by design.
- **Applied once per process**, on the first directory creation, not on every write — `icacls`
  spawns a process and the store is on the hot path of every task.
- The command is built by a **pure function** `hardenDirCommand(platform, dir, user)` returning
  `string[] | null`. That is what the tests cover: the pure builder is asserted (win32 emits the
  right argv, other platforms emit `null`, the path is passed as a single argv element so a
  space in the profile path cannot split it). The `spawn` wrapper is a thin, untested shim, the
  same treatment the Playwright adapter gets.
- **Argv array, never a shell string.** The directory is derived from `homedir()`, not user
  input, but building a shell string would make that a latent injection sink the moment someone
  parameterises the base dir. `spawnSync` with an argv array has no shell to inject into.
- **Correct the comments.** The `0o700`/`0o600` docstrings now say they are POSIX-only and name
  the Windows path explicitly, so no future reader inherits the false guarantee.

## Alternatives Considered

- **Do nothing, document the gap.** Rejected: the directory holds a live session jar, and the
  project's own SECURITY.md puts session storage in scope. Documenting a hole you can close is
  not a security posture.
- **Warn on stderr each run.** Rejected as the primary fix — a warning the user cannot act on is
  noise, and noise gets filtered. (A warning when `icacls` *fails* is defensible, but it would
  fire on every command; the audit log records the attempt instead.)
- **Move the session jar into the OS keyring via the declared `SecretStore` seam.** This is the
  better long-term answer and remains on the roadmap — it also unblocks unattended
  `consoleLogin` (ADR-024's deferred scheduling). Rejected *for now* because it is a much larger
  change (a Node keyring adapter, a migration path for existing jars, a new dependency needing
  its own ADR), and it should not gate a fix that is a dozen lines. The two are complementary:
  even with a keyring, `monitor.json` and `audit.jsonl` still live on disk and still want a
  restrictive ACL.
- **Refuse to run on Windows until the keyring lands.** Rejected — the tool works there; the
  honest move is to make its local state as safe as the platform allows.

## Consequences

- On Windows, `~/.sii` stops inheriting profile ACLs and is restricted to the current user.
- On macOS/Linux nothing changes: `hardenDirCommand` returns `null` and the existing POSIX modes
  continue to be the mechanism.
- The tool now spawns a process on first directory creation on Windows. Measured cost is a
  one-off; if it ever shows up, the guard can move to install time.
- **The gap is narrowed, not eliminated.** ACLs do not protect against an attacker already
  running as the same user, and they do nothing for backup/sync agents that read the profile.
  The keyring migration is still the real fix for the *jar specifically*; this ADR makes the
  directory as safe as the filesystem can.
- `docs/STACK.md`'s "no Windows-specific bits" claim is now formally untrue — updated in the
  same change, along with the CI note that Windows is not yet in the test matrix.
