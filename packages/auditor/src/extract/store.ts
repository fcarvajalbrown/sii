// The extraction log (ADR-043) — stage 2's own output, kept per run.
//
// Layout, the path `store/file-backed.ts` already documents and `file-artifacts.ts` already reads:
//
//   <root>/extractions/<runId>.jsonl           ExtractionRecord per line
//   <root>/extractions/<runId>.failures.jsonl  ExtractionFailure per line
//
// THIS IS NOT OPTIONAL BOOKKEEPING. `ArtifactStore.prune` decides what to delete by scanning this
// directory for `provenance.artifact` and keeping anything still referenced. A stage 2 that routed
// records but never wrote them would leave every artifact looking unreferenced, and the next prune
// would delete the bytes its own extractions cite — destroying the evidence chain that is ADR-043's
// first invariant. Failures are written for the same reason: a failure still names the artifact it
// choked on, and that artifact is exactly what a human needs to diagnose it.
//
// Failures are kept, never dropped, for a second reason too: stage 4 clusters them into parser
// fixes. A dropped failure is a bug the loop can never learn from.

import { join } from 'node:path';
import { appendJsonl, listDir, readJsonl } from '../store/fs-util.js';
import type { ExtractionFailure, ExtractionRecord } from './record.js';

export interface ExtractionStore {
  /** Append one run's records. Called once per run by stage 2, so the write lands together. */
  append(runId: string, records: readonly ExtractionRecord[]): Promise<void>;

  /** Append one run's failures. Separate file: a different shape, the same provenance duty. */
  appendFailures(runId: string, failures: readonly ExtractionFailure[]): Promise<void>;

  /** Records of one run, in the order they were written. */
  byRun(runId: string): Promise<readonly ExtractionRecord[]>;

  /** Failures of one run. */
  failuresByRun(runId: string): Promise<readonly ExtractionFailure[]>;

  /** Total records across every run — the denominator the nightly report trends. */
  count(): Promise<number>;

  /**
   * Every artifact hash referenced by ANY record or failure, across every run — the "attempted"
   * set stage 2's pending-discovery folds against (ADR-046). A failure counts as attempted:
   * retrying a broken artifact nightly is a backfill decision after a parser fix, not the default.
   */
  referencedArtifacts(): Promise<ReadonlySet<string>>;
}

/** A runId reaches the filesystem as a filename. Refuse anything that could escape the directory. */
function sanitize(runId: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(runId)) {
    throw new TypeError(`unsafe runId for a filename: ${JSON.stringify(runId)}`);
  }
  return runId;
}

export function createFileExtractionStore(root: string): ExtractionStore {
  const dir = join(root, 'extractions');
  const recordsPath = (runId: string): string => join(dir, `${sanitize(runId)}.jsonl`);
  const failuresPath = (runId: string): string => join(dir, `${sanitize(runId)}.failures.jsonl`);

  return {
    async append(runId, records) {
      await appendJsonl(recordsPath(runId), records);
    },
    async appendFailures(runId, failures) {
      await appendJsonl(failuresPath(runId), failures);
    },
    async byRun(runId) {
      return readJsonl<ExtractionRecord>(recordsPath(runId));
    },
    async failuresByRun(runId) {
      return readJsonl<ExtractionFailure>(failuresPath(runId));
    },
    async count() {
      let total = 0;
      for (const file of await listDir(dir)) {
        // `.failures.jsonl` also ends in `.jsonl`; counting it would inflate the record count with
        // things that are, by definition, not records.
        if (!file.endsWith('.jsonl') || file.endsWith('.failures.jsonl')) continue;
        total += (await readJsonl<ExtractionRecord>(join(dir, file))).length;
      }
      return total;
    },
    async referencedArtifacts() {
      // Records AND failures — both cite the artifact they read, and both mean "attempted".
      const referenced = new Set<string>();
      for (const file of await listDir(dir)) {
        if (!file.endsWith('.jsonl')) continue;
        for (const row of await readJsonl<ExtractionRecord | ExtractionFailure>(join(dir, file))) {
          referenced.add(row.provenance.artifact);
        }
      }
      return referenced;
    },
  };
}

/** In-memory peer with identical semantics — same reason as `memoryReviewQueue`. */
export function memoryExtractionStore(): ExtractionStore {
  const records = new Map<string, ExtractionRecord[]>();
  const failures = new Map<string, ExtractionFailure[]>();

  return {
    async append(runId, rows) {
      records.set(runId, [...(records.get(runId) ?? []), ...rows]);
    },
    async appendFailures(runId, rows) {
      failures.set(runId, [...(failures.get(runId) ?? []), ...rows]);
    },
    async byRun(runId) {
      return records.get(runId) ?? [];
    },
    async failuresByRun(runId) {
      return failures.get(runId) ?? [];
    },
    async count() {
      return [...records.values()].reduce((n, rows) => n + rows.length, 0);
    },
    async referencedArtifacts() {
      const referenced = new Set<string>();
      for (const rows of records.values()) for (const r of rows) referenced.add(r.provenance.artifact);
      for (const rows of failures.values()) for (const f of rows) referenced.add(f.provenance.artifact);
      return referenced;
    },
  };
}
