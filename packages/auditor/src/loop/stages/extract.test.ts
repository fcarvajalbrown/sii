// Stage 2 — EXTRACT (ADR-043). The routing rule is the stage's whole reason for existing.
//
// THE PROPERTY UNDER TEST: a record at or above `REVIEW_THRESHOLD` is upserted into the normalized
// store; below it, the record goes to the review queue and NOT to the store. Never both, never
// neither. Both failure directions are silent in production — a low-confidence value that slips
// into the store is an unexamined figure presented as fact, and a high-confidence value that only
// reaches the queue is a month that reads as missing.

import { describe, expect, it } from 'vitest';
import { contentHash, instant } from '../../provenance.js';
import { memoryArtifactStore, memoryNormalizedStore } from '../../store/memory.js';
import { memoryReviewQueue } from '../../extract/review-queue.js';
import { memoryExtractionStore } from '../../extract/store.js';
import { StrategyRegistry } from '../../extract/strategy.js';
import { REVIEW_THRESHOLD } from '../../extract/confidence.js';
import { DEFAULT_TOLERANCES } from '../../eval/gate.js';
import { DEFAULT_CONFIG } from '../orchestrator.js';
import { fixedClock, inMemoryContext } from '../in-memory.js';
import { extractStage } from './extract.js';
import type { ExtractionStrategy } from '../../extract/strategy.js';
import type { ExtractionRecord } from '../../extract/record.js';
import type { FetchManifest } from '../../ingest/manifest.js';
import type { AnyEntity } from '../../store/entities.js';
import type { LoopContext } from '../context.js';
import type { RunManifest } from '../manifest.js';

const TAXPAYER = 'tp-alpha';
const RUN = 'run-1';

const fetchManifest = (over: Partial<FetchManifest> = {}): FetchManifest => ({
  contentHash: contentHash('a'.repeat(64)),
  url: 'https://www4.sii.cl/propuestaf29ui/services/data/facadeService/obtieneDatos',
  transport: 'requestJson',
  httpStatus: 200,
  retrievedAt: instant('2026-08-04T09:30:00.000Z'),
  contentType: 'application/json',
  byteLength: 12,
  durationMs: 100,
  requestFingerprint: null,
  taxpayer: TAXPAYER,
  runId: RUN,
  ...over,
});

const provenanceOf = (m: FetchManifest, strategy: string) =>
  ({
    kind: 'artifact',
    artifact: m.contentHash,
    url: m.url,
    retrievedAt: m.retrievedAt,
    strategy,
    locator: '/data',
  }) as const;

/** A strategy that yields one record at a chosen confidence, and projects it into one entity. */
function strategyYielding(
  id: string,
  confidence: number,
  opts: { readonly project?: boolean } = {},
): ExtractionStrategy {
  const ref = `${id}@1`;
  const strategy: ExtractionStrategy = {
    id,
    version: 1,
    scope: { url: 'sii.cl' },
    describes: `test strategy ${id}`,
    async extract(ctx) {
      const record: ExtractionRecord = {
        id: `${ctx.manifest.contentHash}:${id}`,
        strategy: ref,
        provenance: provenanceOf(ctx.manifest, ref),
        value: { codigo: '151', valor: 1000 },
        confidence,
        signals: [],
        extractedAt: instant(ctx.now),
        taxpayer: ctx.taxpayer,
        runId: ctx.runId,
      };
      return { records: [record], failures: [] };
    },
  };
  if (opts.project !== false) {
    strategy.toEntities = (record, ctx): readonly AnyEntity[] => [
      {
        id: `taxReturnForm:${record.id}`,
        taxpayer: ctx.taxpayer,
        derivedFrom: record.id,
        recordedAt: ctx.recordedAt,
        form: 'F29',
        period: '202308',
        folio: null,
        estado: null,
        presentadaEn: null,
      } as unknown as AnyEntity,
    ];
  }
  return strategy;
}

/** A strategy whose parse fails outright — failures are recorded, never dropped. */
const failingStrategy = (id: string, message: string): ExtractionStrategy => ({
  id,
  version: 1,
  scope: { url: 'sii.cl' },
  describes: `failing ${id}`,
  async extract(ctx) {
    return {
      records: [],
      failures: [
        {
          strategy: `${id}@1`,
          provenance: provenanceOf(ctx.manifest, `${id}@1`),
          message,
          failedAt: instant(ctx.now),
          taxpayer: ctx.taxpayer,
          runId: ctx.runId,
        },
      ],
    };
  },
});

