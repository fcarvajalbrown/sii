// The eval result schema (ADR-043) — persisted per run so trends are queryable.
//
// The three metric families are the three improvement targets, IN PRIORITY ORDER. That order is
// not decoration: `gate.ts` uses it to break ties and to decide which regressions are tolerable
// against which gains. Extraction accuracy comes first because everything downstream is derived
// from it — a rule evaluated over a mis-parsed figure is wrong however good the rule is.

export interface ExtractionMetrics {
  /** Verified fields compared. The denominator EXCLUDES `verified: false` ground truth. */
  readonly fieldsCompared: number;
  readonly fieldsCorrect: number;
  /** `fieldsCorrect / fieldsCompared`, or `null` when nothing was comparable. Never defaulted to 1. */
  readonly accuracy: number | null;
  /** Per-strategy accuracy, so a regression is attributable to one parser rather than "the system". */
  readonly byStrategy: Readonly<Record<string, number>>;
  /** Records that went to review instead of the store. Rising = extractors degrading. */
  readonly routedToReview: number;
  /** Artifacts no strategy could parse at all. */
  readonly failures: number;
}

export interface NormativaMetrics {
  /** Anchors the applicable corpora say should be citable. */
  readonly expectedAnchors: number;
  /** Of those, how many the KB actually holds AND could resolve for the engagement's `asOf`. */
  readonly heldAnchors: number;
  /** `heldAnchors / expectedAnchors`, or `null` when no corpus scope was declared. */
  readonly coverage: number | null;
  /**
   * Citations the engagement needed that resolved to the WRONG effective version — the
   * retrospectivity failure. Counted separately because it is worse than a missing citation: a
   * missing one declines, a wrong-dated one answers confidently with the wrong year's law.
   */
  readonly misdatedCitations: number;
}

export interface FindingMetrics {
  readonly truePositives: number;
  readonly falsePositives: number;
  readonly falseNegatives: number;
  /** `tp / (tp + fp)`, or `null` when nothing was surfaced. */
  readonly precision: number | null;
  /** `tp / (tp + fn)`, or `null` when the golden set confirmed nothing. */
  readonly recall: number | null;
  readonly f1: number | null;
  /** Precision weighted by pesos at stake — a missed material issue outweighs a missed trivial one. */
  readonly materialityWeightedRecall: number | null;
}

export interface EvalResult {
  readonly runId: string;
  readonly evaluatedAt: string;
  /** Golden-set content hash. A metric shift with a changed version is not a code change. */
  readonly goldenSetVersion: string;
  /** Validated rule-set hash — half of the reproducibility contract (ADR-043 §I5). */
  readonly ruleSetVersion: string;
  /** Active strategy refs, sorted — the other half. */
  readonly strategyVersions: readonly string[];
  /** Engagements evaluated. Empty means the gate must reject (see `gate.ts`). */
  readonly engagements: readonly string[];
  readonly extraction: ExtractionMetrics;
  readonly normativa: NormativaMetrics;
  readonly findings: FindingMetrics;
  /** Wall time, for noticing the suite becoming too slow to run nightly. */
  readonly durationMs: number;
}

/** Metrics `gate.ts` compares, in the brief's priority order. */
export const TARGET_METRICS = [
  'extraction.accuracy',
  'normativa.coverage',
  'findings.precision',
  'findings.recall',
] as const;

export type TargetMetric = (typeof TARGET_METRICS)[number];

/** Pull a target metric out of a result. `null` propagates — an absent metric is not a zero. */
export function metricValue(result: EvalResult, metric: TargetMetric): number | null {
  switch (metric) {
    case 'extraction.accuracy':
      return result.extraction.accuracy;
    case 'normativa.coverage':
      return result.normativa.coverage;
    case 'findings.precision':
      return result.findings.precision;
    case 'findings.recall':
      return result.findings.recall;
  }
}

export interface EvalResultStore {
  put(result: EvalResult): Promise<void>;
  get(runId: string): Promise<EvalResult | null>;
  /** Most recent results, newest first — the trend query the nightly report renders. */
  recent(limit: number): Promise<readonly EvalResult[]>;
  /** The most recent result, or `null` on a first-ever run. The gate's baseline. */
  latest(): Promise<EvalResult | null>;
}
