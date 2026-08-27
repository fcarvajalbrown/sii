// Stage 8 — REPORT (ADR-043 + ADR-044's `dataAsOf` obligation).
//
// TWO PROPERTIES, both about a report that reads as reassuring when it should not:
//
//   * It is a DIFF. "extraction accuracy 0.981" every night is noise nobody reads; the movement is
//     the sentence. And a first run's delta is `null`, never 0 — "no change" and "nothing to
//     compare against" are different claims.
//   * It LEADS with how old the data is. A `learn` run works on artifacts that may be weeks old,
//     so a report that looks current while resting on stale data is the confidently-wrong failure
//     ADR-044 created `dataAsOf` to prevent. An OPEN period whose newest artifact predates today
//     is marked NOT VERIFIED TODAY rather than presented as current state.

import { describe, expect, it } from 'vitest';
import { DEFAULT_TOLERANCES } from '../../eval/gate.js';
import { DEFAULT_CONFIG } from '../orchestrator.js';
import { fixedClock, inMemoryContext, memoryEvalResultStore } from '../in-memory.js';
import { reportStage } from './report.js';
import type { EvalResult } from '../../eval/result.js';
import type { LoopContext } from '../context.js';
import type { RunManifest, StageOutcome } from '../manifest.js';

const NOW = '2026-08-10T03:00:00.000Z';

const evalResult = (runId: string, over: Partial<EvalResult> = {}): EvalResult => ({
  runId,
  evaluatedAt: '2026-08-10T03:00:00.000Z',
  goldenSetVersion: 'g1',
  strategyVersions: [],
  ruleSetVersion: 'r1',
  engagements: ['eng-1'],
  extraction: { fieldsCompared: 188, fieldsCorrect: 188, accuracy: 1, byStrategy: {} },
  normativa: { expectedAnchors: 10, heldAnchors: 0, coverage: null, misdatedCitations: 0 },
  findings: {
    truePositives: 0,
    falsePositives: 0,
    falseNegatives: 0,
    precision: null,
    recall: null,
    f1: null,
  },
  ...over,
});

const stage = (name: string, status: StageOutcome['status']): StageOutcome => ({
  stage: name as StageOutcome['stage'],
  status,
  startedAt: NOW,
  finishedAt: NOW,
  durationMs: 0,
  summary: `${name} ran`,
  changed: {},
  detail: null,
});

const manifest = (over: Partial<RunManifest> = {}): RunManifest => ({
  runId: 'run-today',
  startedAt: NOW,
  finishedAt: NOW,
  status: 'completed',
  taxpayers: ['tp-alpha'],
  ruleSetVersion: 'r1',
  strategyVersions: [],
  goldenSetVersion: 'g1',
  seed: 1,
  dryRun: false,
  dataAsOf: '2026-08-10T01:00:00.000Z',
  resumedFrom: null,
  stages: [stage('extract', 'ok'), stage('evaluate', 'ok')],
  ...over,
});

async function harness(opts: {
  readonly current: RunManifest;
  readonly prior?: RunManifest;
  readonly evals?: readonly EvalResult[];
  readonly queueDepth?: number;
}): Promise<{ ctx: LoopContext; report: () => Promise<unknown> }> {
  const services = inMemoryContext({ clock: fixedClock(NOW, 0) });
  const evalResults = memoryEvalResultStore();
  for (const e of opts.evals ?? []) await evalResults.put(e);

  const manifests = {
    ...services.manifests,
    recent: async (limit: number) =>
      [opts.current, ...(opts.prior ? [opts.prior] : [])].slice(0, limit),
  };

  const ctx: LoopContext = {
    ...services,
    manifests,
    evalResults,
    runId: opts.current.runId,
    config: { ...DEFAULT_CONFIG, taxpayers: ['tp-alpha'], tolerances: DEFAULT_TOLERANCES },
    manifest: () => opts.current,
  };
  return { ctx, report: async () => (await reportStage(ctx)).changed };
}

describe('it leads with how old the data is (ADR-044)', () => {
  it('reports dataAsOf and its age in days', async () => {
    const h = await harness({ current: manifest({ dataAsOf: '2026-08-04T09:00:00.000Z' }) });
    const result = await reportStage(h.ctx);
    // 2026-08-04 → 2026-08-10 is six calendar days.
    expect(result.summary).toContain('2026-08-04');
    expect(result.changed['dataAgeDays']).toBe(6);
  });

  it('marks the OPEN period NOT VERIFIED TODAY when the newest artifact predates today', async () => {
    const h = await harness({ current: manifest({ dataAsOf: '2026-08-04T09:00:00.000Z' }) });
    const result = await reportStage(h.ctx);
    expect(result.summary).toMatch(/not verified today/i);
    expect(result.changed['openPeriodVerifiedToday']).toBe(0);
  });

  it('counts CALENDAR days, so yesterday evening is not "today"', async () => {
    // Elapsed-hours flooring gets this wrong in the dangerous direction: 23:00 yesterday read at
    // 03:00 today is four hours old, floors to 0, and 0 reads as "verified today". It was not.
    const h = await harness({ current: manifest({ dataAsOf: '2026-08-09T23:00:00.000Z' }) });
    const result = await reportStage(h.ctx);
    expect(result.changed['dataAgeDays']).toBe(1);
    expect(result.changed['openPeriodVerifiedToday']).toBe(0);
  });

  it('says the open period IS verified when the data is from today', async () => {
    const h = await harness({ current: manifest({ dataAsOf: '2026-08-10T01:00:00.000Z' }) });
    const result = await reportStage(h.ctx);
    expect(result.changed['openPeriodVerifiedToday']).toBe(1);
    expect(result.summary).not.toMatch(/not verified today/i);
  });

  it('never claims the open period is verified when there is NO data at all', async () => {
    // `dataAsOf: null` means the run considered no artifacts. Reporting "verified" there would be
    // the worst of the three answers.
    const h = await harness({ current: manifest({ dataAsOf: null }) });
    const result = await reportStage(h.ctx);
    expect(result.changed['openPeriodVerifiedToday']).toBe(0);
    expect(result.changed['dataAgeDays']).toBeNull();
    expect(result.summary).toMatch(/no artifacts/i);
  });
});

