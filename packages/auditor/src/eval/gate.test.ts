import { describe, expect, it } from 'vitest';
import { DEFAULT_TOLERANCES, approvalFor, evaluateGate } from './gate.js';
import type { EvalResult } from './result.js';

/** Minimal result with the four target metrics settable. Everything else is inert. */
function result(
  overrides: Partial<{
    accuracy: number | null;
    coverage: number | null;
    precision: number | null;
    recall: number | null;
    engagements: readonly string[];
    goldenSetVersion: string;
    runId: string;
  }> = {},
): EvalResult {
  return {
    runId: overrides.runId ?? 'run-1',
    evaluatedAt: '2026-08-06T03:00:00.000Z',
    goldenSetVersion: overrides.goldenSetVersion ?? 'golden-v1',
    ruleSetVersion: 'rules-v1',
    strategyVersions: ['rcv-detalle@1'],
    engagements: overrides.engagements ?? ['eng-1'],
    extraction: {
      fieldsCompared: 100,
      fieldsCorrect: 98,
      accuracy: overrides.accuracy === undefined ? 0.98 : overrides.accuracy,
      byStrategy: {},
      routedToReview: 0,
      failures: 0,
    },
    normativa: {
      expectedAnchors: 10,
      heldAnchors: 5,
      coverage: overrides.coverage === undefined ? 0.5 : overrides.coverage,
      misdatedCitations: 0,
    },
    findings: {
      truePositives: 8,
      falsePositives: 2,
      falseNegatives: 2,
      precision: overrides.precision === undefined ? 0.8 : overrides.precision,
      recall: overrides.recall === undefined ? 0.8 : overrides.recall,
      f1: 0.8,
      materialityWeightedRecall: null,
    },
    durationMs: 1000,
  };
}

describe('evaluateGate', () => {
  it('fails closed when no golden engagements were evaluated', () => {
    // An empty suite vacuously satisfies "no regression" — the naive gate would promote everything
    // on exactly the night the golden set is misconfigured.
    const decision = evaluateGate(result({ engagements: [] }), result());
    expect(decision.verdict).toBe('reject');
    expect(decision.reason).toBe('no_golden_set');
  });

  it('fails closed when the golden-set version is blank', () => {
    const decision = evaluateGate(result({ goldenSetVersion: '  ' }), result());
    expect(decision.reason).toBe('no_golden_set');
  });

  it('rejects on a first run, since there is no baseline to improve against', () => {
    const decision = evaluateGate(result(), null);
    expect(decision.verdict).toBe('reject');
    expect(decision.reason).toBe('no_baseline');
  });

  it('rejects a change that improves nothing, even if it harms nothing', () => {
    const decision = evaluateGate(result(), result());
    expect(decision.verdict).toBe('reject');
    expect(decision.reason).toBe('no_improvement');
  });

  it('promotes a change that improves a metric with no regression', () => {
    const decision = evaluateGate(result({ accuracy: 0.99 }), result({ accuracy: 0.98 }));
    expect(decision.verdict).toBe('promote');
    expect(decision.explanation).toContain('extraction.accuracy');
  });

  it('rejects a regression beyond tolerance', () => {
    // findings.precision tolerance is 0.01; a 0.10 drop is well past it.
    const decision = evaluateGate(
      result({ accuracy: 0.99, precision: 0.7 }),
      result({ accuracy: 0.98, precision: 0.8 }),
    );
    expect(decision.verdict).toBe('reject');
    expect(decision.reason).toBe('regression_beyond_tolerance');
  });

  it('refuses to trade a higher-priority metric for a lower-priority one, even inside tolerance', () => {
    // Extraction accuracy dips 0.005 (inside a widened tolerance) while precision gains 0.10.
    // Everything downstream derives from extraction, so this trade is not available.
    const tolerances = { ...DEFAULT_TOLERANCES, 'extraction.accuracy': 0.05 };
    const decision = evaluateGate(
      result({ accuracy: 0.975, precision: 0.9 }),
      result({ accuracy: 0.98, precision: 0.8 }),
      tolerances,
    );
    expect(decision.verdict).toBe('reject');
    expect(decision.reason).toBe('priority_violation');
  });

  it('allows a lower-priority gain when nothing higher-priority regressed', () => {
    const decision = evaluateGate(result({ precision: 0.9 }), result({ precision: 0.8 }));
    expect(decision.verdict).toBe('promote');
  });

  it('treats losing measurability as a regression, never as a zero', () => {
    const decision = evaluateGate(result({ coverage: null }), result({ coverage: 0.5 }));
    expect(decision.verdict).toBe('reject');
    const coverage = decision.comparisons.find((c) => c.metric === 'normativa.coverage');
    expect(coverage?.movement).toBe('regressed');
    expect(coverage?.beyondTolerance).toBe(true);
    expect(coverage?.delta).toBeNull();
  });

  it('treats gaining measurability as an improvement', () => {
    const decision = evaluateGate(result({ coverage: 0.3 }), result({ coverage: null }));
    expect(decision.verdict).toBe('promote');
  });

  it('does not promote on float noise below MIN_IMPROVEMENT', () => {
    const decision = evaluateGate(result({ accuracy: 0.980_05 }), result({ accuracy: 0.98 }));
    expect(decision.reason).toBe('no_improvement');
  });
});

describe('approvalFor', () => {
  it('carries the evidence a promotion needs', () => {
    const decision = evaluateGate(result({ accuracy: 0.99 }), result({ accuracy: 0.98 }));
    const approval = approvalFor(decision, 'rule-x@2');
    expect(approval.verdict).toBe('promote');
    expect(approval.subject).toBe('rule-x@2');
    expect(approval.goldenSetVersion).toBe('golden-v1');
    expect(approval.deltas['extraction.accuracy']).toBeCloseTo(0.01, 4);
  });

  it('carries the reason on a rejection', () => {
    const decision = evaluateGate(result(), null);
    const approval = approvalFor(decision, 'rule-x@2');
    expect(approval.verdict).toBe('reject');
    expect(approval.reason).toContain('baseline');
  });
});
