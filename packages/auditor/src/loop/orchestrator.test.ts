import { describe, expect, it } from 'vitest';
import { DEFAULT_TOLERANCES } from '../eval/gate.js';
import { contentHash, instant } from '../provenance.js';
import type { FetchManifest } from '../ingest/manifest.js';
import { fixedClock, inMemoryContext, memoryManifestStore } from './in-memory.js';
import {
  DEFAULT_CONFIG,
  FETCH_STAGES,
  LEARN_STAGES,
  resumeNightly,
  runNightly,
  runStage,
} from './orchestrator.js';
import type { OrchestratorDeps } from './orchestrator.js';
import { STAGES, completedStages, nextStage } from './manifest.js';
import type { LoopConfig, StageFn } from './context.js';

function deps(overrides: Partial<LoopConfig> = {}): OrchestratorDeps & {
  manifests: ReturnType<typeof memoryManifestStore>;
  services: ReturnType<typeof inMemoryContext>;
} {
  const manifests = memoryManifestStore();
  const services = inMemoryContext({ clock: fixedClock(), manifests });
  const config: LoopConfig = {
    ...DEFAULT_CONFIG,
    taxpayers: [],
    tolerances: DEFAULT_TOLERANCES,
    ...overrides,
  };
  return { services, config, manifests };
}

describe('runNightly', () => {
  it('runs every stage exactly once and completes', async () => {
    const d = deps();
    const manifest = await runNightly(d, 'run-1');

    expect(manifest.status).toBe('completed');
    expect(manifest.finishedAt).not.toBeNull();
    expect(manifest.stages.map((s) => s.stage)).toEqual([...STAGES]);
  });

  it('terminates rather than spinning on a not_implemented stage', async () => {
    // Regression test for a real bug: driving off `nextStage` re-selected the same stage forever,
    // because `not_implemented` is deliberately not "completed" (a resume must retry it).
    const d = deps();
    const manifest = await runNightly(d, 'run-1');

    const notImplemented = manifest.stages.filter((s) => s.status === 'not_implemented');
    expect(notImplemented.length).toBeGreaterThan(0);
    expect(manifest.stages).toHaveLength(STAGES.length);
  });

  it('records a not_implemented stage honestly, never as ok', async () => {
    const d = deps();
    const manifest = await runNightly(d, 'run-1');
    const absorb = manifest.stages.find((s) => s.stage === 'absorb');

    expect(absorb?.status).toBe('not_implemented');
    expect(absorb?.detail).toContain('not implemented yet');
  });

  it('marks a legitimately idle stage as skipped, not ok', async () => {
    const d = deps({ taxpayers: [] });
    const manifest = await runNightly(d, 'run-1');
    const ingest = manifest.stages.find((s) => s.stage === 'ingest');

    expect(ingest?.status).toBe('skipped');
    expect(ingest?.summary).toContain('no taxpayers');
  });

  it('persists the manifest after every stage, so a crash is resumable', async () => {
    const d = deps();
    await runNightly(d, 'run-1');
    // initial save + one per stage + the final completion save
    expect(d.manifests.all.length).toBeGreaterThan(0);
    const saved = await d.manifests.load('run-1');
    expect(saved?.status).toBe('completed');
  });

  it('persists nothing on a dry run', async () => {
    const d = deps({ dryRun: true });
    const manifest = await runNightly(d, 'run-1');

    expect(manifest.status).toBe('completed');
    expect(await d.manifests.load('run-1')).toBeNull();
  });

  it('stamps the seed and dryRun flag for exact replay', async () => {
    const d = deps({ seed: 42, dryRun: false });
    const manifest = await runNightly(d, 'run-1');
    expect(manifest.seed).toBe(42);
    expect(manifest.dryRun).toBe(false);
  });
});

