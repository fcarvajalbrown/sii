// Anomaly scoring — the documented statistical baseline (ADR-043).
//
// WHAT SCORING IS FOR, AND WHAT IT IS NOT: it RANKS what an auditor looks at first. It never issues
// a finding. A finding comes from a validated rule with a citation; a score is a reading order.
// That separation is the reason a statistical method is acceptable here at all — an unexplainable
// number deciding attention is fine, an unexplainable number deciding a tax position is not.
//
// THE BASELINE IS ROBUST, NOT GAUSSIAN, and that is a deliberate choice for this data:
//
//   * Tax series are short. Twelve F29 months, six años tributarios. A mean and standard deviation
//     over n=12 are dominated by the very outliers being hunted — a single anomalous month inflates
//     σ enough to hide itself. Median and MAD have a 50% breakdown point and do not.
//   * Tax series are seasonal and skewed. A ferretería's December is not its February. A symmetric
//     model of an asymmetric distribution flags every peak season as an anomaly, which trains the
//     auditor to ignore the tool — the exact failure ADR-024 designed around for first runs.
//   * Zeros are common and meaningful. A month with no sales is data, not a missing value, and
//     must not be imputed. `null` is never coerced to 0 anywhere in this project.
//
// SO: robust z = 0.6745 × (x − median) / MAD, the constant making MAD a consistent estimator of σ
// for normally distributed data (so the score reads on a familiar scale) while keeping the
// breakdown resistance. MAD = 0 (a constant history) is handled explicitly rather than dividing by
// zero — see `robustZ`.
//
// DETERMINISM: every function here is pure and seed-free. The only stochastic component in this
// module's world sits behind `model.ts` and is explicitly seeded (ADR-043 §I5).

import { NotImplemented } from '../errors.js';

/** Scale factor making MAD a consistent estimator of σ under normality. */
export const MAD_TO_SIGMA = 0.6745;

/** |z| at or above this is worth an auditor's attention. ~3σ — rare, not vanishingly so. */
export const DEFAULT_Z_THRESHOLD = 3;

/** Minimum history before a score is meaningful. Below this, `insufficient_history` is returned. */
export const MIN_OBSERVATIONS = 6;

export type AnomalyKind =
  /** The value is far from this taxpayer's own historical level for the same measure. */
  | 'level_outlier'
  /** The period-over-period change is far from this taxpayer's own historical change. */
  | 'discontinuity'
  /** A ratio (crédito/débito, retención/honorarios) departs from its historical band. */
  | 'ratio_shift'
  /** A value present every prior period is suddenly absent — a silent stop. */
  | 'series_break';

export interface Observation {
  /** `YYYYMM` or `YYYY`, ascending order guaranteed by the caller. */
  readonly period: string;
  /** `null` is a genuine absence and is EXCLUDED from the baseline, never imputed as 0. */
  readonly value: number | null;
}

export interface AnomalyScore {
  readonly kind: AnomalyKind;
  /** The measure scored, e.g. `f29.codigo.537` or `iva.creditoNeto`. */
  readonly measure: string;
  readonly period: string;
  /** Robust z. Sign preserved — a collapse and a spike are different stories. */
  readonly z: number;
  /** |z| mapped to [0,1] for ranking across measures. Monotone in |z|; not a probability. */
  readonly rank: number;
  readonly observed: number | null;
  readonly baseline: number | null;
  /** One sentence a human can act on. Never a verdict — see the header. */
  readonly explanation: string;
  /** Why no score was produced, when `z` is 0 and this is set. */
  readonly abstained: 'insufficient_history' | 'constant_history' | 'value_absent' | null;
}

/** Median of a non-empty sample. Sorted copy — input is not mutated. */
export function median(xs: readonly number[]): number {
  if (xs.length === 0) throw new RangeError('median of an empty sample');
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  // `noUncheckedIndexedAccess`: guarded by the length check above.
  return s.length % 2 === 1
    ? (s[mid] as number)
    : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

/** Median absolute deviation from the median. Zero for a constant sample — callers must handle it. */
export function mad(xs: readonly number[]): number {
  const m = median(xs);
  return median(xs.map((x) => Math.abs(x - m)));
}

/**
 * Robust z-score of `x` against `history`.
 *
 * Returns `null` — not 0, not Infinity — when the history is too short or constant. A constant
 * history means every deviation is infinitely surprising, which is never the useful reading; the
 * honest answer is "this method cannot say", and the caller abstains.
 */
export function robustZ(x: number, history: readonly number[]): number | null {
  if (history.length < MIN_OBSERVATIONS) return null;
  const spread = mad(history);
  if (spread === 0) return null;
  return (MAD_TO_SIGMA * (x - median(history))) / spread;
}

/** Map |z| to [0,1] for cross-measure ranking. Saturating, so one extreme value cannot dominate. */
export function rankFromZ(z: number): number {
  return Math.round((1 - Math.exp(-Math.abs(z) / DEFAULT_Z_THRESHOLD)) * 10_000) / 10_000;
}

/** First differences, skipping periods where either side is absent. */
export function differences(series: readonly Observation[]): readonly number[] {
  const out: number[] = [];
  for (let i = 1; i < series.length; i += 1) {
    const a = series[i - 1]?.value;
    const b = series[i]?.value;
    if (a !== null && a !== undefined && b !== null && b !== undefined) out.push(b - a);
  }
  return out;
}

/**
 * Score one measure's series. Every period after the warm-up gets a score against the periods
 * BEFORE it — never against the whole series including itself, which would leak the future into
 * the baseline and shrink exactly the anomalies being hunted.
 *
 * DEFERRED: the four `AnomalyKind` detectors each need their own tests against real series before
 * they rank anything an auditor reads. The primitives above (`median`, `mad`, `robustZ`,
 * `rankFromZ`, `differences`) ARE implemented and testable now — they are the parts whose
 * correctness is mathematical rather than empirical.
 */
export function scoreSeries(
  _measure: string,
  _series: readonly Observation[],
  _kinds?: readonly AnomalyKind[],
): readonly AnomalyScore[] {
  throw new NotImplemented(
    'scoreSeries',
    'the four detectors need calibration against real taxpayer series before they order an ' +
      "auditor's attention; the statistical primitives beneath them are implemented and testable",
  );
}
