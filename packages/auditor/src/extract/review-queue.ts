// The review queue (ADR-043) — where low-confidence extractions go INSTEAD of the store.
//
// The rule the brief sets and this enforces: a low-confidence extraction never silently enters the
// store. It waits for a human. That makes the queue's DEPTH a first-class health metric (it is one
// of the eight fields of the nightly report) — a queue growing faster than it is drained means the
// extractors are degrading, usually because SII changed something.
//
// The queue is also the first of the three learning signals: an auditor's decision here is a
// labelled example. `resolve` records not just the verdict but the CORRECTED value when there is
// one, which is what stage 3 absorbs and stage 4 clusters.

import { join } from 'node:path';
import { IntegrityError } from '../errors.js';
import { appendJsonl, readJsonl } from '../store/fs-util.js';
import type { ExtractionRecord } from './record.js';

export type ReviewVerdict =
  /** The extracted value was right; confidence was too low. Evidence the weights are miscalibrated. */
  | 'confirmed'
  /** The value was wrong and the auditor supplied the right one. The strongest learning signal. */
  | 'corrected'
  /** Neither — the artifact does not contain what the strategy thought. A scoping bug. */
  | 'rejected';

export interface ReviewItem {
  readonly record: ExtractionRecord;
  readonly queuedAt: string;
  /** Higher first. Derived from confidence and the entity's materiality, not from arrival order. */
  readonly priority: number;
}

export interface ReviewResolution {
  readonly recordId: string;
  readonly verdict: ReviewVerdict;
  /** The auditor's correct value when `verdict === 'corrected'`; absent otherwise. */
  readonly correctedValue?: unknown;
  /** Free text from the auditor. INSIDE the confidentiality boundary — never leaves the store. */
  readonly note?: string;
  readonly resolvedAt: string;
  /** Who decided. A local operator handle, never an email or a name (`confidential.ts`). */
  readonly reviewer: string;
}

export interface ReviewQueue {
  /** Enqueue. Idempotent on `record.id` so a re-run does not double-queue the same doubt. */
  enqueue(item: ReviewItem): Promise<void>;

  /** Pending items, priority descending then `queuedAt` ascending (deterministic). */
  pending(limit?: number): Promise<readonly ReviewItem[]>;

  /** Current depth — reported nightly, trended by `eval/`. */
  depth(): Promise<number>;

  /** Record an auditor's decision. The corrected value flows to the store; the verdict to stage 3. */
  resolve(resolution: ReviewResolution): Promise<void>;

  /**
   * Resolutions recorded since an instant — learning signal #1 of stage 3 ("auditor corrections
   * logged since the last run").
   */
  resolvedSince(instant: string): Promise<readonly ReviewResolution[]>;
}

/**
 * Priority for a queued item.
 *
 * Deliberately NOT just `1 - confidence`: a wildly uncertain reading of a $0 line matters less
 * than a mildly uncertain reading of a material one. `materiality` is supplied by the caller in
 * the entity's own units (pesos), log-scaled so one large document cannot monopolise the queue.
 */
export function reviewPriority(confidence: number, materiality: number): number {
  const doubt = 1 - Math.max(0, Math.min(1, confidence));
  const scale = Math.log10(Math.max(1, Math.abs(materiality)) + 1);
  return Math.round(doubt * scale * 1000) / 1000;
}

/**
 * In-memory review queue with the SAME semantics as the file-backed one — not a mock.
 *
 * It exists because `--in-memory` must exercise the real routing rule. A stub that accepted
 * everything would let a run report a healthy extraction while the queue silently swallowed every
 * doubt, which is the failure this whole component is here to prevent.
 */
export function memoryReviewQueue(): ReviewQueue {
  const queue = new Map<string, ReviewItem>();
  const resolutions = new Map<string, ReviewResolution>();

  const pendingItems = (): readonly ReviewItem[] =>
    [...queue.values()]
      .filter((i) => !resolutions.has(i.record.id))
      .sort(
        (a, b) =>
          b.priority - a.priority ||
          a.queuedAt.localeCompare(b.queuedAt) ||
          a.record.id.localeCompare(b.record.id),
      );

  return {
    async enqueue(item) {
      if (!queue.has(item.record.id)) queue.set(item.record.id, item);
    },
    async pending(limit) {
      const items = pendingItems();
      return limit === undefined ? items : items.slice(0, Math.max(0, limit));
    },
    async depth() {
      return pendingItems().length;
    },
    async resolve(resolution) {
      assertResolvable(resolution, queue.has(resolution.recordId));
      resolutions.set(resolution.recordId, resolution);
    },
    async resolvedSince(since) {
      return [...resolutions.values()]
        .filter((r) => r.resolvedAt >= since)
        .sort(
          (a, b) =>
            a.resolvedAt.localeCompare(b.resolvedAt) || a.recordId.localeCompare(b.recordId),
        );
    },
  };
}

