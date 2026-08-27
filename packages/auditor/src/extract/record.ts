// The extraction record (ADR-043) — a typed value with a confidence and a provenance pointer.
//
// The unit of everything downstream. `store/` rows point at one of these; `eval/` scores field
// accuracy against these; the review queue holds the low-confidence ones. Two fields are required
// and are the whole point: `provenance` (never optional — "an answer without provenance is a bug")
// and `confidence` (never assumed, always computed by `confidence.ts` from observable facts).

import type { ArtifactProvenance, Instant } from '../provenance.js';

export type ExtractionId = string;

/**
 * How much to trust this value, in [0, 1]. NOT a probability and NOT a model output — it is a
 * deterministic function of observable parsing facts (`confidence.ts`). Comparable ACROSS
 * strategies only in the coarse sense the thresholds use.
 */
export type Confidence = number;

/** Why confidence is not 1. Kept structured so `mine/` can cluster on it (loop stage 4). */
export interface ConfidenceSignal {
  readonly code: ConfidenceSignalCode;
  /** The field it applies to, or `'*'` for the record as a whole. */
  readonly field: string;
  readonly detail: string;
}

/**
 * The closed set of things that reduce confidence. Closed on purpose: an open string set cannot be
 * clustered or trended, and stage 4 of the loop exists to cluster exactly these.
 */
export type ConfidenceSignalCode =
  /** The alias-tolerant lookup matched a NON-primary alias — SII renamed a key (ADR-004/011). */
  | 'alias_fallback'
  /** zod `.loose()` let through keys the projection has never seen. Possible new field. */
  | 'unknown_keys'
  /** An expected field was absent. `null` is a legitimate value in this domain — this is stronger. */
  | 'missing_field'
  /** A monto/date string did not parse in the expected es-CL format. */
  | 'unparseable_value'
  /** The value is outside any range this strategy has ever observed for the field. */
  | 'out_of_observed_range'
  /** A per-page total did not equal the sum of its rows (BPST pagination taught this, ADR-029). */
  | 'internal_total_mismatch'
  /** The artifact's structure differs from the shape the strategy was written against. */
  | 'structural_drift';

/**
 * One extracted value, or one extracted row. `T` is the strategy's typed output — reuse the
 * `core` task types (`F22Estado`, `RcvDetalleDoc`, …) rather than redeclaring them.
 */
export interface ExtractionRecord<T = unknown> {
  readonly id: ExtractionId;
  /** `<strategyId>@<version>` — a change of strategy is attributable without archaeology. */
  readonly strategy: string;
  /** ALWAYS an artifact provenance: an extraction reads bytes, it does not derive or cite law. */
  readonly provenance: ArtifactProvenance;
  readonly value: T;
  readonly confidence: Confidence;
  /** Empty when confidence is 1. Non-empty explains exactly what was uncertain and where. */
  readonly signals: readonly ConfidenceSignal[];
  readonly extractedAt: Instant;
  /** Pseudonymous subject (`confidential.ts`). */
  readonly taxpayer: string;
  readonly runId: string;
}

/** A record that failed to extract at all. Kept, not dropped — stage 4 clusters these into fixes. */
export interface ExtractionFailure {
  readonly strategy: string;
  readonly provenance: ArtifactProvenance;
  /** SII's own message VERBATIM when there was one; otherwise the parser's own (ADR-004). */
  readonly message: string;
  readonly failedAt: Instant;
  readonly taxpayer: string;
  readonly runId: string;
}

export interface ExtractionOutcome<T = unknown> {
  readonly records: readonly ExtractionRecord<T>[];
  readonly failures: readonly ExtractionFailure[];
}
