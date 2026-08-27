// The review queue (ADR-043) — the boundary a low-confidence extraction must not cross.
//
// The properties worth testing here are the ones whose failure is SILENT: a doubt that never
// reaches a human, a resolved doubt that comes back, a resolution recorded against a record nobody
// queued. Depth is a reported health metric, so a queue that under-counts reads as a healthy
// extractor.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IntegrityError } from '../errors.js';
import { contentHash, instant } from '../provenance.js';
import { createFileReviewQueue, memoryReviewQueue, reviewPriority } from './review-queue.js';
import type { ReviewItem, ReviewQueue } from './review-queue.js';
import type { ExtractionRecord } from './record.js';

let root: string;
let queue: ReviewQueue;

beforeEach(async () => {
  root = await fsp.mkdtemp(join(tmpdir(), 'sii-auditor-review-'));
  queue = createFileReviewQueue(root);
});

afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

const record = (id: string, confidence = 0.4): ExtractionRecord => ({
  id,
  strategy: 'f29-propuesta@1',
  provenance: {
    kind: 'artifact',
    artifact: contentHash('a'.repeat(64)),
    retrievedAt: instant('2026-08-04T09:30:00.000Z'),
    url: 'https://www4.sii.cl/propuestaf29ui/services/data/facadeService/obtiene',
    strategy: 'f29-propuesta@1',
    locator: '/data/codigos/151',
  },
  value: { codigo: '151', valor: 1000 },
  confidence,
  signals: [{ code: 'alias_fallback', field: 'valor', detail: 'matched `monto`' }],
  extractedAt: instant('2026-08-04T09:31:00.000Z'),
  // Synthetic pseudonymous subject — never a real RUT (confidential.ts).
  taxpayer: 'tp-alpha',
  runId: 'run-1',
});

const item = (id: string, priority = 1, queuedAt = '2026-08-04T10:00:00.000Z'): ReviewItem => ({
  record: record(id),
  queuedAt,
  priority,
});

describe('enqueue and depth', () => {
  it('holds a queued item and reports its depth', async () => {
    await queue.enqueue(item('rec-1'));
    expect(await queue.depth()).toBe(1);
    expect((await queue.pending()).map((i) => i.record.id)).toEqual(['rec-1']);
  });

  it('is empty before anything is queued — a real empty, not an error', async () => {
    expect(await queue.depth()).toBe(0);
    expect(await queue.pending()).toEqual([]);
  });

  it('is idempotent on record id, so a re-run does not double-queue the same doubt', async () => {
    await queue.enqueue(item('rec-1'));
    await queue.enqueue(item('rec-1'));
    expect(await queue.depth()).toBe(1);
  });

  it('orders by priority descending, then queuedAt ascending', async () => {
    await queue.enqueue(item('low', 0.2, '2026-08-04T10:00:00.000Z'));
    await queue.enqueue(item('high', 9.5, '2026-08-04T12:00:00.000Z'));
    await queue.enqueue(item('mid-late', 1.0, '2026-08-04T12:00:00.000Z'));
    await queue.enqueue(item('mid-early', 1.0, '2026-08-04T08:00:00.000Z'));

    expect((await queue.pending()).map((i) => i.record.id)).toEqual([
      'high',
      'mid-early',
      'mid-late',
      'low',
    ]);
  });

  it('honours a limit without changing the order', async () => {
    await queue.enqueue(item('a', 1));
    await queue.enqueue(item('b', 5));
    expect((await queue.pending(1)).map((i) => i.record.id)).toEqual(['b']);
  });

  it('survives a reopen — the queue is on disk, not in memory', async () => {
    await queue.enqueue(item('rec-1'));
    expect(await createFileReviewQueue(root).depth()).toBe(1);
  });
});

