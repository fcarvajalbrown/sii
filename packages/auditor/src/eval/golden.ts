// The golden set (ADR-043) — completed audit engagements with known-correct outputs.
//
// THIS IS THE BOTTLENECK OF THE ENTIRE SYSTEM, and it cannot be engineered around. Without a
// golden set the gate has nothing to measure, so it rejects everything (by design — see
// `gate.ts`), the loop proposes into a void, and nothing improves. Curating it is human work.
//
// THE GOLDEN SET IS REAL ENGAGEMENTS. Never synthetic. A generated fixture encodes what we already
// believe the parser does, so measuring against it measures nothing — it is a mirror, and it will
// report 100% accuracy on the day the extractor breaks in a way we did not anticipate. Every trap
// this project has hit (BPST's missing retención source, the nota-de-crédito netting, the per-page
// totals, the F29 plazo false positive) was invisible until real data contradicted an assumption.
//
// WHERE IT LIVES: OUTSIDE the repository, at `SII_AUDITOR_GOLDEN_DIR`. It contains real client tax
// data — the most sensitive material this project touches. It is never committed, never included
// in a package, and never sent anywhere. The `expected` outputs are keyed by `TaxpayerKey`
// (`confidential.ts`) so metric RESULTS can be shared even though the set itself cannot.
//
// ── HOW TO ADD A COMPLETED ENGAGEMENT ────────────────────────────────────────────────────────
//
//   1. Create `$SII_AUDITOR_GOLDEN_DIR/<engagementId>/` — a slug, no client name:
//      `2026-q1-ferreteria-iva` is fine, a razón social is not.
//
//   2. `manifest.json` — an `EngagementManifest` (below). Declare `periods`, `regimen`, the
//      `applicableCorpus` ids in scope, and `sealedAt`.
//
//   3. `artifacts/` — the RAW SII responses the engagement was actually decided on, named by
//      content hash, PLUS `artifacts/manifests.jsonl` (the `FetchManifest` of each one). Copy both
//      from the artifact store; do not re-fetch. Re-fetching gets today's answer, and the
//      engagement was decided on that day's answer — the single most common way a golden set
//      silently rots. The manifests are not bookkeeping: they carry the URL and retrieval
//      timestamp every citation needs, and they are what routes each artifact to the strategy that
//      can parse it.
//
//   4. `expected/extractions.jsonl` — one `ExpectedField` per line: the field-level ground truth a
//      human confirmed. This is the denominator of extraction accuracy. Fill in what was actually
//      checked; an unchecked field is `null`, NOT a guess.
//
//   5. `expected/findings.jsonl` — one `ExpectedFinding` per line, INCLUDING the ones the auditor
//      dismissed (`confirmed: false`). Recall needs the misses and precision needs the false
//      positives; a file of only confirmed findings measures neither.
//
//   6. `expected/citations.jsonl` — the normativa anchors the engagement relied on. The
//      denominator of normativa coverage.
//
//   7. Run `sii-auditor eval --engagement <id>` and commit NOTHING. Record the resulting
//      `EvalResult` id in the engagement log kept with the client file.
//
//   SEALING: once `sealedAt` is set, the expected files are frozen. Correcting a genuine mistake
//   means a new engagement version (`<id>-v2`) with a note — editing ground truth in place turns
//   the harness into a mirror of whatever the code currently does.

import type { FetchManifest } from '../ingest/manifest.js';
import type { Corroboration } from './corroboration.js';

export type EngagementId = string;