interface Harness {
  readonly ctx: LoopContext;
  readonly entities: ReturnType<typeof memoryNormalizedStore>;
  readonly reviews: ReturnType<typeof memoryReviewQueue>;
  readonly extractions: ReturnType<typeof memoryExtractionStore>;
  /** The fetch manifests the harness recorded, in spec order — for seeding prior extractions. */
  readonly manifests: readonly FetchManifest[];
}

async function harness(
  strategies: readonly ExtractionStrategy[],
  specs: readonly Partial<FetchManifest>[] = [{}],
): Promise<Harness> {
  const artifacts = memoryArtifactStore();
  const entities = memoryNormalizedStore();
  const reviews = memoryReviewQueue();
  const extractions = memoryExtractionStore();
  const registry = new StrategyRegistry();
  for (const s of strategies) registry.register(s);

  // The manifest's contentHash MUST be the hash of the bytes actually stored, or the stage reads
  // the artifact as absent — which is a real failure path, just not the one under test here.
  const manifests: FetchManifest[] = [];
  for (const [i, spec] of specs.entries()) {
    const hash = await artifacts.put(Buffer.from(`{"data":{},"n":${i}}`));
    const m = fetchManifest({ ...spec, contentHash: hash });
    manifests.push(m);
    await artifacts.putManifest(m);
  }

  const services = inMemoryContext({ clock: fixedClock() });
  // The stage discovers pending artifacts from the STORE (ADR-046); the ingest outcome below is
  // context realism, not a gate — several tests replace it with a skipped one to prove that.
  const manifest: RunManifest = {
    runId: RUN,
    startedAt: '2026-08-06T03:00:00.000Z',
    finishedAt: null,
    status: 'running',
    taxpayers: [TAXPAYER],
    ruleSetVersion: 'x',
    strategyVersions: [],
    goldenSetVersion: null,
    seed: 1,
    dryRun: false,
    dataAsOf: null,
    resumedFrom: null,
    stages: [
      {
        stage: 'ingest',
        status: 'ok',
        startedAt: '2026-08-06T03:00:00.000Z',
        finishedAt: '2026-08-06T03:00:01.000Z',
        durationMs: 1000,
        summary: 'fetched',
        changed: { artifacts: manifests.length },
        detail: null,
      },
    ],
  };

  const ctx: LoopContext = {
    ...services,
    artifacts,
    entities,
    reviews,
    extractions,
    strategies: registry,
    runId: RUN,
    config: {
      ...DEFAULT_CONFIG,
      taxpayers: [TAXPAYER],
      tolerances: DEFAULT_TOLERANCES,
    },
    manifest: () => manifest,
  };

  return { ctx, entities, reviews, extractions, manifests };
}

/** A prior run's record referencing a manifest's artifact — what marks it "attempted". */
const attemptedRecord = (m: FetchManifest, runId: string): ExtractionRecord => ({
  id: `${m.contentHash}:earlier-strategy`,
  strategy: 'earlier-strategy@1',
  provenance: provenanceOf(m, 'earlier-strategy@1'),
  value: {},
  confidence: 1,
  signals: [],
  extractedAt: instant('2026-08-09T03:00:00.000Z'),
  taxpayer: m.taxpayer,
  runId,
});