describe('resolve', () => {
  it('removes the item from pending and drops the depth', async () => {
    await queue.enqueue(item('rec-1'));
    await queue.resolve({
      recordId: 'rec-1',
      verdict: 'confirmed',
      resolvedAt: '2026-08-05T09:00:00.000Z',
      reviewer: 'operator-local',
    });

    expect(await queue.depth()).toBe(0);
    expect(await queue.pending()).toEqual([]);
  });

  it('does NOT resurrect a resolved doubt when a later run re-enqueues the same record', async () => {
    // Same record id is the same doubt, already decided. Re-queueing it would hand an auditor the
    // same question every night and make depth a function of run count rather than of health.
    await queue.enqueue(item('rec-1'));
    await queue.resolve({
      recordId: 'rec-1',
      verdict: 'rejected',
      resolvedAt: '2026-08-05T09:00:00.000Z',
      reviewer: 'operator-local',
    });
    await queue.enqueue(item('rec-1'));

    expect(await queue.depth()).toBe(0);
  });

  it('refuses a resolution for a record that was never queued', async () => {
    // Otherwise a typo'd id records a decision nobody can trace to a doubt, and the real doubt
    // stays pending forever while the log claims it was handled.
    await expect(
      queue.resolve({
        recordId: 'never-queued',
        verdict: 'confirmed',
        resolvedAt: '2026-08-05T09:00:00.000Z',
        reviewer: 'operator-local',
      }),
    ).rejects.toThrow(IntegrityError);
  });

  it('refuses a `corrected` verdict with no corrected value', async () => {
    // `corrected` is the strongest learning signal precisely BECAUSE it carries the right answer.
    // Without one it is an unusable "this was wrong" with nothing for stage 3 to absorb.
    await queue.enqueue(item('rec-1'));
    await expect(
      queue.resolve({
        recordId: 'rec-1',
        verdict: 'corrected',
        resolvedAt: '2026-08-05T09:00:00.000Z',
        reviewer: 'operator-local',
      }),
    ).rejects.toThrow(/corrected/i);
  });

  it('refuses a corrected value on a verdict that is not `corrected`', async () => {
    // A contradictory resolution — the value would be silently ignored by stage 3.
    await queue.enqueue(item('rec-1'));
    await expect(
      queue.resolve({
        recordId: 'rec-1',
        verdict: 'confirmed',
        correctedValue: 999,
        resolvedAt: '2026-08-05T09:00:00.000Z',
        reviewer: 'operator-local',
      }),
    ).rejects.toThrow(IntegrityError);
  });

  it('keeps the corrected value for stage 3 to absorb', async () => {
    await queue.enqueue(item('rec-1'));
    await queue.resolve({
      recordId: 'rec-1',
      verdict: 'corrected',
      correctedValue: { codigo: '151', valor: 2000 },
      resolvedAt: '2026-08-05T09:00:00.000Z',
      reviewer: 'operator-local',
    });

    const [res] = await queue.resolvedSince('2026-08-01T00:00:00.000Z');
    expect(res?.verdict).toBe('corrected');
    expect(res?.correctedValue).toEqual({ codigo: '151', valor: 2000 });
  });
});

describe('resolvedSince — learning signal #1 for stage 3', () => {
  const resolveAt = async (id: string, at: string): Promise<void> => {
    await queue.enqueue(item(id));
    await queue.resolve({
      recordId: id,
      verdict: 'confirmed',
      resolvedAt: at,
      reviewer: 'operator-local',
    });
  };

  it('returns only resolutions at or after the instant, oldest first', async () => {
    await resolveAt('old', '2026-08-01T00:00:00.000Z');
    await resolveAt('new', '2026-08-06T00:00:00.000Z');

    const since = await queue.resolvedSince('2026-08-05T00:00:00.000Z');
    expect(since.map((r) => r.recordId)).toEqual(['new']);
  });

  it('is inclusive of the boundary instant', async () => {
    // Exclusive would drop a resolution recorded in the same millisecond the last run ended —
    // the signal would be lost with nothing reporting it missing.
    await resolveAt('edge', '2026-08-05T00:00:00.000Z');
    expect((await queue.resolvedSince('2026-08-05T00:00:00.000Z')).map((r) => r.recordId)).toEqual([
      'edge',
    ]);
  });

  it('is empty, not an error, when nothing has been resolved', async () => {
    expect(await queue.resolvedSince('2026-08-01T00:00:00.000Z')).toEqual([]);
  });
});

// The in-memory queue backs `--in-memory` runs, so a rule enforced by only one backend is a rule
// that depends on which store happened to be wired — exactly the drift `store/memory.ts` warns
// about for the artifact pair.
describe('memory/file parity', () => {
  const backends = (): readonly (readonly [string, ReviewQueue])[] => [
    ['file', createFileReviewQueue(root)],
    ['memory', memoryReviewQueue()],
  ];

  it('both route, order and drain identically', async () => {
    for (const [name, q] of backends()) {
      await q.enqueue(item('a', 1));
      await q.enqueue(item('b', 5));
      await q.enqueue(item('b', 5)); // idempotent
      expect(await q.depth(), name).toBe(2);
      expect(
        (await q.pending()).map((i) => i.record.id),
        name,
      ).toEqual(['b', 'a']);

      await q.resolve({
        recordId: 'b',
        verdict: 'confirmed',
        resolvedAt: '2026-08-05T09:00:00.000Z',
        reviewer: 'operator-local',
      });
      expect(await q.depth(), name).toBe(1);
    }
  });

  it('both refuse the same three malformed resolutions', async () => {
    for (const [name, q] of backends()) {
      await q.enqueue(item('a'));
      const base = { resolvedAt: '2026-08-05T09:00:00.000Z', reviewer: 'operator-local' } as const;

      // corrected without a value
      await expect(
        q.resolve({ recordId: 'a', verdict: 'corrected', ...base }),
        name,
      ).rejects.toThrow(IntegrityError);
      // a value on a non-corrected verdict
      await expect(
        q.resolve({ recordId: 'a', verdict: 'rejected', correctedValue: 1, ...base }),
        name,
      ).rejects.toThrow(IntegrityError);
      // never queued
      await expect(
        q.resolve({ recordId: 'ghost', verdict: 'confirmed', ...base }),
        name,
      ).rejects.toThrow(IntegrityError);
    }
  });
});

describe('reviewPriority', () => {
  it('ranks a mildly uncertain material figure above a wildly uncertain trivial one', async () => {
    // The reason priority is not just `1 - confidence`.
    expect(reviewPriority(0.65, 50_000_000)).toBeGreaterThan(reviewPriority(0.1, 0));
  });

  it('is zero when there is no doubt at all', () => {
    expect(reviewPriority(1, 1_000_000)).toBe(0);
  });
});
