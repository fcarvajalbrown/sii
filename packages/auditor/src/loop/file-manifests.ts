// File-backed `RunManifestStore` (ADR-043).
//
// One JSON file per run, atomically replaced after every stage. Whole-file replace rather than an
// append log because a manifest is a SINGLE evolving document, not a stream of rows — and because
// `resume` must read exactly one consistent state, never fold a history to find it.
//
// `<root>/runs/<runId>.json`
//
// The confidentiality check lives in the orchestrator (`persist`), not here: it must run BEFORE the
// dry-run short-circuit, so a leaky manifest is caught even on a run that never writes.

import { join } from 'node:path';
import { assertNoIdentifiers } from '../confidential.js';
import type { RunManifest, RunManifestStore } from './manifest.js';
import { atomicWrite, listDir, readFileOrNull } from '../store/fs-util.js';

export function createFileManifestStore(root: string): RunManifestStore {
  const runsDir = join(root, 'runs');
  const pathFor = (runId: string): string => join(runsDir, `${sanitize(runId)}.json`);

  const loadAll = async (): Promise<readonly RunManifest[]> => {
    const files = (await listDir(runsDir)).filter((f) => f.endsWith('.json'));
    const out: RunManifest[] = [];
    for (const file of files) {
      const buf = await readFileOrNull(join(runsDir, file));
      if (buf !== null) out.push(JSON.parse(buf.toString('utf8')) as RunManifest);
    }
    // `startedAt` is the ordering key, not filename order — a resumed run keeps its original id.
    return out.sort(
      (a, b) => a.startedAt.localeCompare(b.startedAt) || a.runId.localeCompare(b.runId),
    );
  };

  return {
    async save(manifest: RunManifest): Promise<void> {
      // Belt-and-braces with the orchestrator's own check: this store is also reachable directly.
      assertNoIdentifiers(manifest, `run manifest ${manifest.runId}`);
      await atomicWrite(pathFor(manifest.runId), JSON.stringify(manifest, null, 2));
    },

    async load(runId: string): Promise<RunManifest | null> {
      const buf = await readFileOrNull(pathFor(runId));
      return buf === null ? null : (JSON.parse(buf.toString('utf8')) as RunManifest);
    },

    async recent(limit: number): Promise<readonly RunManifest[]> {
      return [...(await loadAll())].reverse().slice(0, limit);
    },

    async lastIncomplete(): Promise<RunManifest | null> {
      const all = await loadAll();
      for (let i = all.length - 1; i >= 0; i -= 1) {
        const m = all[i];
        if (m !== undefined && m.status !== 'completed') return m;
      }
      return null;
    },
  };
}

/** A runId reaches the filesystem as a filename. Refuse anything that could escape the directory. */
function sanitize(runId: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(runId)) {
    throw new TypeError(`unsafe runId for a filename: ${JSON.stringify(runId)}`);
  }
  return runId;
}