describe('the routing rule', () => {
  it('upserts a confident record into the store and does NOT queue it', async () => {
    const h = await harness([strategyYielding('good', 0.95)]);
    const result = await extractStage(h.ctx);

    expect(await h.entities.count('taxReturnForm')).toBe(1);
    expect(await h.reviews.depth()).toBe(0);
    expect(result.changed['upserted']).toBe(1);
    expect(result.changed['queued']).toBe(0);
  });

  it('queues a doubtful record and does NOT put it in the store', async () => {
    const h = await harness([strategyYielding('doubtful', 0.3)]);
    const result = await extractStage(h.ctx);

    expect(await h.reviews.depth()).toBe(1);
    expect(await h.entities.count('taxReturnForm')).toBe(0);
    expect(result.changed['queued']).toBe(1);
    expect(result.changed['upserted']).toBe(0);
  });

  it('routes EXACTLY at the threshold to the store — the boundary is inclusive', async () => {
    // `needsReview` is `confidence < threshold`, so the threshold value itself is confident. Pinned
    // because an off-by-one here silently moves every borderline record to the wrong side.
    const h = await harness([strategyYielding('edge', REVIEW_THRESHOLD)]);
    await extractStage(h.ctx);

    expect(await h.entities.count('taxReturnForm')).toBe(1);
    expect(await h.reviews.depth()).toBe(0);
  });

  it('routes just below the threshold to the queue', async () => {
    const h = await harness([strategyYielding('edge', REVIEW_THRESHOLD - 0.0001)]);
    await extractStage(h.ctx);

    expect(await h.entities.count('taxReturnForm')).toBe(0);
    expect(await h.reviews.depth()).toBe(1);
  });

  it('never both and never neither — every record lands on exactly one side', async () => {
    const h = await harness([
      strategyYielding('a-good', 0.99),
      strategyYielding('b-doubtful', 0.2),
      strategyYielding('c-good', 0.8),
    ]);
    const result = await extractStage(h.ctx);

    const upserted = result.changed['upserted'] ?? 0;
    const queued = result.changed['queued'] ?? 0;
    const records = result.changed['records'] ?? 0;
    expect(records).toBe(3);
    expect(upserted + queued).toBe(records);
    expect(await h.entities.count('taxReturnForm')).toBe(upserted);
    expect(await h.reviews.depth()).toBe(queued);
  });
});

describe('the extraction log', () => {
  it('writes every record, confident or queued — prune reads this to keep artifacts alive', async () => {
    const h = await harness([strategyYielding('good', 0.95), strategyYielding('bad', 0.2)]);
    await extractStage(h.ctx);

    const logged = await h.extractions.byRun(RUN);
    expect(logged).toHaveLength(2);
    // Every logged record cites the artifact it was read from — that citation is what stops the
    // next prune from deleting the bytes behind a live figure.
    for (const r of logged) expect(r.provenance.artifact).toBeTruthy();
  });

  it('records a parse failure instead of dropping it', async () => {
    const h = await harness([failingStrategy('broken', 'la envoltura SDI no es un objeto')]);
    const result = await extractStage(h.ctx);

    const failures = await h.extractions.failuresByRun(RUN);
    expect(failures).toHaveLength(1);
    // SII's own message passes through verbatim (ADR-004).
    expect(failures[0]?.message).toBe('la envoltura SDI no es un objeto');
    expect(result.changed['failures']).toBe(1);
  });

  it('a failing strategy does not stop the others on the same artifact', async () => {
    const h = await harness([failingStrategy('broken', 'boom'), strategyYielding('good', 0.95)]);
    const result = await extractStage(h.ctx);

    expect(result.changed['upserted']).toBe(1);
    expect(result.changed['failures']).toBe(1);
  });
});

describe('projection', () => {
  it('counts a strategy with no projection as unprojected and NAMES it', async () => {
    // Never silent: a record whose entity mapping does not exist yet is logged and routed, but the
    // summary has to say so or a run reports success while the store stays empty.
    const h = await harness([strategyYielding('unmapped', 0.95, { project: false })]);
    const result = await extractStage(h.ctx);

    expect(result.changed['unprojected']).toBe(1);
    expect(result.changed['upserted']).toBe(0);
    expect(result.summary).toMatch(/unmapped/);
  });

  it('still logs an unprojected record, so its artifact stays referenced', async () => {
    const h = await harness([strategyYielding('unmapped', 0.95, { project: false })]);
    await extractStage(h.ctx);
    expect(await h.extractions.byRun(RUN)).toHaveLength(1);
  });
});

