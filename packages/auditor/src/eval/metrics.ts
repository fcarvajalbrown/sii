// Metric computation (ADR-043) — how the three families are actually measured.
//
// The definitions matter more than the code, so they are written down beside it. Each is chosen to
// be HARD TO GAME, because the nightly loop optimises against them and an easily-gamed metric is
// worse than none.

import type { ExtractionRecord } from '../extract/record.js';
import { needsReview } from '../extract/confidence.js';
import type { ExpectedCitation, ExpectedField, ExpectedFinding } from './golden.js';
import type { ExtractionMetrics, FindingMetrics, NormativaMetrics } from './result.js';

/** A finding the system surfaced, for comparison against the golden set's expectations. */
export interface ProducedFinding {
  readonly id: string;
  readonly ruleId: string | null;
  readonly period: string;
  readonly describes: string;
  readonly materiality: number | null;
  /** Anchors the finding cited. Empty means uncited — see `findingMetrics`. */
  readonly citedAnchors: readonly string[];
}

/** Whether an anchor resolved, and to the right effective version, for one engagement's `asOf`. */
export interface ResolvedAnchor {
  readonly anchor: string;
  readonly asOf: string;
  readonly resolved: boolean;
  readonly correctVersion: boolean;
}

/**
 * EXTRACTION FIELD-LEVEL ACCURACY — priority 1.
 *
 * `fieldsCorrect / fieldsCompared`, where the denominator counts ONLY ground truth marked
 * `verified: true`. Three anti-gaming rules:
 *
 *   * An unverified expectation is EXCLUDED, not assumed correct. Counting unchecked fields as
 *     right is the fastest route to a meaningless 99%.
 *   * A field routed to REVIEW counts as INCORRECT, not as abstained. Otherwise a strategy scores
 *     100% by routing everything it is unsure about to a human — perfect accuracy, useless system.
 *     Review depth is reported separately so the trade-off stays visible.
 *   * Comparison is EXACT. These are integer pesos and calendar dates; "close" is wrong. A
 *     tolerance would normalise exactly the off-by-a-reversed-nota-de-crédito error that cost 15
 *     of 16 months in `iva`.
 *
 * A field the extractor never produced counts as incorrect too — a miss is not a pass.
 */
export function extractionMetrics(
  expected: readonly ExpectedField[],
  produced: readonly ExtractionRecord[],
  routedToReview: number,
  failures: number,
): ExtractionMetrics {
  const verified = expected.filter((e) => e.verified);

  // Index produced values by `<artifact>|<path>`; last write wins, mirroring the store's own rule.
  const byKey = new Map<string, { value: unknown; strategy: string; confidence: number }>();
  for (const record of produced) {
    for (const [path, value] of flatten(record.value)) {
      byKey.set(`${record.provenance.artifact}|${path}`, {
        value,
        strategy: record.strategy,
        confidence: record.confidence,
      });
    }
  }

  const perStrategy = new Map<string, { correct: number; total: number }>();
  let correct = 0;

  for (const field of verified) {
    const hit = byKey.get(`${field.artifact}|${field.path}`);
    // A missing extraction, or one that went to review, is a miss.
    const ok =
      hit !== undefined && !needsReview(hit.confidence) && exactEquals(hit.value, field.expected);
    if (ok) correct += 1;

    const strategy = hit?.strategy ?? 'unattributed';
    const bucket = perStrategy.get(strategy) ?? { correct: 0, total: 0 };
    bucket.total += 1;
    if (ok) bucket.correct += 1;
    perStrategy.set(strategy, bucket);
  }

  const byStrategy: Record<string, number> = {};
  for (const key of [...perStrategy.keys()].sort()) {
    const b = perStrategy.get(key);
    if (b !== undefined) byStrategy[key] = ratio(b.correct, b.total) ?? 0;
  }

  return {
    fieldsCompared: verified.length,
    fieldsCorrect: correct,
    accuracy: ratio(correct, verified.length),
    byStrategy,
    routedToReview,
    failures,
  };
}

/**
 * NORMATIVA COVERAGE — priority 2.
 *
 * `heldAnchors / expectedAnchors` over the engagement's declared applicable corpus. Three rules:
 *
 *   * An anchor counts as HELD only if it resolves FOR THE ENGAGEMENT'S `asOf` DATE. Holding the
 *     current text of an article whose relevant version is from 2019 is not coverage — that is the
 *     retrospectivity failure, counted separately as `misdatedCitations` because it is WORSE than
 *     absence: absence declines, a wrong date answers confidently with the wrong year's law.
 *   * The denominator is the DECLARED applicable corpus, not the anchors the system happens to
 *     hold. A coverage metric whose denominator is its own numerator always reads 100%.
 *   * Loading unrelated regulation does not raise coverage — only anchors an engagement actually
 *     needed are counted, so bulk-ingesting text cannot move the number.
 */
