// Windows local-state hardening (ADR-025). POSIX `mode` bits are a NO-OP on Windows — Node maps
// `mode` only to the read-only attribute, and NTFS ACLs are inherited from the user profile. So
// `%USERPROFILE%\.sii` (live cookie jar + monitor baseline + audit log) is otherwise protected
// by nothing but default profile ACLs.
//
// The COMMAND BUILDER is pure and unit-tested; the spawn wrapper is a thin shim (the same
// treatment the Playwright adapter gets). Best-effort by design: a failure never blocks a write.
import { spawnSync } from 'node:child_process';

/** Build the ACL-hardening argv for `dir`, or null when the platform/user makes it inapplicable.
 *
 *  `icacls <dir> /inheritance:r /grant:r <user>:(OI)(CI)F`
 *    /inheritance:r  — drop inherited profile ACEs (the actual fix)
 *    /grant:r <user> — replace any existing grant for this user with full control
 *    (OI)(CI)F       — object + container inherit, so new files under it inherit the restriction
 *
 *  Returned as an ARGV ARRAY, never a shell string: `dir` comes from `homedir()` today, but a
 *  shell string would make this a latent injection sink the moment the base dir is
 *  parameterised. `spawnSync` without a shell has nothing to inject into (ADR-025). */
export function hardenDirCommand(
  platform: NodeJS.Platform | string,
  dir: string,
  user: string | undefined,
): string[] | null {
  if (platform !== 'win32') return null;
  // Without a resolvable principal a `/grant:r` would be malformed — emit nothing rather than a
  // half-applied ACL that breaks inheritance and grants no one.
  if (!user) return null;
  return ['icacls', dir, '/inheritance:r', '/grant:r', `${user}:(OI)(CI)F`];
}

/** The current Windows principal, as icacls expects it. `USERDOMAIN\USERNAME` when both are
 *  present (a domain-joined machine), else the bare username. */
function currentUser(env: NodeJS.ProcessEnv): string | undefined {
  const name = env['USERNAME'];
  if (!name) return undefined;
  const domain = env['USERDOMAIN'];
  return domain ? `${domain}\\${name}` : name;
}

/** Apply the restrictive ACL to `dir` on Windows. BEST-EFFORT: never throws, never blocks a
 *  write — a user on a locked-down machine without `icacls` must still be able to use the tool
 *  (same posture as the audit sink, ADR-004). No-op everywhere else. */
export function hardenDir(dir: string, env: NodeJS.ProcessEnv = process.env): void {
  const cmd = hardenDirCommand(process.platform, dir, currentUser(env));
  if (!cmd) return;
  const [exe, ...args] = cmd;
  try {
    spawnSync(exe!, args, { stdio: 'ignore', windowsHide: true });
  } catch {
    // Hardening is defence in depth, not a gatekeeper — degrade silently (ADR-025).
  }
}