describe('discovery (ADR-046): attempted vs never-attempted, not this-run vs history', () => {
  it('is idle when nothing is pending', async () => {
    const h = await harness([strategyYielding('good', 0.95)], []);
    const result = await extractStage(h.ctx);
    expect(result.idle).toBe(true);
  });

  it('extracts artifacts a PRIOR run recorded, even when this run never ingested', async () => {
    // THE ADR-044 learn path. The first real fetch+learn (2026-08-10) proved the old run-bounded
    // rule extracted nothing, ever, in learn mode: the fetch's artifacts belong to another runId
    // and a learn run's ingest is always skipped.
    const h = await harness([strategyYielding('good', 0.95)], [{ runId: 'an-older-fetch' }]);
    const result = await extractStage({
      ...h.ctx,
      // No ingest outcome at all — the stage must not care.
      manifest: () => ({ ...h.ctx.manifest(), stages: [] }),
    });

    expect(result.changed['records']).toBe(1);
    expect(await h.entities.count('taxReturnForm')).toBe(1);
  });

  it('skips an artifact an earlier run already extracted — nightly is not a backfill', async () => {
    const h = await harness([strategyYielding('good', 0.95)]);
    const seed = h.manifests[0];
    if (seed === undefined) throw new Error('expected a seeded manifest');
    await h.extractions.append('a-prior-learn', [attemptedRecord(seed, 'a-prior-learn')]);

    const result = await extractStage(h.ctx);

    expect(result.idle).toBe(true);
    expect(await h.entities.count('taxReturnForm')).toBe(0);
  });

  it('a prior FAILURE also counts as attempted — retry is a version bump + backfill', async () => {
    const h = await harness([strategyYielding('good', 0.95)]);
    const seed = h.manifests[0];
    if (seed === undefined) throw new Error('expected a seeded manifest');
    await h.extractions.appendFailures('a-prior-learn', [
      {
        strategy: 'earlier-strategy@1',
        provenance: provenanceOf(seed, 'earlier-strategy@1'),
        message: 'respuesta no es JSON',
        failedAt: instant('2026-08-09T03:00:00.000Z'),
        taxpayer: seed.taxpayer,
        runId: 'a-prior-learn',
      },
    ]);

    const result = await extractStage(h.ctx);
    expect(result.idle).toBe(true);
  });

  it('ignores artifacts of a taxpayer this run is not configured for', async () => {
    // Same scoping rule as computeDataAsOf — and what keeps the orphan-salt history (the 08-06
    // artifacts under a key no configured subject has) from flooding the first real learn.
    const h = await harness([strategyYielding('good', 0.95)], [{ taxpayer: 'tp-beta' }]);
    const result = await extractStage(h.ctx);
    expect(result.idle).toBe(true);
  });

  it('leaves an artifact NO strategy matches pending, counted as unmatched', async () => {
    // Not logged ⇒ still pending: the night a wrapper for its surface lands, the backlog extracts
    // itself. Meanwhile the counter says so every night — visible, never silent.
    const h = await harness([]);
    const result = await extractStage(h.ctx);

    expect(result.changed['unmatched']).toBe(1);
    expect(result.idle).not.toBe(true);
    expect(result.summary).toMatch(/no strategy/i);
    expect(await h.extractions.byRun(RUN)).toHaveLength(0);
  });

  it('treats identical bytes under two manifests as ONE pending artifact', async () => {
    const h = await harness([strategyYielding('good', 0.95)]);
    const seed = h.manifests[0];
    if (seed === undefined) throw new Error('expected a seeded manifest');
    await h.ctx.artifacts.putManifest(
      fetchManifest({
        contentHash: seed.contentHash,
        retrievedAt: instant('2026-08-05T09:30:00.000Z'),
        runId: 'a-later-fetch',
      }),
    );

    const result = await extractStage(h.ctx);
    expect(result.changed['records']).toBe(1);
  });

  it('records a failure when a manifest cites bytes the store does not have', async () => {
    // Silently parsing fewer artifacts than were fetched is how a run under-reports and still
    // looks clean, so a missing artifact is a recorded failure rather than a skip.
    const artifacts = memoryArtifactStore();
    const orphan = fetchManifest({ contentHash: contentHash('f'.repeat(64)) });
    await artifacts.putManifest(orphan);

    const h = await harness([strategyYielding('good', 0.95)], []);
    const result = await extractStage({ ...h.ctx, artifacts });

    expect(result.changed['failures']).toBe(1);
    expect(result.changed['records']).toBe(0);
  });

  it('produces the same records in the same order on a re-run', async () => {
    const build = () =>
      harness([strategyYielding('b-second', 0.95), strategyYielding('a-first', 0.95)]);
    const first = await build();
    await extractStage(first.ctx);
    const second = await build();
    await extractStage(second.ctx);

    const ids = async (h: Harness) => (await h.extractions.byRun(RUN)).map((r) => r.id);
    expect(await ids(first)).toEqual(await ids(second));
  });
});
