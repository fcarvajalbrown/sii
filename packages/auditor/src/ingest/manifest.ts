// The fetch manifest (ADR-043 §I1) — what accompanies every raw artifact.

import type { ContentHash, Instant } from '../provenance.js';

/** Which `PortalSession`/`PortalDriver` primitive produced the artifact. Nine wire shapes across
 *  ADR-014..042 reach SII through exactly these six; recording all of them covers every facade. */
export type Transport =
  'requestJson' | 'requestForm' | 'requestText' | 'requestBinary' | 'requestPublic' | 'goto';

/**
 * The immutable record of one fetch. Written once, beside the artifact bytes, and never revised —
 * a re-fetch of the same URL produces a NEW manifest (possibly pointing at the same
 * `contentHash`, which is how "nothing changed" is detected for free).
 */
export interface FetchManifest {
  /** Digest of the raw bytes. The artifact store's key; the join back to `ArtifactProvenance`. */
  readonly contentHash: ContentHash;
  readonly url: string;
  readonly transport: Transport;
  readonly httpStatus: number;
  /** When the response arrived. This is the "retrieval timestamp" every citation carries. */
  readonly retrievedAt: Instant;
  /** Response `Content-Type` verbatim, or null. NOT normalised — SII sends inconsistent casing. */
  readonly contentType: string | null;
  readonly byteLength: number;
  /** Whole-request wall time, for spotting a surface that has become slow before it breaks. */
  readonly durationMs: number;
  /**
   * SHA-256 of the REQUEST (method + sorted body/form), or `null` when there was none.
   *
   * WHY THIS EXISTS: the URL alone does not identify a fetch. Twelve months of F29 POST to the SAME
   * endpoint with different bodies, and the F29 response carries no período anywhere — envelope is
   * `{data, metaData}` and metaData holds only conversation/transaction ids. Found by inspecting
   * real captured evidence (2026-08-06); without this field an artifact cannot be told apart from
   * its eleven siblings.
   *
   * A HASH, NOT THE BODY. The request carries `rutContribuyente`/`dv` — a client identifier — and a
   * manifest is designed to travel (`confidential.ts`). A digest attributes without identifying:
   * a caller that knows the request can re-derive the fingerprint and match.
   */
  readonly requestFingerprint: string | null;
  /** Pseudonymous subject (ADR-043 §I5). The manifest may travel; the RUT may not. */
  readonly taxpayer: string;
  /** Correlates every artifact of one nightly run. Matches `RunManifest.runId`. */
  readonly runId: string;
}
