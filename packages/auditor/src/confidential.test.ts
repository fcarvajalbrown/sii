import { describe, expect, it } from 'vitest';
import { ConfidentialityError } from './errors.js';
import {
  SALT_BYTES,
  assertNoIdentifiers,
  scanForIdentifiers,
  taxpayerKey,
} from './confidential.js';

// Every RUT in this file is SYNTHETIC and Mod-11-valid (CONVENTIONS: real PII never lands in a
// tracked file, including test fixtures).
const SALT = 'a'.repeat(SALT_BYTES * 2);
const RUT_A = '11111111-1';
const RUT_B = '22222222-2';

describe('taxpayerKey', () => {
  it('is stable for the same RUT and salt, so engagements accumulate', () => {
    expect(taxpayerKey(RUT_A, SALT)).toBe(taxpayerKey(RUT_A, SALT));
  });

  it('differs across RUTs', () => {
    expect(taxpayerKey(RUT_A, SALT)).not.toBe(taxpayerKey(RUT_B, SALT));
  });

  it('differs across installations — the key is not a portable identifier', () => {
    expect(taxpayerKey(RUT_A, SALT)).not.toBe(taxpayerKey(RUT_A, 'b'.repeat(SALT_BYTES * 2)));
  });

  it('never contains the RUT it pseudonymises', () => {
    expect(taxpayerKey(RUT_A, SALT)).not.toContain('11111111');
  });

  it('refuses a short salt — the RUT space is small enough to brute-force without one', () => {
    expect(() => taxpayerKey(RUT_A, 'abc')).toThrow(ConfidentialityError);
  });
});

describe('scanForIdentifiers', () => {
  it('finds a RUT with separators', () => {
    const leaks = scanForIdentifiers({ note: 'contribuyente 11.111.111-1 revisado' });
    expect(leaks).toHaveLength(1);
    expect(leaks[0]?.pattern).toBe('rut');
    expect(leaks[0]?.at).toBe('$.note');
  });

  it('finds a RUT without separators', () => {
    expect(scanForIdentifiers('rut 11111111-1')).toHaveLength(1);
  });

  it('finds a razón social by its corporate suffix', () => {
    const leaks = scanForIdentifiers(['COMERCIAL EJEMPLO SPA']);
    expect(leaks[0]?.pattern).toBe('razon-social');
    expect(leaks[0]?.at).toBe('$[0]');
  });

  it('finds an email', () => {
    expect(scanForIdentifiers({ a: { b: 'contacto@ejemplo.cl' } })[0]?.pattern).toBe('email');
  });

  it('redacts the excerpt — an exception that logs the leak defeats the check', () => {
    const leak = scanForIdentifiers('11.111.111-1')[0];
    expect(leak?.excerpt).not.toContain('111.111');
    expect(leak?.excerpt).toContain('•');
  });

  it('walks keys in sorted order, so two runs report leaks identically', () => {
    const leaks = scanForIdentifiers({ z: 'rut 22222222-2', a: 'rut 11111111-1' });
    expect(leaks.map((l) => l.at)).toEqual(['$.a', '$.z']);
  });

  it('is clean for a manifest that carries only pseudonymous keys', () => {
    expect(
      scanForIdentifiers({
        runId: 'run-2026-08-06',
        taxpayers: [taxpayerKey(RUT_A, SALT)],
        stages: [{ stage: 'ingest', changed: { artifacts: 12 } }],
      }),
    ).toEqual([]);
  });
});

describe('assertNoIdentifiers', () => {
  it('passes clean payloads through', () => {
    expect(() => assertNoIdentifiers({ ok: true }, 'test')).not.toThrow();
  });

  it('throws with the path but never the identifier', () => {
    try {
      assertNoIdentifiers({ summary: 'swept 11.111.111-1' }, 'run manifest');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfidentialityError);
      const message = (err as Error).message;
      expect(message).toContain('$.summary');
      expect(message).not.toContain('111.111.111');
    }
  });
});
