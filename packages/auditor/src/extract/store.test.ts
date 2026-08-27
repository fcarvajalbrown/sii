// `referencedArtifacts` — the fold ADR-046's pending-discovery rests on.
//
// The attempted set is the union of `provenance.artifact` over every RECORD and every FAILURE,
// across every run. A failure counts: an artifact that broke the parser is not retried nightly —
// re-parsing it after a fix is a version bump + deliberate backfill (W3's stance, kept).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contentHash, instant } from '../provenance.js';
import { createFileExtractionStore, memoryExtractionStore } from './store.js';
import type { ExtractionStore } from './store.js';
import type { ExtractionFailure, ExtractionRecord } from './record.js';

let root: string;

beforeEach(async () => {
  root = await fsp.mkdtemp(join(tmpdir(), 'sii-auditor-extractions-'));
});

afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

const HASH_A = contentHash('a'.repeat(64));
const HASH_B = contentHash('b'.repeat(64));
const HASH_C = contentHash('c'.repeat(64));

const provenance = (artifact: string) =>
  ({
    kind: 'artifact',
    artifact,
    url: 'https://www4.sii.cl/x/y',
    retrievedAt: instant('2026-08-04T09:30:00.000Z'),
    strategy: 'test-strategy@1',
    locator: '/data',
  }) as const;

const record = (artifact: string, runId: string): ExtractionRecord => ({
  id: `${artifact}:test-strategy`,
  strategy: 'test-strategy@1',
  provenance: provenance(artifact),
  value: {},
  confidence: 1,
  signals: [],
  extractedAt: instant('2026-08-10T03:00:00.000Z'),
  taxpayer: 'tp-alpha',
  runId,
});

const failure = (artifact: string, runId: string): ExtractionFailure => ({
  strategy: 'test-strategy@1',
  provenance: provenance(artifact),
  message: 'la envoltura SDI no es un objeto',
  failedAt: instant('2026-08-10T03:00:00.000Z'),
  taxpayer: 'tp-alpha',
  runId,
});

describe('referencedArtifacts (ADR-046)', () => {
  const backends = (): readonly (readonly [string, ExtractionStore])[] => [
    ['file', createFileExtractionStore(root)],
    ['memory', memoryExtractionStore()],
  ];

  it('is empty for a store with no extractions', async () => {
    for (const [name, store] of backends()) {
      expect([...(await store.referencedArtifacts())], name).toEqual([]);
    }
  });

  it('unions record references across runs', async () => {
    for (const [name, store] of backends()) {
      await store.append('run-1', [record(HASH_A, 'run-1')]);
      await store.append('run-2', [record(HASH_B, 'run-2')]);

      const referenced = await store.referencedArtifacts();
      expect(referenced.has(HASH_A), name).toBe(true);
      expect(referenced.has(HASH_B), name).toBe(true);
      expect(referenced.has(HASH_C), name).toBe(false);
    }
  });

  it('counts a FAILURE as attempted — a broken artifact is not retried nightly', async () => {
    for (const [name, store] of backends()) {
      await store.appendFailures('run-1', [failure(HASH_C, 'run-1')]);
      expect((await store.referencedArtifacts()).has(HASH_C), name).toBe(true);
    }
  });

  it('survives a reopen on the file backend — the fold reads disk, not memory', async () => {
    const store = createFileExtractionStore(root);
    await store.append('run-1', [record(HASH_A, 'run-1')]);

    expect((await createFileExtractionStore(root).referencedArtifacts()).has(HASH_A)).toBe(true);
  });
});
