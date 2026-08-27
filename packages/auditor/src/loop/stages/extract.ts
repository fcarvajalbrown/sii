// Stage 2 — EXTRACT (ADR-043).
//
// Parse new artifacts; record confidence; queue low-confidence items for review.
//
// Only artifacts recorded by THIS run are parsed — the manifest's `ingest` outcome bounds the work,
// so a nightly run does not re-parse the whole history every night. Re-parsing everything IS
// wanted when a strategy version changes, but that is a deliberate backfill, not the nightly path.
//
// THE ROUTING RULE, which is the stage's whole reason for existing: a record at or above
// `REVIEW_THRESHOLD` is upserted into the normalized store; below it, the record goes to the review
// queue and NOT to the store. There is no third path where an uncertain value quietly lands
// anyway. Failures are recorded too, never dropped — stage 4 clusters them into parser fixes.
//
// DETERMINISM: strategies are matched in `id` order and applied to artifacts in `retrievedAt` then
// `contentHash` order, so two runs over the same artifacts produce the same records, in the same
// order, with the same ids.

import { instant } from '../../provenance.js';
import { needsReview } from '../../extract/confidence.js';
import { reviewPriority } from '../../extract/review-queue.js';
import type { ExtractionFailure, ExtractionRecord } from '../../extract/record.js';
import type { ExtractionStrategy } from '../../extract/strategy.js';
import type { FetchManifest } from '../../ingest/manifest.js';
import type { AnyEntity, EntityKind } from '../../store/entities.js';
import type { LoopContext, StageResult } from '../context.js';

