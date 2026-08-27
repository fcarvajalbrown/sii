// The immutable raw artifact store (ADR-043) — layer one of `store/`.
//
// Content-addressed and append-only: the key IS the SHA-256 of the bytes, so an artifact cannot be
// mutated without becoming a different artifact. That is what makes a citation checkable a year
// later: re-hash the bytes, compare to the hash in the provenance, done.
//
// De-duplication falls out for free and is a FEATURE, not just a space saving: when tonight's
// fetch of an F22 hashes to the same value as last night's, nothing changed — no re-extraction, no
// diff, no alert. The manifests differ (each fetch gets its own) while the artifact is stored once.
//
// LOCATION: outside the repository, under the same ACL-hardened local state directory as the rest
// of the project's on-disk data (ADR-025). It holds raw SII responses, which include what curation
// strips (ADR-028) — this store is the INSIDE of the confidentiality boundary (`confidential.ts`).

import type { ContentHash } from '../provenance.js';
import type { FetchManifest } from '../ingest/manifest.js';

export interface ArtifactQuery {
  readonly taxpayer?: string;
  readonly runId?: string;
  /** Substring match on the fetched URL — how "every RCV artifact" is expressed without a schema. */
  readonly urlContains?: string;
  /** Inclusive ISO bounds on `retrievedAt`. */
  readonly since?: string;
  readonly until?: string;
}

/**
 * Immutable, content-addressed blob store plus its fetch manifests.
 *
 * There is deliberately no `delete` and no `update`. Retention is a separate, explicit operation
 * (`prune`) that a human runs — an audit trail that garbage-collects itself on a schedule is not
 * an audit trail.
 */
export interface ArtifactStore {
  /** Store bytes; returns their hash. Idempotent — storing identical bytes twice is one artifact. */
  put(bytes: Buffer): Promise<ContentHash>;

  /** Retrieve bytes by hash. `null` when absent (pruned, or never stored). */
  get(hash: ContentHash): Promise<Buffer | null>;

  /** True when the hash is present, without reading the bytes. For cheap citation checking. */
  has(hash: ContentHash): Promise<boolean>;

  /** Record one fetch. Many manifests may point at one artifact (the same response re-fetched). */
  putManifest(manifest: FetchManifest): Promise<void>;

  /** Every manifest matching the query, ordered by `retrievedAt` ascending (deterministic). */
  findManifests(query: ArtifactQuery): Promise<readonly FetchManifest[]>;

  /**
   * Verify that stored bytes still hash to their key. Returns the hashes that FAILED — an empty
   * array means the store is intact. Run before an engagement is relied upon in a report.
   */
  verify(hashes?: readonly ContentHash[]): Promise<readonly ContentHash[]>;

  /**
   * Drop artifacts whose every manifest is older than `before`, and whose hash is not referenced
   * by any retained extraction. Returns what was removed. Explicit and manual by design.
   */
  prune(before: string): Promise<readonly ContentHash[]>;
}
