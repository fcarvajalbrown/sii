// Stage 1 — INGEST (ADR-043), the `fetch` half of ADR-044.
//
// THE PROPERTIES UNDER TEST, all about not losing a night's work to one bad subject:
//   * taxpayers are swept SEQUENTIALLY (ADR-005: one live session at a time), each recording under
//     its OWN pseudonymous key — artifacts filed under the wrong subject are worse than missing;
//   * a failure on taxpayer 2 does not abort taxpayer 3;
//   * a per-step SII error stops the STEP, a session error stops that TAXPAYER, and neither stops
//     the sweep (CONVENTIONS: "a per-item SII error stops the item, not the batch");
//   * SII's message survives verbatim, and nothing is ever retried after a failure.

import { describe, expect, it } from 'vitest';
import { NotAuthenticatedError, SessionExpiredError } from '@dostertags/sii-core';
import type { Runtime } from '@dostertags/sii-core';
import { memoryArtifactStore } from '../../store/memory.js';
import { DEFAULT_TOLERANCES } from '../../eval/gate.js';
import { DEFAULT_CONFIG } from '../orchestrator.js';
import { fixedClock, inMemoryContext } from '../in-memory.js';
import { ingestStage } from './ingest.js';
import type { FetchStep } from './ingest.js';
import type { LoopContext } from '../context.js';

/** A step that records one artifact through the recording driver, like a real facade would. */
const recordingStep = (id: string): FetchStep => ({
  id,
  describes: `test step ${id}`,
  async run(runtime) {
    await runtime.portal.requestPublic({ url: `https://palena.sii.cl/${id}` });
  },
});

const failingStep = (id: string, err: Error): FetchStep => ({
  id,
  describes: `failing ${id}`,
  async run() {
    throw err;
  },
});

/** Counts invocations, so "never retried" is checkable rather than assumed. */
function countingStep(id: string, err?: Error): FetchStep & { calls: number } {
  const step = {
    id,
    describes: `counting ${id}`,
    calls: 0,
    async run() {
      step.calls += 1;
      if (err) throw err;
    },
  };
  return step;
}

interface Harness {
  readonly ctx: LoopContext;
  readonly artifacts: ReturnType<typeof memoryArtifactStore>;
}

function harness(taxpayers: readonly string[], plan: readonly FetchStep[]): Harness {
  const artifacts = memoryArtifactStore();
  const services = inMemoryContext({ clock: fixedClock() });

  // A base runtime whose public fetch succeeds — the recorder tees it into the store. The
  // in-memory context's runtime is deliberately unreachable, so the fetch path is substituted here.
  const base: Runtime = {
    ...services.runtime,
    portal: {
      ...services.runtime.portal,
      requestPublic: async () =>
        ({
          url: 'https://palena.sii.cl/x',
          status: 200,
          body: '<ok/>',
          contentType: 'text/xml',
        }) as never,
    },
  };

  const ctx: LoopContext = {
    ...services,
    runtime: base,
    sessionSubject: async () => null,
    artifacts,
    fetchPlan: plan,
    runId: 'run-1',
    // These cases exercise the multi-taxpayer failure-isolation logic, which a single real
    // session can never reach (ADR-006 keeps login interactive, so N subjects is N logins). The
    // attribution guard has its own describe block below, where it is explicitly ON.
    config: {
      ...DEFAULT_CONFIG,
      taxpayers,
      tolerances: DEFAULT_TOLERANCES,
      requireSessionMatch: false,
    },
    manifest: () => ({
      runId: 'run-1',
      startedAt: '2026-08-06T03:00:00.000Z',
      finishedAt: null,
      status: 'running',
      taxpayers: [...taxpayers],
      ruleSetVersion: 'x',
      strategyVersions: [],
      goldenSetVersion: null,
      seed: 1,
      dryRun: false,
      dataAsOf: null,
      resumedFrom: null,
      stages: [],
    }),
  };

  return { ctx, artifacts };
}