export function normativaMetrics(
  expected: readonly ExpectedCitation[],
  resolved: readonly ResolvedAnchor[],
  expectedAnchorCount: number,
): NormativaMetrics {
  const byAnchor = new Map(resolved.map((r) => [`${r.anchor}|${r.asOf}`, r]));

  let held = 0;
  let misdated = 0;
  const seen = new Set<string>();

  for (const citation of expected) {
    const key = `${citation.anchor}|${citation.asOf}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const hit = byAnchor.get(key);
    if (hit === undefined || !hit.resolved) continue;
    if (hit.correctVersion) held += 1;
    else misdated += 1;
  }

  return {
    expectedAnchors: expectedAnchorCount,
    heldAnchors: held,
    coverage: ratio(held, expectedAnchorCount),
    misdatedCitations: misdated,
  };
}

/**
 * FINDING PRECISION / RECALL — priority 3, matched against auditor-confirmed outcomes.
 *
 *   TP — surfaced AND `confirmed: true` in the golden set.
 *   FP — surfaced AND `confirmed: false` (raised, then dismissed by the auditor).
 *   FN — `confirmed: true` in the golden set and NOT surfaced.
 *
 * Matching is by `(ruleId, period)` when the golden set attributed a rule, falling back to
 * `(period, normalised describes)`. Fuzzy text matching is deliberately avoided: a generous match
 * rule inflates recall, and the point is to be able to trust the number.
 *
 * AN UNCITED FINDING IS A FALSE POSITIVE, whatever its content — even if an auditor confirmed the
 * same issue independently. "An answer without provenance is a bug" (ADR-043 §I1); this is the
 * metric-level teeth behind that invariant.
 *
 * `materialityWeightedRecall` weights each confirmed finding by pesos at stake, so missing one
 * material issue costs more than missing several trivial ones — how an auditor actually judges it.
 */
export function findingMetrics(
  expected: readonly ExpectedFinding[],
  produced: readonly ProducedFinding[],
): FindingMetrics {
  const keysOf = (f: { ruleId: string | null; period: string; describes: string }): string[] =>
    f.ruleId === null
      ? [`d|${f.period}|${normalise(f.describes)}`]
      : [`r|${f.ruleId}|${f.period}`, `d|${f.period}|${normalise(f.describes)}`];

  // Uncited findings are excluded from the "surfaced" set up front — they cannot be true positives.
  const surfaced = new Set<string>();
  let uncited = 0;
  for (const p of produced) {
    if (p.citedAnchors.length === 0) {
      uncited += 1;
      continue;
    }
    for (const k of keysOf(p)) surfaced.add(k);
  }

  let tp = 0;
  let fp = uncited; // every uncited finding is a false positive by construction
  let fn = 0;
  let confirmedWeight = 0;
  let recalledWeight = 0;

  const matchedExpected = new Set<string>();

  for (const e of expected) {
    const hit = keysOf(e).some((k) => surfaced.has(k));
    if (hit) for (const k of keysOf(e)) matchedExpected.add(k);

    if (e.confirmed) {
      const weight = Math.max(1, Math.abs(e.materiality ?? 0));
      confirmedWeight += weight;
      if (hit) {
        tp += 1;
        recalledWeight += weight;
      } else {
        fn += 1;
      }
    } else if (hit) {
      // Surfaced something the auditor dismissed.
      fp += 1;
    }
  }

  // A cited finding matching NO golden expectation at all is also a false positive: the golden set
  // is the complete record of that engagement, so anything outside it was not a real issue.
  for (const p of produced) {
    if (p.citedAnchors.length === 0) continue;
    if (!keysOf(p).some((k) => matchedExpected.has(k))) fp += 1;
  }

  const precision = ratio(tp, tp + fp);
  const recall = ratio(tp, tp + fn);

  return {
    truePositives: tp,
    falsePositives: fp,
    falseNegatives: fn,
    precision,
    recall,
    f1: f1(precision, recall),
    materialityWeightedRecall: ratio(recalledWeight, confirmedWeight),
  };
}

/** Safe ratio: `null` rather than `NaN`/0 when the denominator is 0. Used by all three families. */
export function ratio(numerator: number, denominator: number): number | null {
  if (denominator === 0) return null;
  return Math.round((numerator / denominator) * 10_000) / 10_000;
}

/** Harmonic mean of precision and recall; `null` when either is null or both are 0. */
export function f1(precision: number | null, recall: number | null): number | null {
  if (precision === null || recall === null) return null;
  if (precision + recall === 0) return null;
  return Math.round(((2 * precision * recall) / (precision + recall)) * 10_000) / 10_000;
}

/**
 * Flatten an extracted value into `path → leaf` pairs, addressed the way `ExpectedField.path`
 * writes them (`rows[3].montoNeto`). Arrays are indexed; objects are dotted; `null` is a LEAF, not
 * an empty branch — an absent figure is a real value in this domain and must be comparable.
 */
export function flatten(value: unknown, prefix = ''): readonly (readonly [string, unknown])[] {
  if (value === null || typeof value !== 'object') return [[prefix, value] as const];

  if (Array.isArray(value)) {
    return value.flatMap((v, i) => flatten(v, `${prefix}[${i}]`));
  }
  const src = value as Record<string, unknown>;
  return Object.keys(src)
    .sort()
    .flatMap((k) => flatten(src[k], prefix === '' ? k : `${prefix}.${k}`));
}

/** Exact comparison. No numeric tolerance, no string coercion — see `extractionMetrics`. */
function exactEquals(actual: unknown, expected: string | number | boolean | null): boolean {
  return actual === expected;
}

/** Lowercase, collapse whitespace. Enough to survive re-wrapping; NOT fuzzy matching. */
function normalise(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}
