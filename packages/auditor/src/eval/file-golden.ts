// File-backed `GoldenSet` (ADR-043) — reads completed engagements from disk.
//
// Layout under `$SII_AUDITOR_GOLDEN_DIR`, OUTSIDE the repository (it is real client tax data):
//
//   <engagementId>/manifest.json                EngagementManifest
//   <engagementId>/artifacts/<sha256>           the raw SII responses the engagement was decided on
//   <engagementId>/artifacts/manifests.jsonl    the FetchManifest of each artifact above
//   <engagementId>/expected/extractions.jsonl   ExpectedField per line
//   <engagementId>/expected/findings.jsonl      ExpectedFinding per line (INCLUDING dismissed)
//   <engagementId>/expected/citations.jsonl     ExpectedCitation per line
//
// ARTIFACTS ARE FLAT HERE, not sharded like the main store. A golden engagement is hand-curated —
// a human copies files in — and two levels of hex directories would make that needlessly awkward
// for the dozens of files an engagement holds.
//
// `version()` HASHES THE CONTENT, not an mtime or a counter. A metric shift caused by the golden
// set CHANGING must be distinguishable from one caused by the code changing, and only a content
// hash makes that reliable across machines and checkouts.

import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { IntegrityError } from '../errors.js';
import { listDir, readFileOrNull, readJsonl } from '../store/fs-util.js';
import type { FetchManifest } from '../ingest/manifest.js';
import type {
  EngagementId,
  EngagementManifest,
  ExpectedCitation,
  ExpectedField,
  ExpectedFinding,
  GoldenEngagement,
  GoldenSet,
} from './golden.js';

/** The file backend, plus the staging-only view of unsealed work. */
export interface FileGoldenSet extends GoldenSet {
  /** Every engagement directory, sealed or NOT. For tooling that stages and seals; the harness
   *  must never use this — it would measure against ground truth that can still change. */
  listAll(): Promise<readonly EngagementId[]>;
}

export function createFileGoldenSet(root: string): FileGoldenSet {
  const dirFor = (id: EngagementId): string => join(root, sanitize(id));

  /**
   * SEALED and NOT-SUPERSEDED engagements only.
   *
   * An unsealed engagement is a legitimate work in progress — its artifacts are staged but its
   * ground truth is not written yet — so it is INVISIBLE here rather than an error. Listing it
   * would make `version()` and the harness throw on it, which means one in-progress engagement
   * would take down evaluation for every finished one.
   *
   * A MALFORMED manifest is a different thing entirely and still throws: that is corruption, and a
   * golden set that is only partly readable yields a wrong metric, which is worse than no metric
   * (the same instinct as `readJsonl`'s corrupt-line rule).
   */
  const listIds = async (): Promise<readonly EngagementId[]> => {
    const entries = await listDir(root);
    const ids: EngagementId[] = [];
    for (const entry of entries) {
      // An engagement is a directory holding a manifest. Anything else is ignored, so a stray
      // README or .DS_Store beside them is harmless.
      const raw = await readFileOrNull(join(root, entry, 'manifest.json'));
      if (raw === null) continue;

      let parsed: EngagementManifest;
      try {
        parsed = JSON.parse(raw.toString('utf8')) as EngagementManifest;
      } catch {
        throw new IntegrityError(`golden engagement ${entry} has a malformed manifest.json`);
      }
      const sealed = typeof parsed.sealedAt === 'string' && parsed.sealedAt.trim() !== '';
      const superseded =
        typeof parsed.supersededBy === 'string' && parsed.supersededBy.trim() !== '';
      if (sealed && !superseded) ids.push(entry);
    }
    return ids.sort();
  };

  /** Every engagement directory, sealed or not — for tooling that stages and seals them. */
  const listAllIds = async (): Promise<readonly EngagementId[]> => {
    const entries = await listDir(root);
    const ids: EngagementId[] = [];
    for (const entry of entries) {
      if ((await readFileOrNull(join(root, entry, 'manifest.json'))) !== null) ids.push(entry);
    }
    return ids.sort();
  };

  const loadEngagement = async (id: EngagementId): Promise<GoldenEngagement> => {
    const dir = dirFor(id);
    const raw = await readFileOrNull(join(dir, 'manifest.json'));
    if (raw === null) throw new IntegrityError(`golden engagement ${id} has no manifest.json`);

    const manifest = JSON.parse(raw.toString('utf8')) as EngagementManifest;
    if (manifest.id !== id) {
      // A copied-and-renamed directory whose manifest still names the original would silently
      // evaluate the wrong engagement's ground truth against the wrong artifacts.
      throw new IntegrityError(
        `golden engagement directory '${id}' holds a manifest for '${manifest.id}'`,
      );
    }
    if (manifest.sealedAt.trim() === '') {
      throw new IntegrityError(
        `golden engagement ${id} is not sealed — an unsealed engagement can still change, so ` +
          'measuring against it measures nothing stable',
      );
    }

    return {
      manifest,
      manifests: await readJsonl<FetchManifest>(join(dir, 'artifacts', 'manifests.jsonl')),
      fields: await readJsonl<ExpectedField>(join(dir, 'expected', 'extractions.jsonl')),
      findings: await readJsonl<ExpectedFinding>(join(dir, 'expected', 'findings.jsonl')),
      citations: await readJsonl<ExpectedCitation>(join(dir, 'expected', 'citations.jsonl')),
    };
  };

  return {
    list: listIds,
    load: loadEngagement,
    // Not part of `GoldenSet` — staging tooling needs to see unsealed work; the harness must not.
    listAll: listAllIds,

    async artifact(id: EngagementId, hash: string): Promise<Buffer | null> {
      if (!/^[0-9a-f]{64}$/.test(hash)) {
        throw new TypeError(`not a sha-256 hex digest: ${hash}`);
      }
      return readFileOrNull(join(dirFor(id), 'artifacts', hash));
    },

    /**
     * Content hash over every sealed engagement, in id order.
     *
     * Empty set ⇒ the empty string, NOT a hash of nothing. `gate.ts` treats a blank
     * `goldenSetVersion` as `no_golden_set` and rejects everything, which is the behaviour we want
     * when the directory is missing or misconfigured — a hash of an empty list would look like a
     * perfectly valid version and let the gate proceed.
     */
    async version(): Promise<string> {
      const ids = await listIds();
      if (ids.length === 0) return '';

      const digest = createHash('sha256');
      for (const id of ids) {
        const engagement = await loadEngagement(id);
        digest.update(id);
        digest.update(JSON.stringify(engagement.manifest));
        for (const m of engagement.manifests) digest.update(JSON.stringify(m));
        // Ground truth only. Artifact bytes are already covered by the hashes inside `fields`.
        for (const f of engagement.fields) digest.update(JSON.stringify(f));
        for (const f of engagement.findings) digest.update(JSON.stringify(f));
        for (const c of engagement.citations) digest.update(JSON.stringify(c));
      }
      return digest.digest('hex').slice(0, 16);
    },
  };
}

function sanitize(id: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(id)) {
    throw new TypeError(`unsafe engagement id for a path: ${JSON.stringify(id)}`);
  }
  return id;
}