describe('it is a diff, not a status dump', () => {
  // Stage 6 persists a run's baseline under `${runId}-baseline` (`baselineRunId`), never under the
  // bare runId — the fixtures below store what the real stage stores, so these tests fail if the
  // report looks the result up under the wrong id.

  it('reports the MOVEMENT between two eval results', async () => {
    const h = await harness({
      current: manifest(),
      prior: manifest({ runId: 'run-yesterday' }),
      evals: [
        evalResult('run-yesterday-baseline', {
          evaluatedAt: '2026-08-09T03:00:00.000Z',
          extraction: { fieldsCompared: 188, fieldsCorrect: 180, accuracy: 0.9574, byStrategy: {} },
        }),
        evalResult('run-today-baseline'),
      ],
    });
    const result = await reportStage(h.ctx);
    expect(result.summary).toContain('extraction.accuracy');
    expect(result.changed['metricsImproved']).toBe(1);
  });

  it('finds the eval its OWN run persisted — under the -baseline id, like the gate does', async () => {
    // Live bug 2026-08-10: the first production run with registered strategies measured accuracy
    // 1.0 and persisted it, and the report in the SAME run still printed "unmeasured:
    // extraction.accuracy" — it looked up the bare runId while stage 6 writes `${runId}-baseline`.
    // gate.ts already used `baselineRunId`; the report did not. The dangerous direction is a real
    // regression reading as "unmeasured" instead of "regressed".
    const h = await harness({ current: manifest(), evals: [evalResult('run-today-baseline')] });
    const result = await reportStage(h.ctx);
    // Accuracy measured (only the three structurally-null metrics remain unmeasured).
    expect(result.changed['metricsUnmeasured']).toBe(3);
    expect(result.summary).not.toContain('extraction.accuracy');
  });

  it('reports a first run’s delta as NULL, never 0', async () => {
    // "No change" and "nothing to compare against" are different claims, and 0 asserts the first.
    const h = await harness({ current: manifest(), evals: [evalResult('run-today-baseline')] });
    const result = await reportStage(h.ctx);
    expect(result.changed['metricsImproved']).toBe(0);
    expect(result.changed['metricsRegressed']).toBe(0);
    expect(result.summary).toMatch(/no prior run/i);
  });

  it('counts a regression separately from an improvement', async () => {
    const h = await harness({
      current: manifest(),
      prior: manifest({ runId: 'run-yesterday' }),
      evals: [
        evalResult('run-yesterday-baseline'),
        evalResult('run-today-baseline', {
          extraction: { fieldsCompared: 188, fieldsCorrect: 170, accuracy: 0.9043, byStrategy: {} },
        }),
      ],
    });
    const result = await reportStage(h.ctx);
    expect(result.changed['metricsRegressed']).toBe(1);
  });

  it('leaves an unmeasurable metric out of both counts', async () => {
    // `normativa.coverage` and the finding metrics are structurally null until a corpus and a
    // ground-truth file exist. Counting null→null as "unchanged" would imply it was measured.
    const h = await harness({
      current: manifest(),
      prior: manifest({ runId: 'run-yesterday' }),
      evals: [evalResult('run-yesterday-baseline'), evalResult('run-today-baseline')],
    });
    const result = await reportStage(h.ctx);
    expect(result.changed['metricsUnmeasured']).toBe(3);
  });
});

describe('a partial night is never reported as a whole one', () => {
  it('names the stages that did not complete', async () => {
    const h = await harness({
      current: manifest({
        stages: [stage('extract', 'ok'), stage('mine', 'not_implemented'), stage('gate', 'failed')],
      }),
    });
    const result = await reportStage(h.ctx);
    expect(result.changed['incompleteStages']).toBe(2);
    expect(result.summary).toContain('mine');
    expect(result.summary).toContain('gate');
  });
});

describe('the confidentiality boundary', () => {
  it('does not carry stage DETAIL, so an SII message cannot smuggle a RUT into the report', async () => {
    // The report is the artifact most likely to be pasted into a ticket. Stage details hold SII's
    // verbatim messages, which can name a taxpayer — so the report names the failed stages and
    // deliberately does not reproduce what they said. The detail stays in the manifest, inside
    // the boundary, where a human can go and read it.
    const h = await harness({
      current: manifest({
        // Synthetic, Mod-11-valid RUT (CONVENTIONS: real PII never lands in a tracked file).
        stages: [{ ...stage('extract', 'failed'), detail: 'falló para 11.111.111-1' }],
      }),
    });
    const result = await reportStage(h.ctx);
    expect(result.summary).toContain('extract');
    expect(result.summary).not.toContain('11.111.111-1');
  });

  it('still runs the boundary check over everything it DOES carry', async () => {
    // Defence in depth: the shape is safe today, but the guard is what keeps a future field from
    // quietly widening it.
    const h = await harness({ current: manifest({ runId: 'run-for-11.111.111-1' }) });
    await expect(reportStage(h.ctx)).rejects.toThrow(/client identifier/);
  });
});