export async function extractStage(ctx: LoopContext): Promise<StageResult> {
  // DISCOVERY (ADR-046): the pending set is every manifest of a CONFIGURED subject whose artifact
  // no extraction record or failure references yet — attempted vs never-attempted, NOT this-run
  // vs history. The ingest outcome is deliberately not consulted: under ADR-044 a `learn` run's
  // ingest is always skipped while the fetch's artifacts wait in the store, and gating on it left
  // the scheduler target structurally unable to extract (found live 2026-08-10, the first real
  // fetch+learn). Re-parsing an ATTEMPTED artifact stays a deliberate backfill after a strategy
  // version bump — W3's stance, with the boundary in the right place.
  const attempted = await ctx.extractions.referencedArtifacts();
  const pendingByHash = new Map<string, FetchManifest>();
  for (const taxpayer of [...ctx.config.taxpayers].sort()) {
    for (const m of await ctx.artifacts.findManifests({ taxpayer })) {
      if (attempted.has(m.contentHash)) continue;
      const seen = pendingByHash.get(m.contentHash);
      // Identical bytes are ONE artifact however many fetches recorded them; keep the earliest
      // manifest so provenance dates to when the bytes were first seen.
      if (seen === undefined || m.retrievedAt < seen.retrievedAt) {
        pendingByHash.set(m.contentHash, m);
      }
    }
  }
  const manifests = [...pendingByHash.values()].sort(
    (a, b) =>
      a.retrievedAt.localeCompare(b.retrievedAt) || a.contentHash.localeCompare(b.contentHash),
  );

  if (manifests.length === 0) {
    return {
      summary: 'no pending artifacts — nothing to extract',
      changed: {},
      idle: true,
    };
  }

  const records: ExtractionRecord[] = [];
  const failures: ExtractionFailure[] = [];
  // Rows are grouped by kind so one `upsert` call per kind lands atomically, as the store promises.
  const byKind = new Map<EntityKind, AnyEntity[]>();
  const unprojected = new Set<string>();
  let upserted = 0;
  let queued = 0;
  let unmatched = 0;

  for (const manifest of manifests) {
    const bytes = await ctx.artifacts.get(manifest.contentHash);
    if (bytes === null) {
      // The manifest says the fetch happened but the bytes are gone (pruned, or never stored).
      // Recorded as a failure rather than skipped: silently parsing fewer artifacts than were
      // fetched is exactly how a run under-reports and still looks clean.
      failures.push({
        strategy: 'loop/stages/extract',
        provenance: {
          kind: 'artifact',
          artifact: manifest.contentHash,
          url: manifest.url,
          retrievedAt: manifest.retrievedAt,
          strategy: 'loop/stages/extract',
          locator: '',
        },
        message: `artifact ${manifest.contentHash} is referenced by a fetch manifest but absent from the store`,
        failedAt: instant(nowOf(ctx)),
        taxpayer: manifest.taxpayer,
        runId: ctx.runId,
      });
      continue;
    }

    const matched = ctx.strategies.match(manifest);
    if (matched.length === 0) {
      // NOT logged, so it stays pending (ADR-046): the night a wrapper for this surface lands,
      // the backlog extracts itself. Counted so the summary says so every night, never silently.
      unmatched += 1;
      continue;
    }

    // `match` returns active strategies in `id` order — determinism comes from the registry.
    for (const strategy of matched) {
      const outcome = await runStrategy(strategy, {
        manifest,
        bytes,
        runId: ctx.runId,
        taxpayer: manifest.taxpayer,
        now: nowOf(ctx),
      });
      failures.push(...outcome.failures);

      for (const record of outcome.records) {
        records.push(record);

        // THE ROUTING RULE. Below the threshold the record goes to the review queue and NOWHERE
        // else; at or above it, into the store. There is no third path where an uncertain value
        // quietly lands anyway.
        if (needsReview(record.confidence)) {
          await ctx.reviews.enqueue({
            record,
            queuedAt: nowOf(ctx),
            priority: reviewPriority(record.confidence, materialityOf(record)),
          });
          queued += 1;
          continue;
        }

        if (strategy.toEntities === undefined) {
          // Reported, never silent — see the `toEntities` contract in `extract/strategy.ts`.
          unprojected.add(strategy.id);
          continue;
        }

        const rows = strategy.toEntities(record, {
          recordedAt: nowOf(ctx),
          taxpayer: record.taxpayer,
        });
        for (const row of rows) {
          const kind = kindOf(row);
          const bucket = byKind.get(kind) ?? [];
          bucket.push(row);
          byKind.set(kind, bucket);
        }
        upserted += 1;
      }
    }
  }

  for (const [kind, rows] of [...byKind.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    await ctx.entities.upsert(kind, rows);
  }

  // The log is written even when everything was queued: `ArtifactStore.prune` decides what to delete
  // from these rows, so an unwritten record means the bytes behind it become prunable.
  await ctx.extractions.append(ctx.runId, records);
  await ctx.extractions.appendFailures(ctx.runId, failures);

  const parts = [
    `${records.length} record(s) from ${manifests.length} artifact(s)`,
    `${upserted} upserted`,
    `${queued} queued for review`,
  ];
  if (failures.length > 0) parts.push(`${failures.length} failure(s)`);
  if (unmatched > 0) parts.push(`${unmatched} artifact(s) matched no strategy (left pending)`);
  if (unprojected.size > 0) {
    parts.push(
      `${unprojected.size} strategy(ies) with no entity projection: ${[...unprojected].sort().join(', ')}`,
    );
  }

  return {
    summary: parts.join('; '),
    changed: {
      records: records.length,
      upserted,
      queued,
      failures: failures.length,
      unmatched,
      unprojected: unprojected.size,
    },
    // Pending artifacts it could not act on are work, not idleness — only an empty pending set is.
    idle: records.length === 0 && failures.length === 0 && unmatched === 0,
  };
}

const nowOf = (ctx: LoopContext): string => ctx.clock.now().toISOString();

/**
 * Run one strategy, converting a THROW into a recorded failure.
 *
 * A parser that throws instead of returning a failure is a bug in the parser, but losing the rest
 * of the night's extraction to it would be a worse one — and stage 4 clusters failures into parser
 * fixes, so the throw is more useful captured than propagated.
 */
async function runStrategy(
  strategy: ExtractionStrategy,
  ctx: Parameters<ExtractionStrategy['extract']>[0],
): Promise<{ records: readonly ExtractionRecord[]; failures: readonly ExtractionFailure[] }> {
  try {
    return await strategy.extract(ctx);
  } catch (err) {
    return {
      records: [],
      failures: [
        {
          strategy: `${strategy.id}@${strategy.version}`,
          provenance: {
            kind: 'artifact',
            artifact: ctx.manifest.contentHash,
            url: ctx.manifest.url,
            retrievedAt: ctx.manifest.retrievedAt,
            strategy: `${strategy.id}@${strategy.version}`,
            locator: '',
          },
          // Verbatim (ADR-004) — never translated, never summarised.
          message: err instanceof Error ? err.message : String(err),
          failedAt: instant(ctx.now),
          taxpayer: ctx.taxpayer,
          runId: ctx.runId,
        },
      ],
    };
  }
}

/** An entity's kind, from the prefix `entityId` puts in front of every id (`kind:hash`). */
function kindOf(row: AnyEntity): EntityKind {
  const prefix = row.id.slice(0, row.id.indexOf(':'));
  if (prefix === '') {
    throw new TypeError(
      `entity id ${JSON.stringify(row.id)} has no '<kind>:' prefix — build it with entityId()`,
    );
  }
  return prefix as EntityKind;
}

/**
 * Materiality for review priority, in pesos.
 *
 * Read from the record's own value when it exposes a numeric monto, else 0 — which ranks it by
 * doubt alone. Deliberately NOT guessed from a field whose meaning is unknown: over-stating
 * materiality would let a trivial row crowd out a real one at the top of an auditor's queue.
 */
function materialityOf(record: ExtractionRecord): number {
  const value = record.value;
  if (typeof value !== 'object' || value === null) return 0;
  const bag = value as Record<string, unknown>;
  for (const key of ['monto', 'valor', 'total', 'montoTotal']) {
    const v = bag[key];
    if (typeof v === 'number' && Number.isFinite(v)) return Math.abs(v);
  }
  return 0;
}