describe('fatal vs non-fatal stages', () => {
  const boom =
    (message: string): StageFn =>
    () => {
      throw new Error(message);
    };

  it('aborts the run when a FATAL stage fails', async () => {
    const d = deps();
    const manifest = await runNightly(
      { ...d, stages: { ingest: boom('SII: Su sesión ha expirado') } },
      'run-1',
    );

    expect(manifest.status).toBe('aborted');
    expect(manifest.stages.find((s) => s.stage === 'ingest')?.status).toBe('failed');
    // Nothing after a fatal ingest ran — evaluating against a partial night could promote wrongly.
    expect(manifest.stages.map((s) => s.stage)).toEqual(['ingest']);
  });

  it('continues past a NON-FATAL stage failure', async () => {
    const d = deps();
    const manifest = await runNightly(
      { ...d, stages: { mine: boom('cluster store offline') } },
      'run-1',
    );

    expect(manifest.status).toBe('completed');
    expect(manifest.stages.find((s) => s.stage === 'mine')?.status).toBe('failed');
    expect(manifest.stages).toHaveLength(STAGES.length);
  });

  it('passes an SII message through VERBATIM — never translated or summarised (ADR-004)', async () => {
    const d = deps();
    const message = 'Periodo consultado no válido, debe ser mayor igual a 201705';
    const manifest = await runNightly({ ...d, stages: { mine: boom(message) } }, 'run-1');

    expect(manifest.stages.find((s) => s.stage === 'mine')?.detail).toBe(message);
  });

  it('records what a successful stage changed', async () => {
    const d = deps();
    const ok: StageFn = async () => ({ summary: 'fetched 3 periods', changed: { artifacts: 12 } });
    const manifest = await runNightly({ ...d, stages: { ingest: ok } }, 'run-1');

    const ingest = manifest.stages.find((s) => s.stage === 'ingest');
    expect(ingest?.status).toBe('ok');
    expect(ingest?.changed['artifacts']).toBe(12);
  });

  it('refuses to persist a manifest carrying a client identifier', async () => {
    // The manifest is the artifact most likely to be pasted into a ticket, so the boundary check
    // runs at persist time rather than trusting every stage to keep its summary clean.
    const d = deps();
    // Synthetic, Mod-11-valid RUT (CONVENTIONS: real PII never lands in a tracked file).
    const leaky: StageFn = async () => ({
      summary: 'swept 11.111.111-1 for the period',
      changed: {},
    });
    await expect(runNightly({ ...d, stages: { ingest: leaky } }, 'run-1')).rejects.toThrow(
      /client identifier/,
    );
  });
});

describe('resume', () => {
  it('does not re-run stages that already completed', async () => {
    const d = deps({ taxpayers: [] });
    const first = await runNightly(d, 'run-1');

    const ingestFirst = first.stages.find((s) => s.stage === 'ingest');
    expect(ingestFirst?.status).toBe('skipped');

    // A completed run resumes to itself without re-executing.
    const resumed = await resumeNightly(d, 'run-1');
    expect(resumed.status).toBe('completed');
    expect(resumed.stages.find((s) => s.stage === 'ingest')?.startedAt).toBe(
      ingestFirst?.startedAt,
    );
  });

  it('throws for an unknown run', async () => {
    const d = deps();
    await expect(resumeNightly(d, 'nope')).rejects.toThrow(/no manifest/);
  });

  it('retries a not_implemented stage on resume — it is not "completed"', async () => {
    const d = deps();
    const first = await runNightly(d, 'run-1');
    const done = completedStages(first);

    expect(done.has('absorb')).toBe(false);
    // `nextStage` therefore points back at the first unfinished stage, which is what a resume runs.
    expect(nextStage(first)).toBe('absorb');
  });
});

describe('runStage', () => {
  it('replaces a prior outcome rather than appending a duplicate', async () => {
    const d = deps();
    const first = await runNightly(d, 'run-1');
    const again = await runStage(d, first, 'absorb');

    expect(again.stages.filter((s) => s.stage === 'absorb')).toHaveLength(1);
    expect(again.stages.map((s) => s.stage)).toEqual([...STAGES]);
  });
});

