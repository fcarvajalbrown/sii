// Stage 5 — PROPOSE (ADR-043).
//
// Generate candidate changes: new parsers, new or amended rules, adjusted thresholds. Candidates
// enter with LOW CONFIDENCE and `candidate` status — `rules/promotion.ts` enforces that
// structurally: `propose()` and `amend()` cannot produce any other status.
//
// FOUR HARD LIMITS ON WHAT THIS STAGE MAY DO:
//
//  1. IT NEVER WRITES A NORMATIVA CLAIM. A proposed rule may cite an anchor that already exists in
//     the KB; it may not invent one, and it may not assert what a regulation says. That is ADR-043
//     §I2 and it is the boundary between "the loop tunes its own thresholds" and "the loop makes
//     up tax law". A proposal whose citation does not resolve is dropped here, not at the gate.
//
//  2. IT CHECKS THE REJECTION LEDGER FIRST. `proposalFingerprint` hashes the SUBSTANCE of a
//     proposal (kind + applicability + canonical expression), ignoring rationale and timestamp, so
//     a rejected idea re-worded is still recognised. Without this the loop re-proposes the same
//     bad idea every night forever, which the brief calls out explicitly.
//
//  3. NO LLM. Every proposal here is derived deterministically from a cluster: a threshold moves
//     by a computed amount, an applicability narrows to the régimen the corrections came from, a
//     confidence weight adjusts toward what the auditor's `confirmed` verdicts imply. These are
//     arithmetic over labelled data, and the brief's rule applies — no LLM where the answer should
//     be deterministic.
//
//  4. IT PROPOSES, IT DOES NOT APPLY. Nothing here touches the active strategy registry or the
//     validated rule set. Candidates are registered (inert) and handed to stage 6.

import { NotImplemented } from '../../errors.js';
import type { LoopContext, StageResult } from '../context.js';
import type { ClusterDiagnosis } from './mine.js';

/** Ceiling on how many candidates one night may generate, so a bad cluster cannot flood the gate. */
export const MAX_PROPOSALS_PER_RUN = 10;

/** Confidence a mined candidate enters with. Low by construction — the gate is what raises trust. */
export const INITIAL_CANDIDATE_CONFIDENCE = 0.2;

/** Maximum expression depth for a generated rule, so a proposal stays human-readable. */
export const MAX_PROPOSED_DEPTH = 6;

export type ProposalKind = 'parser' | 'rule_new' | 'rule_amend' | 'threshold';

export interface Proposal {
  readonly kind: ProposalKind;
  /** Substance hash — checked against the rejection ledger before the proposal is emitted. */
  readonly fingerprint: string;
  /** The cluster that motivated it. Every proposal traces to evidence, like every other value. */
  readonly fromCluster: string;
  readonly diagnosis: ClusterDiagnosis;
  readonly rationale: string;
  /** `<ruleId>@<version>` or `<strategyId>@<version>` once registered. */
  readonly subject: string;
}

export async function proposeStage(ctx: LoopContext): Promise<StageResult> {
  void ctx;
  throw new NotImplemented(
    'loop/stages/propose',
    'needs stage 4 clusters as input; the generators it dispatches to (threshold adjustment, ' +
      'applicability narrowing, confidence-weight tuning) are deterministic arithmetic over ' +
      'labelled corrections and must land with tests that pin the no-LLM and no-invented-citation ' +
      'rules',
  );
}