export interface EngagementManifest {
  readonly id: EngagementId;
  /** Pseudonymous (`confidential.ts`). The real RUT never appears in the golden set metadata. */
  readonly taxpayer: string;
  /** Periods the engagement covered, e.g. `['202401', …, '202412']` or `['2025']`. */
  readonly periods: readonly string[];
  /** Régimen in force during the engagement, verbatim: `M14A`, `REGS`, `FAEL`, `SGGC`. */
  readonly regimen: string;
  /** `ApplicableCorpus` ids in scope — the denominator of the coverage metric. */
  readonly applicableCorpus: readonly string[];
  /** When the engagement's ground truth was frozen. After this, files are read-only. */
  readonly sealedAt: string;
  /** Who signed off. An operator handle, never a person's name. */
  readonly sealedBy: string;
  /** Free notes for a future reader: scope caveats, known gaps in what was verified. */
  readonly notes: string;
  /**
   * Set to the id of the engagement that REPLACES this one.
   *
   * Sealing is final, so a correction or an extension is a NEW engagement (`<id>-v2`) rather than an
   * edit. Without this pointer both versions would be listed and evaluated, double-counting the same
   * evidence and quietly inflating every denominator. A superseded engagement is hidden from `list()`
   * — kept on disk as the record of what was measured then, invisible to the harness now.
   */
  readonly supersededBy?: string;
}

/** One field of ground truth. `expected: null` means "genuinely absent", not "not checked". */
export interface ExpectedField {
  /** Content hash of the artifact this field should be extracted from. */
  readonly artifact: string;
  /** Dotted path into the extracted record, e.g. `rows[3].montoNeto`. */
  readonly path: string;
  readonly expected: string | number | boolean | null;
  /**
   * `false` when a human did not verify this field. Excluded from the accuracy denominator —
   * counting unverified fields as correct is the fastest way to a meaningless 99%.
   */
  readonly verified: boolean;
  /**
   * How the value was confirmed INDEPENDENTLY of the parser (W8). Absent means it was read off
   * the artifact only — honest, but then the golden set and the parser can be wrong the same way
   * and accuracy measures agreement between two copies of one mistake. See `corroboration.ts`.
   */
  readonly corroboration?: Corroboration;
}

export interface ExpectedFinding {
  readonly id: string;
  /** The rule that should have produced it, when the engagement attributed one. */
  readonly ruleId: string | null;
  readonly period: string;
  /** Short description of the issue, in the auditor's own words. */
  readonly describes: string;
  /**
   * TRUE when the auditor confirmed it was a real issue; FALSE when it was raised and dismissed.
   * BOTH are required — dismissals are the precision denominator and the third learning signal
   * ("a repeated anomaly the auditor always dismisses suggests a bad heuristic").
   */
  readonly confirmed: boolean;
  /** Pesos at stake, for materiality-weighted metrics. `null` when not quantified. */
  readonly materiality: number | null;
}

export interface ExpectedCitation {
  readonly findingId: string;
  /** Normativa anchor the engagement relied on, e.g. `CT/1974#art-200`. */
  readonly anchor: string;
  /** The date the law was applied AS OF — the retrospectivity check (ADR-043 §I2). */
  readonly asOf: string;
}

export interface GoldenEngagement {
  readonly manifest: EngagementManifest;
  /** The fetch manifest of every stored artifact — the evidence's own provenance, and what the
   *  harness matches against `StrategyScope` to decide which parser replays which artifact. */
  readonly manifests: readonly FetchManifest[];
  readonly fields: readonly ExpectedField[];
  readonly findings: readonly ExpectedFinding[];
  readonly citations: readonly ExpectedCitation[];
}

export interface GoldenSet {
  /** Engagement ids, ascending. Empty is a legitimate — and gate-blocking — state. */
  list(): Promise<readonly EngagementId[]>;
  load(id: EngagementId): Promise<GoldenEngagement>;
  /** Raw bytes of a golden artifact by hash, or `null`. */
  artifact(id: EngagementId, hash: string): Promise<Buffer | null>;
  /**
   * Content hash over every sealed engagement. Stamped into each `EvalResult` and every
   * `GateApproval`, so a metric movement caused by the golden set CHANGING is distinguishable from
   * one caused by the code changing.
   */
  version(): Promise<string>;
}

export const GOLDEN_DIR_ENV = 'SII_AUDITOR_GOLDEN_DIR';

// The file-backed reader lives in `file-golden.ts`; re-exported here so the schema and its loader
// stay one import for a caller.
export { createFileGoldenSet } from './file-golden.js';
