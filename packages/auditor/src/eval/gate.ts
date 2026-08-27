// The regression gate (ADR-043 §I4) — IMPLEMENTED. The only path into production behaviour.
//
// THE RULE, from the brief: promote only what improves at least one target metric without
// regressing the others beyond tolerance. Three refinements make that operational rather than
// aspirational, each stated here because each is a judgement call a future reader deserves to see:
//
//  1. NO GOLDEN SET ⇒ REJECT EVERYTHING. An empty suite vacuously satisfies "no regression", so a
//     naive gate promotes every candidate on the night the golden set is missing or misconfigured
//     — the worst possible moment. Failing closed is the same instinct ADR-034 applied to the GWT
//     decoder: prefer the path that fails loudly over the one that can pass silently and lie.
//
//  2. NO BASELINE ⇒ REJECT EVERYTHING. On a first-ever run there is nothing to improve against.
//     The run establishes the baseline; it does not promote against itself.
//
//  3. PRIORITY IS ENFORCED, NOT DECORATIVE. The brief orders the targets: extraction accuracy,
//     then normativa coverage, then finding quality. So a gain in a LOWER-priority metric may not
//     buy a loss in a HIGHER-priority one, even a loss within tolerance. Concretely: a change that
//     lifts finding precision while nudging extraction accuracy down is REJECTED. Everything
//     downstream is derived from extraction, so trading it away is trading the foundation for the
//     view — and a tolerance band would let that happen a little every night, indefinitely.
//
// `null` is handled explicitly everywhere: an unmeasurable metric is not a zero. Losing the
// ability to measure something counts as a regression, and gaining it counts as an improvement.

import { TARGET_METRICS, metricValue } from './result.js';
import type { EvalResult, TargetMetric } from './result.js';
import type { GateApproval } from '../rules/promotion.js';

/** Maximum tolerated DROP per metric, in absolute metric units (these metrics are all ratios). */
export type Tolerances = Readonly<Record<TargetMetric, number>>;

/**
 * Defaults. Extraction is zero-tolerance for the reason in refinement 3 above. The others allow a
 * sliver of noise, since precision and recall over a small golden set move in visible steps as one
 * finding flips.
 */
export const DEFAULT_TOLERANCES: Tolerances = {
  'extraction.accuracy': 0,
  'normativa.coverage': 0,
  'findings.precision': 0.01,
  'findings.recall': 0.01,
};

/** A change must beat this to count as an improvement, so float noise cannot promote anything. */
export const MIN_IMPROVEMENT = 0.001;

export type MetricMovement = 'improved' | 'regressed' | 'unchanged' | 'unmeasurable';

export interface MetricComparison {
  readonly metric: TargetMetric;
  /** Priority index — 0 is highest. Mirrors `TARGET_METRICS` order. */
  readonly priority: number;
  readonly baseline: number | null;
  readonly candidate: number | null;
  /** `candidate - baseline`, or `null` when either side is unmeasurable. */
  readonly delta: number | null;
  readonly movement: MetricMovement;
  /** True when the drop exceeds this metric's tolerance. */
  readonly beyondTolerance: boolean;
}

export interface GateDecision {
  readonly verdict: 'promote' | 'reject';
  /** Machine-readable cause. `null` when promoting. */
  readonly reason: GateRejectionReason | null;
  /** Human sentence for the nightly report. */
  readonly explanation: string;
  readonly comparisons: readonly MetricComparison[];
  readonly goldenSetVersion: string;
  readonly evalRunId: string;
  readonly evaluatedAt: string;
}

export type GateRejectionReason =
  | 'no_golden_set'
  | 'no_baseline'
  | 'no_improvement'
  | 'regression_beyond_tolerance'
  | 'priority_violation';

/**
 * Compare a candidate evaluation against the baseline and decide.
 *
 * Pure and total — no I/O, no clock, no store — so the decision is reproducible and fully
 * testable. The caller supplies both results and the tolerances.
 */
