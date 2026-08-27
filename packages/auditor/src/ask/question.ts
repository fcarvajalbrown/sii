// The question interface (ADR-043 §I2) — retrieval-grounded, always cited, declines honestly.
//
// THE TYPE SYSTEM IS THE ENFORCEMENT. `Answer` requires a non-empty `citations` array, so an
// uncited answer is not constructible. When evidence is insufficient the result is a `Declined`,
// which is a DIFFERENT TYPE — not an `Answer` with low confidence and a hedge. That distinction is
// the whole design: a caller must handle "I don't know" explicitly, and cannot accidentally render
// it as a soft answer.
//
// BUILD ORDER, per the brief: no chat interface before the eval harness exists. So this module
// defines the contract and the STRUCTURED query path; the natural-language path is declared and
// deferred, and it will be retrieval-only when it lands — the model's job is to select and phrase
// what retrieval returned, never to supply the content.
//
// WHERE AN LLM MAY AND MAY NOT APPEAR:
//   MAY  — turning a natural-language question into a structured query (parsing intent).
//   MAY  — phrasing a retrieved, cited answer into prose.
//   NEVER — supplying a regulation's content, a figure, or a finding. Those come from the KB and
//           the store, with provenance, or they do not come at all.

import { NotImplemented } from '../errors.js';
import type { Provenance } from '../provenance.js';

export interface Question {
  readonly text: string;
  /**
   * Pseudonymous subject. Required: a tax question without a taxpayer is not answerable, and
   * making it explicit stops an answer being silently computed over the wrong client's data.
   */
  readonly taxpayer: string;
  /**
   * THE DATE THE QUESTION IS ABOUT — the period under audit, not today. Drives every normativa
   * lookup (ADR-043 §I2). Required, with no default, for the reason spelled out in
   * `kb/normativa.ts`: defaulting to `now` answers a 2019 question with 2026 law.
   */
  readonly asOf: string;
}

/** A structured query — the deterministic path, available without any language model. */
export type StructuredQuery =
  | { readonly kind: 'metric'; readonly measure: string; readonly periods: readonly string[] }
  | { readonly kind: 'form'; readonly form: 'F22' | 'F29' | 'F50'; readonly period: string }
  | { readonly kind: 'ledger'; readonly side: 'COMPRA' | 'VENTA'; readonly period: string }
  | { readonly kind: 'obligation'; readonly period: string }
  | { readonly kind: 'normativa'; readonly terms: readonly string[] }
  | { readonly kind: 'finding'; readonly periods: readonly string[] };

export interface Citation {
  readonly provenance: Provenance;
  /** The quoted text or figure this citation supports. Verbatim — never paraphrased. */
  readonly quote: string;
}

/**
 * A cited answer. `citations` is typed as a non-empty tuple: TypeScript refuses to construct one
 * without at least a first element, so "an answer without provenance is a bug" is a compile error
 * rather than a code-review note.
 */
export interface Answer {
  readonly kind: 'answer';
  readonly text: string;
  readonly citations: readonly [Citation, ...Citation[]];
  /** Values the answer rests on, each independently traceable. */
  readonly figures: readonly {
    readonly label: string;
    readonly value: number | string | null;
    readonly provenance: Provenance;
  }[];
  /** Caveats the system knows about — an open period, a low-confidence extraction underneath. */
  readonly caveats: readonly string[];
}

export interface Declined {
  readonly kind: 'declined';
  /** What was missing, specifically. "I don't know" is useless; "no normativa loaded for
   *  DL-825 art. 23 as of 2019-06" tells the user what to fix. */
  readonly because: DeclineReason;
  readonly detail: string;
  /** What WOULD answer it — the actionable half. */
  readonly wouldNeed: readonly string[];
}

export type DeclineReason =
  /** The KB holds no regulation covering the question. The commonest case today. */
  | 'no_normativa'
  /** Normativa exists but not for the requested `asOf` date — the retrospectivity guard. */
  | 'no_normativa_for_date'
  /** The store holds no data for that taxpayer/period. */
  | 'no_data'
  /** Data exists but every relevant extraction is below the review threshold. */
  | 'data_below_confidence'
  /** The question was understood but is outside what this system models (e.g. client books). */
  | 'out_of_scope'
  /** The question could not be turned into a structured query. */
  | 'not_understood';

export type AskResult = Answer | Declined;

export interface AskService {
  /** The deterministic path: a structured query, no language model anywhere. */
  query(question: Question, query: StructuredQuery): Promise<AskResult>;
  /**
   * The natural-language path. Deferred until `eval/` exists, per the brief's build order. When it
   * lands it parses intent into a `StructuredQuery` and delegates to `query` — retrieval supplies
   * every fact, the model only selects and phrases.
   */
  ask(question: Question): Promise<AskResult>;
}

export function createAskService(): AskService {
  return {
    query: (_question: Question, _query: StructuredQuery): Promise<AskResult> => {
      throw new NotImplemented(
        'AskService.query',
        'needs the normalized store and normativa KB to be readable; the citation contract and ' +
          'the decline taxonomy are settled and enforced by the types above',
      );
    },
    ask: (_question: Question): Promise<AskResult> => {
      throw new NotImplemented(
        'AskService.ask',
        'deliberately deferred: the brief forbids a chat interface before the eval harness ' +
          'exists, and there is nothing yet to measure an answer against',
      );
    },
  };
}

/** Narrow an `AskResult`. Exists so callers branch on the type rather than on a truthy check. */
export const isAnswer = (r: AskResult): r is Answer => r.kind === 'answer';
