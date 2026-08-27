// In-memory `ArtifactStore` / `NormalizedStore` (ADR-043).
//
// These are REAL implementations with the same semantics as the file-backed pair — content
// addressing, immutability, last-write-wins upserts, deterministic ordering — held in maps instead
// of on disk. They exist so the loop, the extraction pipeline and the harness can be exercised
// without touching the filesystem, and so `--in-memory` is a genuine dry run rather than a mock.
//
// They are NOT a fake that pretends to work: everything they promise, they do. What they lack is
// durability, which is exactly the property a test does not want.

import { createHash } from 'node:crypto';
import { contentHash } from '../provenance.js';
import type { ContentHash } from '../provenance.js';
import type { FetchManifest } from '../ingest/manifest.js';
import type { ArtifactQuery, ArtifactStore } from './artifacts.js';
import type { AnyEntity, EntityKind, Taxpayer, TaxpayerRef } from './entities.js';
import type { EntityFilter, NormalizedStore } from './normalized.js';

export interface MemoryArtifactStore extends ArtifactStore {
  /** Bytes currently held, for assertions. */
  readonly size: number;
  /** Overwrite an artifact's bytes WITHOUT changing its key — the only way to simulate the
   *  corruption `verify` exists to catch. Test-only; the real store cannot do this. */
  corrupt(hash: ContentHash, bytes: Buffer): void;
  /**
   * Mark a hash as referenced by a retained extraction, so `prune` protects it.
   *
   * The file-backed store DISCOVERS these by reading `<root>/extractions/*.jsonl`; there is no such
   * file here, so a caller must say so explicitly. Without this method the two stores would differ
   * in a way no test would catch — the memory `prune` would happily delete an artifact a live
   * extraction still cites, and only bite in production.
   */
  noteExtractionRef(hash: ContentHash): void;
}

export function memoryArtifactStore(): MemoryArtifactStore {
  const blobs = new Map<string, Buffer>();
  const manifests: FetchManifest[] = [];
  const extractionRefs = new Set<string>();

  return {
    noteExtractionRef(hash: ContentHash): void {
      extractionRefs.add(hash);
    },
    get size() {
      return blobs.size;
    },
    corrupt(hash: ContentHash, bytes: Buffer): void {
      blobs.set(hash, bytes);
    },
    async put(bytes: Buffer): Promise<ContentHash> {
      const hash = contentHash(createHash('sha256').update(bytes).digest('hex'));
      if (!blobs.has(hash)) blobs.set(hash, Buffer.from(bytes));
      return hash;
    },
    async get(hash: ContentHash): Promise<Buffer | null> {
      return blobs.get(hash) ?? null;
    },
    async has(hash: ContentHash): Promise<boolean> {
      return blobs.has(hash);
    },
    async putManifest(manifest: FetchManifest): Promise<void> {
      manifests.push(manifest);
    },
    async findManifests(query: ArtifactQuery): Promise<readonly FetchManifest[]> {
      return manifests
        .filter((m) => {
          if (query.runId !== undefined && m.runId !== query.runId) return false;
          if (query.taxpayer !== undefined && m.taxpayer !== query.taxpayer) return false;
          if (query.urlContains !== undefined && !m.url.includes(query.urlContains)) return false;
          if (query.since !== undefined && m.retrievedAt < query.since) return false;
          if (query.until !== undefined && m.retrievedAt > query.until) return false;
          return true;
        })
        .sort(
          (a, b) =>
            a.retrievedAt.localeCompare(b.retrievedAt) ||
            a.contentHash.localeCompare(b.contentHash) ||
            a.url.localeCompare(b.url),
        );
    },
    async verify(hashes?: readonly ContentHash[]): Promise<readonly ContentHash[]> {
      const targets = hashes ?? ([...blobs.keys()] as ContentHash[]);
      return [...targets].sort().filter((hash) => {
        const bytes = blobs.get(hash);
        if (bytes === undefined) return true; // missing counts as a failure, same as file-backed
        return createHash('sha256').update(bytes).digest('hex') !== hash;
      });
    },
    async prune(before: string): Promise<readonly ContentHash[]> {
      const newest = new Map<string, string>();
      for (const m of manifests) {
        const prior = newest.get(m.contentHash);
        if (prior === undefined || m.retrievedAt > prior) newest.set(m.contentHash, m.retrievedAt);
      }
      const removed = [...newest.entries()]
        .filter(([hash, at]) => at < before && !extractionRefs.has(hash))
        .map(([hash]) => hash)
        .sort()
        .filter((hash) => blobs.delete(hash));
      return removed as ContentHash[];
    },
  };
}

export function memoryNormalizedStore(): NormalizedStore {
  const byKind = new Map<EntityKind, Map<string, AnyEntity>>();
  const bucket = (kind: EntityKind): Map<string, AnyEntity> => {
    let m = byKind.get(kind);
    if (m === undefined) {
      m = new Map();
      byKind.set(kind, m);
    }
    return m;
  };

  const matches = (row: AnyEntity, filter?: EntityFilter): boolean => {
    if (filter === undefined) return true;
    if (filter.taxpayer !== undefined && row.taxpayer !== filter.taxpayer) return false;
    if (filter.since !== undefined && row.recordedAt < filter.since) return false;
    if (filter.until !== undefined && row.recordedAt > filter.until) return false;
    if (filter.period !== undefined) {
      const bag = row as unknown as Record<string, unknown>;
      const period = bag['period'] ?? bag['key'] ?? bag['anioTributario'];
      if (period !== filter.period) return false;
    }
    if (filter.where !== undefined) {
      const bag = row as unknown as Record<string, unknown>;
      for (const [key, want] of Object.entries(filter.where)) {
        if (bag[key] !== want) return false;
      }
    }
    return true;
  };

  const sorted = (rows: Iterable<AnyEntity>): AnyEntity[] =>
    [...rows].sort((a, b) => a.id.localeCompare(b.id));

  const store: NormalizedStore = {
    async upsert(kind: EntityKind, rows: readonly AnyEntity[]): Promise<void> {
      const b = bucket(kind);
      for (const row of rows) b.set(row.id, row);
    },
    async select(kind: EntityKind, filter?: EntityFilter): Promise<readonly AnyEntity[]> {
      return sorted(bucket(kind).values()).filter((row) => matches(row, filter));
    },
    async get(kind: EntityKind, id: string): Promise<AnyEntity | null> {
      return bucket(kind).get(id) ?? null;
    },
    async count(kind: EntityKind, filter?: EntityFilter): Promise<number> {
      return (await store.select(kind, filter)).length;
    },
    async selectByExtraction(extractionId: string): Promise<readonly AnyEntity[]> {
      const out: AnyEntity[] = [];
      for (const b of byKind.values()) {
        out.push(...[...b.values()].filter((row) => row.derivedFrom === extractionId));
      }
      return sorted(out);
    },
    async retractExtraction(extractionId: string): Promise<number> {
      let removed = 0;
      for (const b of byKind.values()) {
        for (const [id, row] of [...b.entries()]) {
          if (row.derivedFrom === extractionId && b.delete(id)) removed += 1;
        }
      }
      return removed;
    },
    async taxpayers(): Promise<readonly TaxpayerRef[]> {
      const rows = [...bucket('taxpayer').values()] as Taxpayer[];
      return [...new Set(rows.map((t) => t.taxpayer))].sort();
    },
  };

  return store;
}