export function evaluateGate(
  candidate: EvalResult,
  baseline: EvalResult | null,
  tolerances: Tolerances = DEFAULT_TOLERANCES,
): GateDecision {
  const base = {
    goldenSetVersion: candidate.goldenSetVersion,
    evalRunId: candidate.runId,
    evaluatedAt: candidate.evaluatedAt,
  };

  if (candidate.engagements.length === 0 || candidate.goldenSetVersion.trim() === '') {
    return {
      ...base,
      verdict: 'reject',
      reason: 'no_golden_set',
      explanation:
        'no golden engagements were evaluated — an empty suite cannot show an improvement, and ' +
        'vacuously satisfies "no regression", so the gate fails closed',
      comparisons: [],
    };
  }

  if (baseline === null) {
    return {
      ...base,
      verdict: 'reject',
      reason: 'no_baseline',
      explanation:
        'no prior evaluation to compare against — this run establishes the baseline; nothing is ' +
        'promoted on a first run',
      comparisons: compare(candidate, candidate, tolerances),
    };
  }

  const comparisons = compare(candidate, baseline, tolerances);

  const breached = comparisons.filter((c) => c.beyondTolerance);
  if (breached.length > 0) {
    return {
      ...base,
      verdict: 'reject',
      reason: 'regression_beyond_tolerance',
      explanation: `regressed beyond tolerance: ${breached.map(describe).join('; ')}`,
      comparisons,
    };
  }

  const improved = comparisons.filter((c) => c.movement === 'improved');
  if (improved.length === 0) {
    return {
      ...base,
      verdict: 'reject',
      reason: 'no_improvement',
      explanation:
        'no target metric improved — a change must earn its promotion, not merely avoid harm',
      comparisons,
    };
  }

  // Refinement 3: a lower-priority gain may not buy a higher-priority loss, even within tolerance.
  const regressed = comparisons.filter((c) => c.movement === 'regressed');
  const bestImproved = Math.min(...improved.map((c) => c.priority));
  const worstRegressed =
    regressed.length === 0 ? Infinity : Math.min(...regressed.map((c) => c.priority));
  if (worstRegressed < bestImproved) {
    const offender = regressed.find((c) => c.priority === worstRegressed);
    return {
      ...base,
      verdict: 'reject',
      reason: 'priority_violation',
      explanation:
        `${offender?.metric ?? 'a higher-priority metric'} regressed while only lower-priority ` +
        'metrics improved — everything downstream is derived from the higher-priority metric, so ' +
        'this trade is not available even inside tolerance',
      comparisons,
    };
  }

  return {
    ...base,
    verdict: 'promote',
    reason: null,
    explanation: `improved: ${improved.map(describe).join('; ')}`,
    comparisons,
  };
}

/**
 * Turn a decision into a per-rule approval. `promote` in `rules/promotion.ts` validates every
 * field of this again — deliberately belt-and-braces, because it is the one check standing between
 * an automated proposal and production tax logic.
 */
export function approvalFor(decision: GateDecision, subject: string): GateApproval {
  const deltas: Record<string, number> = {};
  for (const c of decision.comparisons) {
    if (c.delta !== null) deltas[c.metric] = c.delta;
  }
  const approval: GateApproval = {
    verdict: decision.verdict,
    subject,
    goldenSetVersion: decision.goldenSetVersion,
    evaluatedAt: decision.evaluatedAt,
    evalRunId: decision.evalRunId,
    deltas,
    ...(decision.verdict === 'reject' ? { reason: decision.explanation } : {}),
  };
  return approval;
}

function compare(
  candidate: EvalResult,
  baseline: EvalResult,
  tolerances: Tolerances,
): readonly MetricComparison[] {
  return TARGET_METRICS.map((metric, priority) => {
    const b = metricValue(baseline, metric);
    const c = metricValue(candidate, metric);

    // An unmeasurable metric is never treated as 0 — losing measurability IS a regression, and
    // gaining it IS an improvement, but neither has a numeric delta.
    if (b === null && c === null) {
      return {
        metric,
        priority,
        baseline: b,
        candidate: c,
        delta: null,
        movement: 'unmeasurable' as const,
        beyondTolerance: false,
      };
    }
    if (b === null) {
      return {
        metric,
        priority,
        baseline: b,
        candidate: c,
        delta: null,
        movement: 'improved' as const,
        beyondTolerance: false,
      };
    }
    if (c === null) {
      return {
        metric,
        priority,
        baseline: b,
        candidate: c,
        delta: null,
        movement: 'regressed' as const,
        beyondTolerance: true,
      };
    }

    const delta = round4(c - b);
    const movement: MetricMovement =
      delta > MIN_IMPROVEMENT ? 'improved' : delta < -MIN_IMPROVEMENT ? 'regressed' : 'unchanged';
    return {
      metric,
      priority,
      baseline: b,
      candidate: c,
      delta,
      movement,
      beyondTolerance: -delta > tolerances[metric],
    };
  });
}

const describe = (c: MetricComparison): string =>
  `${c.metric} ${c.baseline ?? 'n/a'} → ${c.candidate ?? 'n/a'}` +
  (c.delta === null ? '' : ` (${c.delta >= 0 ? '+' : ''}${c.delta})`);

const round4 = (n: number): number => Math.round(n * 10_000) / 10_000;
