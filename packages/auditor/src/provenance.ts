// Provenance — the vocabulary every other module threads through (ADR-043 §I1).
//
// This is deliberately a TYPE, not a module with behaviour. ADR-004 already requires
// `// observed at <URL> on <YYYY-MM-DD>` in the SOURCE; that is provenance for the developer
// reading the code. This is provenance for the VALUE: a number in a report must trace to the
// bytes it came from, and those bytes must still exist.
//
// "An answer without provenance is a bug" is enforced structurally, not by convention: the record
// types in `extract/`, `rules/` and `ask/` all make a provenance field REQUIRED, so a value
// without one is not representable.

/**
 * Lowercase hex SHA-256 of an artifact's raw bytes. The primary key of the artifact store, so an
 * identical response fetched twice is stored once and both readings cite the same evidence.
 */
export type ContentHash = string & { readonly __brand: 'ContentHash' };

/** ISO-8601 UTC instant, e.g. `2026-08-06T03:14:07.221Z`. Always from the `Clock` seam. */
export type Instant = string & { readonly __brand: 'Instant' };

/** Narrowing constructors. They validate shape only — they do not compute or fetch anything. */
export const contentHash = (hex: string): ContentHash => {
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new TypeError(`not a sha-256 hex digest: ${hex}`);
  return hex as ContentHash;
};

export const instant = (iso: string): Instant => {
  if (Number.isNaN(Date.parse(iso))) throw new TypeError(`not an ISO-8601 instant: ${iso}`);
  return iso as Instant;
};

/**
 * Where a value came from. Exactly one of the three source shapes is populated — a value is
 * derived from a fetched artifact, OR quoted from a regulation, OR computed by a rule from other
 * provenanced values. A chain of the third kind terminates in the first two.
 */
export type Provenance = ArtifactProvenance | NormativaProvenance | DerivedProvenance;

/** The value was parsed out of a stored raw artifact. The common case. */
export interface ArtifactProvenance {
  readonly kind: 'artifact';
  readonly artifact: ContentHash;
  /** The URL the artifact was fetched from, verbatim (query string included). */
  readonly url: string;
  /** When the fetch happened — NOT when it was parsed. Retrieval timestamp, per the brief. */
  readonly retrievedAt: Instant;
  /** `<strategyId>@<version>` that produced the value, so a change of strategy is attributable. */
  readonly strategy: string;
  /**
   * Where inside the artifact, in whatever addressing that artifact's format supports: a JSON
   * pointer (`/data/3/montoNeto`), a CSS-ish path, a byte range (`bytes:1024-1088`). Free-form on
   * purpose — nine wire shapes (ADR-030..042) do not share one addressing scheme.
   */
  readonly locator: string;
}

/** The value is a regulation quoted from the normativa corpus (ADR-043 §I2). */
export interface NormativaProvenance {
  readonly kind: 'normativa';
  /** Stable citation anchor, e.g. `DL-825/1974#art-23-inc-1`. See `kb/normativa.ts`. */
  readonly anchor: string;
  /** The corpus snapshot this text was read from, so a later amendment does not rewrite history. */
  readonly corpusVersion: string;
  readonly retrievedAt: Instant;
}

/** The value was computed by a rule from other provenanced values. */
export interface DerivedProvenance {
  readonly kind: 'derived';
  /** `<ruleId>@<version>` — the exact rule record version that computed it. */
  readonly rule: string;
  /** The provenance of every input. Non-empty: something computed from nothing is a bug. */
  readonly inputs: readonly Provenance[];
  readonly computedAt: Instant;
}

/** True when a derivation chain bottoms out in real evidence rather than circling in derivations. */
export function isGrounded(p: Provenance): boolean {
  if (p.kind !== 'derived') return true;
  return p.inputs.length > 0 && p.inputs.every(isGrounded);
}

/** Flatten a chain to the artifact/normativa leaves — what a report renders as its citation list. */
export function citations(p: Provenance): readonly (ArtifactProvenance | NormativaProvenance)[] {
  return p.kind === 'derived' ? p.inputs.flatMap(citations) : [p];
}
