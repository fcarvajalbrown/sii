// Stage 4 — MINE (ADR-043).
//
// Cluster recurring failures. The stage that turns noise into a diagnosis, using the three signals
// stage 3 gathered. The brief names three inferences and they map to three distinct remedies:
//
//   a repeated EXTRACTION FAILURE       ⇒ suggests a parser fix
//   a repeated AUDITOR CORRECTION       ⇒ suggests that rule is wrong, or scoped too broadly
//     on the same rule
//   a repeated ANOMALY the auditor      ⇒ suggests a bad heuristic
//     always dismisses
//
// CLUSTERING IS ON STRUCTURE, NOT TEXT. Failures cluster by
// `(strategy, ConfidenceSignalCode, endpoint)` — which is exactly why `ConfidenceSignalCode` is a
// CLOSED union in `extract/record.ts`. Free-text messages would cluster by wording, and SII's
// messages vary by período and RUT while meaning the same thing.
//
// THE THRESHOLD IS RECURRENCE, NOT INCIDENCE. A single failure is an event; the same failure on
// three artifacts across two runs is a pattern. Proposing on a single occurrence would flood stage
// 5 with one-off noise and, worse, would let ONE unusual taxpayer reshape a rule that is correct
// for everyone else — the exact over-generalisation the "scoped too broadly" diagnosis is about.
//
// SCOPE DISCIPLINE: a cluster confined to one taxpayer is a SCOPING signal (the rule needs a
// narrower applicability), while a cluster spread across taxpayers is a CORRECTNESS signal (the
// rule or parser is simply wrong). Those lead to opposite proposals, so the distinction is drawn
// here rather than left to stage 5.

import { NotImplemented } from '../../errors.js';
import type { LoopContext, StageResult } from '../context.js';

/** Minimum occurrences before a cluster is worth proposing against. See "recurrence" above. */
export const MIN_CLUSTER_SIZE = 3;

/** Minimum distinct runs a cluster must span, so one bad night cannot drive a change. */
export const MIN_CLUSTER_RUNS = 2;

export type ClusterDiagnosis =
  /** Repeated extraction failure or drift on one strategy ⇒ propose a parser fix. */
  | 'parser_fix'
  /** Repeated auditor correction attributed to one rule ⇒ propose amending it. */
  | 'rule_wrong'
  /** Corrections confined to one taxpayer/régimen ⇒ propose narrowing applicability. */
  | 'rule_overscoped'
  /** An anomaly kind the auditor consistently dismisses ⇒ propose raising its threshold. */
  | 'bad_heuristic';

export interface FailureCluster {
  readonly diagnosis: ClusterDiagnosis;
  /** Structural key the cluster formed on, e.g. `rcv-detalle|alias_fallback|www4.sii.cl/...`. */
  readonly key: string;
  readonly occurrences: number;
  readonly distinctRuns: number;
  readonly distinctTaxpayers: number;
  /** Strategy or rule the cluster implicates. */
  readonly subject: string;
  readonly firstSeen: string;
  readonly lastSeen: string;
}

export async function mineStage(ctx: LoopContext): Promise<StageResult> {
  void ctx;
  throw new NotImplemented(
    'loop/stages/mine',
    'needs stage 3 to be producing feedback and at least two runs of history to satisfy ' +
      'MIN_CLUSTER_RUNS — clustering a single run would propose against one-off noise',
  );
}
