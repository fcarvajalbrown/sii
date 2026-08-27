// How confidence is computed (ADR-043) — deterministic, from observable parsing facts.
//
// THE HONESTY CONSTRAINT: this number decides what a human reviews and what enters the store
// unexamined, so it must not be a vibe. It is a pure function of signals the parser genuinely
// observed. No model, no heuristic tuned on a hunch, no `0.8` because that felt right.
//
// The weights below ARE a judgement call, and they are the thing the nightly loop is allowed to
// tune (stage 5 proposes a weight change, stage 7 promotes it only if `eval/` improves). They
// start at values derived from what this codebase has actually been bitten by:
//
//   * `structural_drift` is near-fatal — a changed page shape is how a scraper breaks, and every
//     wire-shape surprise in ADR-029..042 presented this way first.
//   * `internal_total_mismatch` is severe — BPST under-counted a real month by 44.5% reading page
//     one alone (ADR-029). A total that disagrees with its own rows is not a rounding issue.
//   * `alias_fallback` is moderate — the alias-tolerant lookup working as designed, but it means
//     SII renamed something and the primary alias in the code is now stale (ADR-011).
//   * `unknown_keys` is mild — `.loose()` doing its job. Interesting for stage 4 clustering (a new
//     SII field), not a reason to distrust the fields that DID parse.
//   * `missing_field` is moderate, deliberately NOT severe — `null` is a legitimate, common answer
//     across this domain and coercing it to 0 has been an explicit trap since the first read.

import type { Confidence, ConfidenceSignal, ConfidenceSignalCode } from './record.js';

/** Multiplicative penalty per signal occurrence. Lower = harsher. */
export type ConfidenceWeights = Readonly<Record<ConfidenceSignalCode, number>>;

export const DEFAULT_WEIGHTS: ConfidenceWeights = {
  structural_drift: 0.1,
  internal_total_mismatch: 0.25,
  unparseable_value: 0.4,
  out_of_observed_range: 0.6,
  alias_fallback: 0.75,
  missing_field: 0.8,
  unknown_keys: 0.95,
};

/**
 * Below this, a record goes to the review queue instead of the store. Chosen so that ONE severe
 * signal, or two moderate ones, is enough to require a human — and so a clean parse with a couple
 * of unknown keys is not.
 */
export const REVIEW_THRESHOLD = 0.7;

/**
 * Combine signals into a confidence.
 *
 * Multiplicative, not additive: independent doubts compound rather than averaging each other out.
 * Two `alias_fallback`s (0.75 × 0.75 = 0.5625) is worse than one, which is the intended reading —
 * a payload where two keys moved is more likely to have moved a third.
 *
 * Deterministic and order-independent (multiplication commutes), so re-running on the same signals
 * always yields the same number — required by ADR-043 §I5.
 */
export function scoreConfidence(
  signals: readonly ConfidenceSignal[],
  weights: ConfidenceWeights = DEFAULT_WEIGHTS,
): Confidence {
  const raw = signals.reduce((acc, s) => acc * (weights[s.code] ?? 1), 1);
  // Round to 4 decimals so a float's last bits cannot make two identical runs differ.
  return Math.round(Math.max(0, Math.min(1, raw)) * 10_000) / 10_000;
}

/** Records at or above the threshold enter the store; the rest are queued for review. */
export function needsReview(confidence: Confidence, threshold = REVIEW_THRESHOLD): boolean {
  return confidence < threshold;
}
