import { describe, it, expect } from 'vitest';
import { hardenDirCommand } from './acl.js';

// The pure command builder is what carries the security decision (ADR-025); the spawn wrapper
// around it is a thin shim, like the Playwright adapter.
describe('hardenDirCommand (ADR-025 — Windows local-state ACL)', () => {
  it('emits an icacls argv on win32 that breaks inheritance and grants the user only', () => {
    const cmd = hardenDirCommand('win32', 'C:\\Users\\ana\\.sii', 'ana');
    expect(cmd).not.toBeNull();
    const [exe, ...args] = cmd!;
    expect(exe).toBe('icacls');
    expect(args).toContain('/inheritance:r');
    expect(args).toContain('/grant:r');
    expect(args.some((a) => a.startsWith('ana:'))).toBe(true);
  });

  it('passes the directory as ONE argv element, so a space in the profile path cannot split it', () => {
    // `C:\Users\Ana María\.sii` is an ordinary Windows profile path.
    const dir = 'C:\\Users\\Ana María\\.sii';
    const cmd = hardenDirCommand('win32', dir, 'Ana María')!;
    expect(cmd).toContain(dir); // present verbatim as a single element, not shell-quoted/split
    expect(cmd.filter((a) => a === dir)).toHaveLength(1);
  });

  it('returns null on non-Windows — POSIX modes already do the job there', () => {
    expect(hardenDirCommand('darwin', '/home/ana/.sii', 'ana')).toBeNull();
    expect(hardenDirCommand('linux', '/home/ana/.sii', 'ana')).toBeNull();
    expect(hardenDirCommand('freebsd', '/home/ana/.sii', 'ana')).toBeNull();
  });

  it('returns null when the current user cannot be determined — never emits a broken grant', () => {
    expect(hardenDirCommand('win32', 'C:\\Users\\ana\\.sii', '')).toBeNull();
    expect(hardenDirCommand('win32', 'C:\\Users\\ana\\.sii', undefined)).toBeNull();
  });

  it('never builds a shell string — every element is a discrete argv entry', () => {
    const cmd = hardenDirCommand('win32', 'C:\\x\\.sii', 'ana')!;
    // No element smuggles a shell metacharacter chain; spawn is called without a shell.
    for (const a of cmd) expect(a).not.toMatch(/[&|;><]/);
  });
});