// ADR-044 — the loop splits into `fetch` (stage 1, needs a live session) and `learn` (stages 2–8,
// never touches SII). Only `ingest` needs a session: `extract` parses artifacts already in the
// store, which is what decouples the cadence of learning from access to SII.
describe('stage selection (ADR-044)', () => {
  const exploding: StageFn = () => {
    throw new Error('ingest ran — a learn run must never reach SII');
  };

  it('records an unselected stage as skipped with an explicit reason, never silently absent', async () => {
    const d = deps({ stages: LEARN_STAGES });
    const manifest = await runNightly({ ...d, stages: { ingest: exploding } }, 'run-1');

    const ingest = manifest.stages.find((s) => s.stage === 'ingest');
    // Present, not omitted: the manifest stays the honest account of the night (ADR-043).
    expect(ingest).toBeDefined();
    expect(ingest?.status).toBe('skipped');
    expect(ingest?.summary).toMatch(/not selected/i);
    expect(ingest?.detail).not.toBeNull();
    // Every stage still appears, in the fixed order.
    expect(manifest.stages.map((s) => s.stage)).toEqual([...STAGES]);
    expect(manifest.status).toBe('completed');
  });

  it('never invokes an unselected stage — so `learn` cannot construct a PortalDriver', async () => {
    const d = deps({ stages: LEARN_STAGES });
    // `exploding` throwing would surface as a `failed` ingest; a skip means it was never called.
    const manifest = await runNightly({ ...d, stages: { ingest: exploding } }, 'run-1');

    expect(manifest.stages.find((s) => s.stage === 'ingest')?.status).toBe('skipped');
    expect(manifest.stages.find((s) => s.stage === 'ingest')?.detail).not.toMatch(/ingest ran/);
  });

  it('runs ONLY ingest in fetch mode', async () => {
    const d = deps({ stages: FETCH_STAGES });
    const ok: StageFn = async () => ({ summary: 'fetched', changed: { artifacts: 3 } });
    const manifest = await runNightly({ ...d, stages: { ingest: ok } }, 'run-1');

    expect(manifest.stages.find((s) => s.stage === 'ingest')?.status).toBe('ok');
    for (const stage of LEARN_STAGES) {
      expect(manifest.stages.find((s) => s.stage === stage)?.status).toBe('skipped');
    }
  });

  it('runs every stage when no selection is given (current `run` behaviour)', async () => {
    const d = deps({ taxpayers: ['tp-alpha'] });
    const manifest = await runNightly(d, 'run-1');

    // Any status but `skipped` proves ingest was actually INVOKED rather than passed over by
    // selection. Asserted that way round so this keeps testing selection as the stage's own
    // implementation state changes underneath it.
    expect(manifest.stages.find((s) => s.stage === 'ingest')?.status).not.toBe('skipped');
  });

  it('distinguishes a NOT-SELECTED skip from an IDLE skip — both are `skipped`', async () => {
    // The one real ambiguity this design introduces: `skipped` now carries two meanings. A reader
    // (and stage 8's diff) must be able to tell "we chose not to run it" from "it ran and had
    // nothing to do", so the reason is always explicit.
    const idle = await runNightly(deps({ taxpayers: [] }), 'run-idle');
    const unselected = await runNightly(
      deps({ taxpayers: ['tp-alpha'], stages: LEARN_STAGES }),
      'run-learn',
    );

    const idleIngest = idle.stages.find((s) => s.stage === 'ingest');
    const unselectedIngest = unselected.stages.find((s) => s.stage === 'ingest');

    expect(idleIngest?.status).toBe('skipped');
    expect(unselectedIngest?.status).toBe('skipped');
    expect(idleIngest?.summary).not.toMatch(/not selected/i);
    expect(unselectedIngest?.summary).toMatch(/not selected/i);
  });
});

