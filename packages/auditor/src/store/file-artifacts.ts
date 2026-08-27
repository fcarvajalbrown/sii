// File-backed `ArtifactStore` (ADR-043) — the immutable evidence layer.
//
// Layout under the store root:
//
//   <root>/artifacts/<aa>/<bb>/<sha256>     raw bytes, written once, never modified
//   <root>/manifests/<runId>.jsonl          one FetchManifest per line, append-only
//   <root>/extractions/<runId>.jsonl        ExtractionRecords (read here only, for `prune`)
//
// IMMUTABILITY IS THE KEY, LITERALLY. The filename IS the SHA-256 of the contents, so an artifact
// cannot be altered without becoming a different artifact. A citation stays checkable a year later:
// re-hash the bytes, compare against the hash in the provenance. `verify` does exactly that.
//
// DE-DUPLICATION IS A FEATURE, NOT A SPACE SAVING. When tonight's F22 hashes to last night's value,
// nothing changed — no re-extraction, no diff, no alert. Each fetch still gets its OWN manifest, so
// "we checked again and it was the same" and "we never checked" stay distinguishable.

import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { contentHash } from '../provenance.js';
import type { ContentHash } from '../provenance.js';
import type { FetchManifest } from '../ingest/manifest.js';
import type { ArtifactQuery, ArtifactStore } from './artifacts.js';
import type { StoreConfig } from './file-backed.js';
import {
  appendJsonl,
  atomicWrite,
  listDir,
  readFileOrNull,
  readJsonl,
  shardedPath,
} from './fs-util.js';

/** Shape of the extraction records `prune` consults. Structural, to avoid a store→extract import. */
interface ExtractionReference {
  readonly provenance?: { readonly artifact?: string };
}

export function createFileArtifactStore(config: StoreConfig): ArtifactStore {
  const artifactsDir = join(config.root, 'artifacts');
  const manifestsDir = join(config.root, 'manifests');
  const extractionsDir = join(config.root, 'extractions');

  const manifestPath = (runId: string): string => join(manifestsDir, `${sanitize(runId)}.jsonl`);

  const allManifests = async (runId?: string): Promise<readonly FetchManifest[]> => {
    const files =
      runId === undefined
        ? (await listDir(manifestsDir)).filter((f) => f.endsWith('.jsonl'))
        : [`${sanitize(runId)}.jsonl`];
    const out: FetchManifest[] = [];
    for (const file of files) {
      out.push(...(await readJsonl<FetchManifest>(join(manifestsDir, file))));
    }
    return out;
  };

  return {
    async put(bytes: Buffer): Promise<ContentHash> {
      const hash = contentHash(createHash('sha256').update(bytes).digest('hex'));
      const target = shardedPath(artifactsDir, hash);
      // Idempotent: identical bytes are one artifact. Skipping the write also preserves the
      // ORIGINAL file's mtime, which is what makes "first seen" meaningful.
      if (await exists(target)) return hash;
      // temp+rename, so a reader never sees a half-written artifact. A concurrent writer that wins
      // the race is harmless: the content is identical by construction.
      await atomicWrite(target, bytes);
      return hash;
    },

    async get(hash: ContentHash): Promise<Buffer | null> {
      return readFileOrNull(shardedPath(artifactsDir, hash));
    },

    async has(hash: ContentHash): Promise<boolean> {
      return exists(shardedPath(artifactsDir, hash));
    },

    async putManifest(manifest: FetchManifest): Promise<void> {
      await appendJsonl(manifestPath(manifest.runId), [manifest]);
    },

    async findManifests(query: ArtifactQuery): Promise<readonly FetchManifest[]> {
      const rows = await allManifests(query.runId);
      return rows
        .filter((m) => {
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

    /**
     * Re-hash stored bytes and report the ones that do not match their key.
     *
     * A MISSING artifact counts as a failure too: a citation that points at bytes which are no
     * longer there is exactly as unusable as one pointing at altered bytes, and reporting only
     * corruption would let a pruned-but-still-cited artifact pass a verification run.
     */
    async verify(hashes?: readonly ContentHash[]): Promise<readonly ContentHash[]> {
      const targets = hashes ?? (await storedHashes(artifactsDir));
      const failures: ContentHash[] = [];
      for (const hash of [...targets].sort()) {
        const bytes = await readFileOrNull(shardedPath(artifactsDir, hash));
        if (bytes === null) {
          failures.push(hash);
          continue;
        }
        if (createHash('sha256').update(bytes).digest('hex') !== hash) failures.push(hash);
      }
      return failures;
    },

    /**
     * Drop artifacts whose every manifest predates `before` and which no retained extraction
     * references.
     *
     * MANIFESTS ARE NEVER DELETED. They are the record that a fetch happened, and erasing them
     * would erase the audit trail this store exists to be. After a prune, `has()` returns false
     * while the manifest still says the fetch occurred — the honest encoding of "we looked, and we
     * no longer keep what we saw".
     */
    async prune(before: string): Promise<readonly ContentHash[]> {
      const manifests = await allManifests();
      const newestByHash = new Map<string, string>();
      for (const m of manifests) {
        const prior = newestByHash.get(m.contentHash);
        if (prior === undefined || m.retrievedAt > prior)
          newestByHash.set(m.contentHash, m.retrievedAt);
      }

      const referenced = await referencedHashes(extractionsDir);
      const doomed = [...newestByHash.entries()]
        .filter(([hash, newest]) => newest < before && !referenced.has(hash))
        .map(([hash]) => hash)
        .sort();

      const removed: ContentHash[] = [];
      for (const hash of doomed) {
        try {
          await fsp.unlink(shardedPath(artifactsDir, hash));
          removed.push(hash as ContentHash);
        } catch (err) {
          // Already gone is success for a prune; anything else is a real fault worth surfacing.
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        }
      }
      return removed;
    },
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await fsp.access(path);
    return true;
  } catch {
    return false;
  }
}

/** Walk the two-level shard tree. Sorted at every level, so traversal order is deterministic. */
async function storedHashes(artifactsDir: string): Promise<readonly ContentHash[]> {
  const out: ContentHash[] = [];
  for (const aa of await listDir(artifactsDir)) {
    for (const bb of await listDir(join(artifactsDir, aa))) {
      for (const name of await listDir(join(artifactsDir, aa, bb))) {
        if (/^[0-9a-f]{64}$/.test(name)) out.push(name as ContentHash);
      }
    }
  }
  return out;
}

async function referencedHashes(extractionsDir: string): Promise<ReadonlySet<string>> {
  const refs = new Set<string>();
  for (const file of (await listDir(extractionsDir)).filter((f) => f.endsWith('.jsonl'))) {
    for (const row of await readJsonl<ExtractionReference>(join(extractionsDir, file))) {
      const hash = row.provenance?.artifact;
      if (hash !== undefined) refs.add(hash);
    }
  }
  return refs;
}

/** A runId reaches the filesystem as a filename. Refuse anything that could escape the directory. */
function sanitize(runId: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(runId)) {
    throw new TypeError(`unsafe runId for a filename: ${JSON.stringify(runId)}`);
  }
  return runId;
}