/**
 * The three ways a resolution can be malformed. Shared so the two backends cannot drift — a rule
 * enforced by only one of them is a rule that depends on which store you happened to wire.
 */
function assertResolvable(resolution: ReviewResolution, wasQueued: boolean): void {
  // A `corrected` verdict IS its corrected value — that is the whole reason it is the strongest
  // learning signal. Without one it is an unusable "this was wrong" with nothing for stage 3 to
  // absorb, and the miscalibration it evidences would never be actionable.
  const hasValue = resolution.correctedValue !== undefined;
  if (resolution.verdict === 'corrected' && !hasValue) {
    throw new IntegrityError(
      `resolution for ${resolution.recordId} is 'corrected' but carries no correctedValue — ` +
        'the corrected value is the learning signal; without it the verdict teaches nothing',
    );
  }
  if (resolution.verdict !== 'corrected' && hasValue) {
    throw new IntegrityError(
      `resolution for ${resolution.recordId} is '${resolution.verdict}' yet carries a ` +
        'correctedValue — stage 3 would silently ignore it; use `corrected` or drop the value',
    );
  }
  // Resolving something nobody queued means the id is wrong. Accepting it would log a decision that
  // traces to no doubt, while the real doubt stays pending and the log claims otherwise.
  if (!wasQueued) {
    throw new IntegrityError(
      `no queued review item for record ${resolution.recordId} — refusing to record a ` +
        'resolution against a doubt that was never raised',
    );
  }
}

/**
 * File-backed review queue.
 *
 * Layout, following the append-only + fold-on-read shape of the stores beside it:
 *
 *   <root>/review/queue.jsonl        one ReviewItem per line, last write wins on record.id
 *   <root>/review/resolutions.jsonl  one ReviewResolution per line, last write wins on recordId
 *
 * PENDING IS QUEUED MINUS RESOLVED, computed on read rather than by deleting lines. Two reasons,
 * both about not losing history: an auditor's decision is a labelled training example that stage 3
 * absorbs (deleting it would discard the learning signal it exists to produce), and re-deriving
 * pending keeps a re-enqueue of an already-decided record from resurrecting it — otherwise the same
 * question would be asked every night and `depth` would measure run count rather than health.
 */
export function createFileReviewQueue(root: string): ReviewQueue {
  const dir = join(root, 'review');
  const queuePath = join(dir, 'queue.jsonl');
  const resolutionsPath = join(dir, 'resolutions.jsonl');

  /** Fold the append log: last occurrence of a record id wins. */
  const queued = async (): Promise<ReadonlyMap<string, ReviewItem>> => {
    const byId = new Map<string, ReviewItem>();
    for (const row of await readJsonl<ReviewItem>(queuePath)) byId.set(row.record.id, row);
    return byId;
  };

  const resolved = async (): Promise<ReadonlyMap<string, ReviewResolution>> => {
    const byId = new Map<string, ReviewResolution>();
    for (const row of await readJsonl<ReviewResolution>(resolutionsPath))
      byId.set(row.recordId, row);
    return byId;
  };

  const pendingItems = async (): Promise<readonly ReviewItem[]> => {
    const [q, r] = await Promise.all([queued(), resolved()]);
    return (
      [...q.values()]
        .filter((i) => !r.has(i.record.id))
        // Highest priority first; ties broken by arrival, then by id so the order is total and two
        // identical runs render the same queue (ADR-043 §I5).
        .sort(
          (a, b) =>
            b.priority - a.priority ||
            a.queuedAt.localeCompare(b.queuedAt) ||
            a.record.id.localeCompare(b.record.id),
        )
    );
  };

  return {
    async enqueue(item: ReviewItem): Promise<void> {
      // Idempotent on record.id: appending a duplicate is harmless because the fold keeps one, but
      // skipping the write keeps the log proportional to real doubts rather than to run count.
      const q = await queued();
      if (q.has(item.record.id)) return;
      await appendJsonl(queuePath, [item]);
    },

    async pending(limit?: number): Promise<readonly ReviewItem[]> {
      const items = await pendingItems();
      return limit === undefined ? items : items.slice(0, Math.max(0, limit));
    },

    async depth(): Promise<number> {
      return (await pendingItems()).length;
    },

    async resolve(resolution: ReviewResolution): Promise<void> {
      assertResolvable(resolution, (await queued()).has(resolution.recordId));
      await appendJsonl(resolutionsPath, [resolution]);
    },

    async resolvedSince(since: string): Promise<readonly ReviewResolution[]> {
      // INCLUSIVE of the boundary: exclusive would drop a resolution recorded in the same
      // millisecond a previous run ended, losing the signal with nothing reporting it missing.
      return [...(await resolved()).values()]
        .filter((r) => r.resolvedAt >= since)
        .sort(
          (a, b) =>
            a.resolvedAt.localeCompare(b.resolvedAt) || a.recordId.localeCompare(b.recordId),
        );
    },
  };
}
