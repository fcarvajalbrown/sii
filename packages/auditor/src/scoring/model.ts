// The trained-model seam behind the baseline (ADR-043).
//
// EXPLICITLY OUT OF SCOPE FOR NOW: no fine-tuning, no training pipeline. This file declares the
// interface a learned scorer would implement so the baseline can be swapped or ensembled later
// WITHOUT any caller changing — and so the eventual comparison is apples to apples, judged by the
// same `eval/` metrics and the same gate.
//
// THE CONSTRAINTS A LEARNED SCORER INHERITS, stated now so a future session cannot quietly drop
// them:
//
//   1. IT RANKS, IT NEVER RULES. Same as the baseline. A model may reorder an auditor's queue; it
//      may not issue a finding, assert a rule, or state regulation. That is ADR-043 §I2 and it does
//      not bend for a better AUC.
//   2. IT IS SEEDED AND REPRODUCIBLE. `seed` is required, not optional. Given the same inputs,
//      the same model version and the same seed, the output must be identical (ADR-043 §I5).
//   3. IT IS VERSIONED LIKE EVERYTHING ELSE. `modelVersion` goes into the run manifest, so a shift
//      in finding precision is attributable to the model rather than to the data.
//   4. IT TRAINS ON PSEUDONYMOUS DATA ONLY. Features are derived inside the boundary; nothing
//      carrying a client identifier reaches a training set or an external API (`confidential.ts`).
//   5. IT PASSES THE SAME GATE. A model is promoted only if it improves a target metric without
//      regressing the others beyond tolerance — the identical rule applied to parsers and rules.

import { NotImplemented } from '../errors.js';
import type { AnomalyScore, Observation } from './baseline.js';

/** Feature vector for one (taxpayer, period, measure). Derived deterministically from the store. */
export interface FeatureVector {
  readonly taxpayer: string;
  readonly period: string;
  readonly measure: string;
  /** Named features, sorted by key on construction so serialisation is stable. */
  readonly features: Readonly<Record<string, number>>;
}

export interface ScorerInfo {
  readonly id: string;
  readonly modelVersion: string;
  /** `'baseline'` is the statistical scorer; anything else must document its training data. */
  readonly family: 'baseline' | 'learned';
}

export interface AnomalyScorer {
  readonly info: ScorerInfo;
  /**
   * Score a batch. Deterministic given `seed` — an unseeded scorer is not admissible here.
   * Returns one score per input in the SAME order, so callers can zip without a join.
   */
  score(inputs: readonly FeatureVector[], seed: number): Promise<readonly AnomalyScore[]>;
}

/**
 * Build feature vectors from a measure's series.
 *
 * DEFERRED. Feature choice is the substance of a learned scorer, and choosing features before there
 * is an eval harness to judge them is how a model gets tuned on intuition. Build the harness first
 * (the brief's own ordering), then derive features from what the golden set shows actually
 * separates a confirmed finding from a dismissed one.
 */
export function buildFeatures(
  _taxpayer: string,
  _measure: string,
  _series: readonly Observation[],
): readonly FeatureVector[] {
  throw new NotImplemented(
    'buildFeatures',
    'feature selection must be judged by the eval harness, which is the prerequisite the brief ' +
      'puts ahead of any learned component — build the golden set first',
  );
}