describe('the sweep', () => {
  it('is idle when no taxpayers are configured', async () => {
    const result = await ingestStage(harness([], [recordingStep('a')]).ctx);
    expect(result.idle).toBe(true);
  });

  it('files each taxpayer’s artifacts under that taxpayer’s OWN key', async () => {
    // Filing evidence under the wrong subject is worse than not capturing it: every downstream
    // figure would be attributed to someone who never had it.
    const h = harness(['tp-alpha', 'tp-beta'], [recordingStep('rcv')]);
    await ingestStage(h.ctx);

    const alpha = await h.artifacts.findManifests({ taxpayer: 'tp-alpha' });
    const beta = await h.artifacts.findManifests({ taxpayer: 'tp-beta' });
    expect(alpha).toHaveLength(1);
    expect(beta).toHaveLength(1);
  });

  it('sweeps taxpayers SEQUENTIALLY, in a deterministic order', async () => {
    const order: string[] = [];
    const spy: FetchStep = {
      id: 'spy',
      describes: 'records the sweep order',
      async run(runtime, scope) {
        order.push(scope.taxpayer);
        await runtime.portal.requestPublic({ url: 'https://palena.sii.cl/spy' });
      },
    };
    const h = harness(['tp-zeta', 'tp-alpha'], [spy]);
    await ingestStage(h.ctx);

    // Sorted, not configuration order — two identical runs must sweep in the same sequence, or a
    // run-to-run diff of the artifacts is iteration-order noise rather than signal.
    expect(order).toEqual(['tp-alpha', 'tp-zeta']);
  });

  it('counts recorded artifacts, which is what bounds stage 2', async () => {
    const h = harness(['tp-alpha'], [recordingStep('a'), recordingStep('b')]);
    const result = await ingestStage(h.ctx);
    expect(result.changed['artifacts']).toBe(2);
  });
});

describe('failure isolation', () => {
  it('a failure on taxpayer 2 does not abort taxpayer 3', async () => {
    // The roadmap's named case.
    const boom = new Error('SII: servicio no disponible');
    const step: FetchStep = {
      id: 'flaky',
      describes: 'fails only for tp-beta',
      async run(runtime, scope) {
        if (scope.taxpayer === 'tp-beta') throw boom;
        await runtime.portal.requestPublic({ url: 'https://palena.sii.cl/ok' });
      },
    };
    const h = harness(['tp-alpha', 'tp-beta', 'tp-gamma'], [step]);
    const result = await ingestStage(h.ctx);

    expect((await h.artifacts.findManifests({ taxpayer: 'tp-gamma' })).length).toBe(1);
    expect(result.changed['taxpayersFailed']).toBe(1);
    expect(result.changed['taxpayersSwept']).toBe(3);
  });

  it('a per-step SII error stops the STEP, not the taxpayer’s remaining steps', async () => {
    // CONVENTIONS: in a fan-out, a per-item error stops the item and the rest continue.
    const h = harness(
      ['tp-alpha'],
      [failingStep('broken', new Error('Periodo consultado no válido')), recordingStep('good')],
    );
    const result = await ingestStage(h.ctx);

    expect(result.changed['artifacts']).toBe(1);
    expect(result.changed['stepsFailed']).toBe(1);
  });

  it('a SESSION error stops that taxpayer’s remaining steps', async () => {
    // A dead session will fail every subsequent call identically; continuing would hammer SII for
    // nothing and bury the real cause under N copies of the same error.
    const later = countingStep('later');
    const h = harness(
      ['tp-alpha'],
      [failingStep('first', new SessionExpiredError('sesión expirada')), later],
    );
    // The single subject recorded nothing, so the stage also aborts — that is the next test's
    // property. Here the point is only that the later step was never reached.
    await expect(ingestStage(h.ctx)).rejects.toThrow();

    expect(later.calls).toBe(0);
  });

  it('but a session error on one taxpayer does NOT stop the next one', async () => {
    // Each taxpayer has its own session (ADR-005), so one dead session says nothing about another.
    const step: FetchStep = {
      id: 'per-subject',
      describes: 'session dies only for alpha',
      async run(runtime, scope) {
        if (scope.taxpayer === 'tp-alpha') throw new NotAuthenticatedError('no hay sesión');
        await runtime.portal.requestPublic({ url: 'https://palena.sii.cl/ok' });
      },
    };
    const h = harness(['tp-alpha', 'tp-beta'], [step]);
    await ingestStage(h.ctx);

    expect((await h.artifacts.findManifests({ taxpayer: 'tp-beta' })).length).toBe(1);
  });

  it('passes SII’s message through VERBATIM (ADR-004)', async () => {
    // Both on the summary of a partial night and on the abort of a total one.
    const message = 'Periodo consultado no válido, debe ser mayor igual a 201705';
    const partial = harness(
      ['tp-alpha'],
      [failingStep('broken', new Error(message)), recordingStep('good')],
    );
    expect((await ingestStage(partial.ctx)).summary).toContain(message);

    const total = harness(['tp-alpha'], [failingStep('broken', new Error(message))]);
    await expect(ingestStage(total.ctx)).rejects.toThrow(message);
  });

  it('FAILS the stage when every taxpayer failed — that is not a partial night', async () => {
    // Usually means nobody logged in. `ingest` is fatal so the run aborts here rather than letting
    // `evaluate`/`gate` reason about a store that gained nothing. Reporting `ok` with zero
    // artifacts would read downstream as "there was nothing new", a different claim entirely.
    const h = harness(['tp-alpha', 'tp-beta'], [failingStep('x', new Error('SII: sin servicio'))]);
    await expect(ingestStage(h.ctx)).rejects.toThrow(/all 2 taxpayer\(s\) failed/);
  });

  it('does NOT fail the stage when at least one taxpayer succeeded', async () => {
    const step: FetchStep = {
      id: 'partial',
      describes: 'fails for alpha only',
      async run(runtime, scope) {
        if (scope.taxpayer === 'tp-alpha') throw new Error('SII: sin servicio');
        await runtime.portal.requestPublic({ url: 'https://palena.sii.cl/ok' });
      },
    };
    const h = harness(['tp-alpha', 'tp-beta'], [step]);
    const result = await ingestStage(h.ctx);
    expect(result.changed['artifacts']).toBe(1);
  });

  it('NEVER retries a failed step', async () => {
    // ADR-004: a block is server-side and timed. Retrying is the one thing that makes it worse.
    const step = countingStep('blocked', new Error('SII: demasiadas solicitudes'));
    const h = harness(['tp-alpha'], [step]);
    await ingestStage(h.ctx).catch(() => undefined);
    expect(step.calls).toBe(1);
  });
});