// `dataAsOf` is mandatory because a `learn` run works on artifacts that may be weeks old. A nightly
// report that looks current but rests on stale data is the confidently-wrong failure this package
// exists to prevent (ADR-044).
describe('dataAsOf', () => {
  const fetchManifest = (retrievedAt: string, taxpayer: string): FetchManifest => ({
    contentHash: contentHash('a'.repeat(64)),
    url: 'https://www4.sii.cl/propuestaf29ui/services/data/facadeService/obtieneDatosF29',
    transport: 'requestJson',
    httpStatus: 200,
    retrievedAt: instant(retrievedAt),
    contentType: 'application/json',
    byteLength: 1024,
    durationMs: 250,
    requestFingerprint: null,
    taxpayer,
    runId: 'seed-run',
  });

  it('is the NEWEST retrievedAt among the artifacts the run considered', async () => {
    const d = deps({ taxpayers: ['tp-alpha'] });
    await d.services.artifacts.putManifest(fetchManifest('2026-07-01T12:00:00.000Z', 'tp-alpha'));
    await d.services.artifacts.putManifest(fetchManifest('2026-08-04T09:30:00.000Z', 'tp-alpha'));
    await d.services.artifacts.putManifest(fetchManifest('2026-06-15T08:00:00.000Z', 'tp-alpha'));

    const manifest = await runNightly(d, 'run-1');

    expect(manifest.dataAsOf).toBe('2026-08-04T09:30:00.000Z');
  });

  it('is null — never a date, never 0 — when the run considered no artifacts', async () => {
    const d = deps({ taxpayers: ['tp-alpha'] });
    const manifest = await runNightly(d, 'run-1');

    expect(manifest.dataAsOf).toBeNull();
  });

  it('ignores artifacts belonging to a taxpayer this run did not sweep', async () => {
    const d = deps({ taxpayers: ['tp-alpha'] });
    await d.services.artifacts.putManifest(fetchManifest('2026-07-01T12:00:00.000Z', 'tp-alpha'));
    // Newer, but a different subject — reporting it would date this run's data to someone else's.
    await d.services.artifacts.putManifest(fetchManifest('2026-08-09T12:00:00.000Z', 'tp-beta'));

    const manifest = await runNightly(d, 'run-1');

    expect(manifest.dataAsOf).toBe('2026-07-01T12:00:00.000Z');
  });

  it('is visible to the REPORT stage during the run, not only in the final manifest', async () => {
    // Live gap 2026-08-10: `dataAsOf` was computed only at finalization, AFTER stage 8 had run,
    // so the production report always printed "no artifacts were considered" even when the sweep
    // had landed hours earlier — W7's obligation (the report LEADS with dataAsOf) was
    // undischargeable outside tests, which hand the stage an already-finalized manifest.
    const d = deps({ taxpayers: ['tp-alpha'], stages: LEARN_STAGES });
    await d.services.artifacts.putManifest(fetchManifest('2026-08-04T09:30:00.000Z', 'tp-alpha'));

    const manifest = await runNightly(d, 'run-1');
    const report = manifest.stages.find((s) => s.stage === 'report');

    expect(report?.summary).toContain('2026-08-04');
    expect(report?.summary).not.toMatch(/no artifacts/i);
  });

  it('is recorded even when a fatal stage aborts the run', async () => {
    const d = deps({ taxpayers: ['tp-alpha'] });
    await d.services.artifacts.putManifest(fetchManifest('2026-07-01T12:00:00.000Z', 'tp-alpha'));
    const boom: StageFn = () => {
      throw new Error('SII: Su sesión ha expirado');
    };

    const manifest = await runNightly({ ...d, stages: { ingest: boom } }, 'run-1');

    expect(manifest.status).toBe('aborted');
    expect(manifest.dataAsOf).toBe('2026-07-01T12:00:00.000Z');
  });
});
