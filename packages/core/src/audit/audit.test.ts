import { describe, it, expect } from 'vitest';
import { recordAudit } from './audit.js';
import { FixedClock, RecordingAuditSink } from '../adapters/fake/index.js';

describe('recordAudit', () => {
  it('stamps ts and drops secret-substring keys', () => {
    const clock = new FixedClock(new Date('2026-06-27T00:00:00Z'));
    const audit = new RecordingAuditSink();

    recordAudit(
      { clock, audit },
      {
        action: 'auth_login',
        result: 'ok',
        rut: '20000042-0',
        password: 'drop-me',
        sessionToken: 'drop-me',
        cookieJar: 'drop-me',
      },
    );

    const e = audit.entries[0]!;
    expect(e.ts).toBe('2026-06-27T00:00:00.000Z');
    expect(e.action).toBe('auth_login');
    expect(e.rut).toBe('20000042-0');
    expect(e.password).toBeUndefined();
    expect(e.sessionToken).toBeUndefined();
    expect(e.cookieJar).toBeUndefined();
  });

  // The scrub is the documented safety net for the audit log, and new domain modules are added
  // by an append-only pattern that invites a future author to pass a richer object. A depth-1
  // scrub would write a nested secret verbatim (code review F-04).
  it('drops secret keys at ANY depth, not just the top level', () => {
    const clock = new FixedClock(new Date('2026-06-27T00:00:00Z'));
    const audit = new RecordingAuditSink();

    recordAudit(
      { clock, audit },
      {
        action: 'some_task',
        result: 'ok',
        detail: { inner: { cookie: 'drop-me', keep: 'visible' }, token: 'drop-me' },
        list: [{ clave: 'drop-me', folio: '123' }],
      },
    );

    const dump = JSON.stringify(audit.entries[0]);
    expect(dump).not.toContain('drop-me');
    // Non-secret siblings survive at every depth — the scrub is surgical, not destructive.
    expect(dump).toContain('visible');
    expect(dump).toContain('123');
  });

  it('leaves non-object values and arrays of scalars intact', () => {
    const clock = new FixedClock(new Date('2026-06-27T00:00:00Z'));
    const audit = new RecordingAuditSink();

    recordAudit(
      { clock, audit },
      { action: 'a', result: 'ok', count: 3, flags: [1, 2, 3], nada: null },
    );

    const e = audit.entries[0]!;
    expect(e.count).toBe(3);
    expect(e.flags).toEqual([1, 2, 3]);
    expect(e.nada).toBeNull();
  });
});