describe('pacing (ADR-004)', () => {
  it('sleeps between calls rather than hammering SII', async () => {
    let sleeps = 0;
    const services = inMemoryContext({ clock: fixedClock() });
    const h = harness(['tp-alpha'], [recordingStep('a'), recordingStep('b')]);
    const ctx: LoopContext = {
      ...h.ctx,
      clock: {
        ...services.clock,
        now: services.clock.now,
        sleep: async () => {
          sleeps += 1;
        },
      },
    };
    await ingestStage(ctx);
    expect(sleeps).toBeGreaterThan(0);
  });
});

// The blocker a live run exposed: session-keyed surfaces (F22, F29, situación) ALWAYS read the
// login principal (ADR-005). Sweeping subject X while authenticated as Y therefore files Y's real
// responses under X's key — the exact "evidence attributed to the wrong subject" failure this
// stage's header warns about, and it is silent. Nothing compared the two until now.
describe('session attribution', () => {
  const withSession = (h: Harness, sessionSubject: string | null): LoopContext => ({
    ...h.ctx,
    sessionSubject: async () => sessionSubject,
    config: { ...h.ctx.config, requireSessionMatch: true },
  });

  it('sweeps the subject the session actually belongs to', async () => {
    const h = harness(['tp-alpha'], [recordingStep('rcv')]);
    const result = await ingestStage(withSession(h, 'tp-alpha'));

    expect(result.changed['artifacts']).toBe(1);
    expect(result.changed['taxpayersSkipped']).toBe(0);
  });

  it('SKIPS a subject the session does not belong to, and records NOTHING for it', async () => {
    const h = harness(['tp-alpha', 'tp-beta'], [recordingStep('rcv')]);
    const result = await ingestStage(withSession(h, 'tp-alpha'));

    // The bug: tp-beta must not receive tp-alpha's data.
    expect(await h.artifacts.findManifests({ taxpayer: 'tp-beta' })).toEqual([]);
    expect(result.changed['taxpayersSkipped']).toBe(1);
    expect(result.changed['artifacts']).toBe(1);
  });

  it('says what to do about a skipped subject', async () => {
    const h = harness(['tp-alpha', 'tp-beta'], [recordingStep('rcv')]);
    const result = await ingestStage(withSession(h, 'tp-alpha'));
    expect(result.summary).toMatch(/auth login/i);
  });

  it('THROWS when no configured subject matches the session', async () => {
    // Nothing could be swept. Reporting ok would say "there was nothing new" about a night that
    // never looked at anything.
    const h = harness(['tp-alpha'], [recordingStep('rcv')]);
    await expect(ingestStage(withSession(h, 'tp-gamma'))).rejects.toThrow(/no configured subject/i);
  });

  it('THROWS when the session principal cannot be determined — never guesses', async () => {
    // Without knowing who is logged in there is no way to attribute what comes back, and
    // misattributed evidence is worse than none.
    const h = harness(['tp-alpha'], [recordingStep('rcv')]);
    await expect(ingestStage(withSession(h, null))).rejects.toThrow(/cannot determine/i);
  });

  it('is ON by default — the guard is not opt-in', async () => {
    // A correctness check nobody remembers to enable is not a check.
    const h = harness(['tp-alpha'], [recordingStep('rcv')]);
    // Build the config WITHOUT the flag at all, so this proves the default rather than inheriting
    // the harness opt-out.
    const { requireSessionMatch: _omitted, ...bare } = h.ctx.config;
    const ctx: LoopContext = {
      ...h.ctx,
      config: bare as typeof h.ctx.config,
      sessionSubject: async () => null,
    };
    await expect(ingestStage(ctx)).rejects.toThrow(/cannot determine/i);
  });
});
