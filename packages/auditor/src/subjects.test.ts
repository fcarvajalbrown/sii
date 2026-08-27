// Subject configuration — which taxpayers a sweep covers, and the salt that pseudonymises them.
//
// TWO PROPERTIES THAT CANNOT BE GOT WRONG TWICE:
//
//   * THE SALT IS WRITE-ONCE. Regenerating it silently re-keys every `TaxpayerKey`: the golden set
//     stops matching live sweeps, artifacts orphan from their subject, and NOTHING ERRORS. The
//     store simply looks like a different installation. So `loadSalt` creates only when absent and
//     never overwrites.
//   * A RUT NEVER REACHES ARGV. It is inside the confidentiality boundary, and a CLI flag puts it
//     in the process list where any other user on the machine can read it. Subjects come from a
//     file in the store root, which already holds raw SII responses and is ACL-hardened.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfidentialityError } from './errors.js';
import { taxpayerKey } from './confidential.js';
import { loadSalt, loadSubjects } from './subjects.js';
import type { KeyValueStore } from '@dostertags/sii-core';

let root: string;

beforeEach(async () => {
  root = await fsp.mkdtemp(join(tmpdir(), 'sii-auditor-subjects-'));
});

afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

function memoryKv(
  seed: Record<string, unknown> = {},
): KeyValueStore & { readonly data: Record<string, unknown> } {
  const data: Record<string, unknown> = { ...seed };
  return {
    data,
    async read<T>(key: string): Promise<T | null> {
      return (data[key] as T | undefined) ?? null;
    },
    async write<T>(key: string, value: T): Promise<void> {
      data[key] = value;
    },
    async delete(key: string): Promise<void> {
      delete data[key];
    },
  };
}

describe('loadSalt', () => {
  it('creates a salt on first use', async () => {
    const kv = memoryKv();
    const salt = await loadSalt(kv);
    // 32 bytes of entropy, hex-encoded.
    expect(salt).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns the SAME salt on every later call', async () => {
    const kv = memoryKv();
    expect(await loadSalt(kv)).toBe(await loadSalt(kv));
  });

  it('NEVER overwrites an existing salt', async () => {
    // The property that matters most. A regenerated salt re-keys every TaxpayerKey and nothing
    // errors — the golden set just quietly stops matching.
    const kv = memoryKv();
    const first = await loadSalt(kv);
    await loadSalt(kv);
    await loadSalt(kv);
    expect(kv.data['auditor-salt']).toBe(first);
  });

  it('REFUSES a stored salt that is too short to be safe', async () => {
    // A truncated salt makes the pseudonym brute-forceable: the RUT space is small enough to
    // enumerate. Better to stop than to hand out weak keys that look like strong ones.
    const kv = memoryKv({ 'auditor-salt': 'abc123' });
    await expect(loadSalt(kv)).rejects.toThrow(ConfidentialityError);
  });

  it('refuses a non-hex salt rather than deriving keys from it', async () => {
    const kv = memoryKv({ 'auditor-salt': 'z'.repeat(64) });
    await expect(loadSalt(kv)).rejects.toThrow(ConfidentialityError);
  });
});

describe('loadSubjects', () => {
  const write = async (content: unknown): Promise<void> => {
    await fsp.writeFile(join(root, 'subjects.json'), JSON.stringify(content), 'utf8');
  };

  it('is an empty list — not an error — when no subjects file exists', async () => {
    // A fresh install has no subjects. That is a real "nobody configured yet", and the sweep
    // reports idle rather than failing.
    expect(await loadSubjects(root, 'a'.repeat(64))).toEqual([]);
  });

  it('maps each configured RUT to its pseudonymous key', async () => {
    // Synthetic, Mod-11-valid RUTs (CONVENTIONS: real PII never lands in a tracked file).
    const salt = 'a'.repeat(64);
    await write({ subjects: [{ rut: '11111111-1' }] });

    const got = await loadSubjects(root, salt);
    expect(got).toEqual([taxpayerKey('11111111-1', salt)]);
  });

  it('CANONICALISES the RUT first, so two spellings give one key', async () => {
    // `11.111.111-1` and `11111111-1` are the same taxpayer. Two keys would split one subject's
    // artifacts across two identities and silently halve every history.
    const salt = 'a'.repeat(64);
    await write({ subjects: [{ rut: '11.111.111-1' }, { rut: '11111111-1' }] });

    const got = await loadSubjects(root, salt);
    expect(got).toEqual([taxpayerKey('11111111-1', salt)]);
  });

  it('REFUSES a malformed RUT instead of sweeping a subject nobody meant', async () => {
    // Mod-11 is checked locally before anything reaches SII (CONVENTIONS).
    await write({ subjects: [{ rut: '11111111-9' }] });
    await expect(loadSubjects(root, 'a'.repeat(64))).rejects.toThrow(/RUT/);
  });

  it('returns keys sorted, so the sweep order is deterministic', async () => {
    const salt = 'a'.repeat(64);
    await write({ subjects: [{ rut: '11111111-1' }, { rut: '22222222-2' }] });

    const got = await loadSubjects(root, salt);
    expect([...got]).toEqual([...got].sort());
  });

  it('refuses a subjects file that is not the expected shape', async () => {
    await write({ taxpayers: ['11111111-1'] });
    await expect(loadSubjects(root, 'a'.repeat(64))).rejects.toThrow(/subjects/);
  });
});

describe('the RUT never leaves the boundary', () => {
  it('returns ONLY keys — no RUT is in the result', async () => {
    const salt = 'a'.repeat(64);
    await fsp.writeFile(
      join(root, 'subjects.json'),
      JSON.stringify({ subjects: [{ rut: '11111111-1', alias: 'ferreteria' }] }),
      'utf8',
    );

    const got = await loadSubjects(root, salt);
    expect(JSON.stringify(got)).not.toContain('11111111');
    expect(JSON.stringify(got)).not.toContain('ferreteria');
  });
});
