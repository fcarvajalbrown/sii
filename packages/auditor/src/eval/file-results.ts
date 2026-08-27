// File-backed `EvalResultStore` (ADR-043) — "results persisted per run so trends are queryable".
//
// `<root>/eval/<runId>.json`, one document per evaluation. Append-only in effect: a result is
// written once and never revised, because it is the evidence for whatever the gate decided that
// night. Rewriting one would rewrite the justification for a promotion that already happened.
//
// `latest()` is the gate's BASELINE, and it deliberately ignores results that measured nothing:
// a run with zero engagements cannot be a baseline, and treating it as one would let the next
// night's comparison look like a clean improvement from nowhere.

import { join } from 'node:path';
import { atomicWrite, listDir, readFileOrNull } from '../store/fs-util.js';
import type { EvalResult, EvalResultStore } from './result.js';

export function createFileEvalResultStore(root: string): EvalResultStore {
  const dir = join(root, 'eval');
  const pathFor = (runId: string): string => join(dir, `${sanitize(runId)}.json`);

  const loadAll = async (): Promise<readonly EvalResult[]> => {
    const files = (await listDir(dir)).filter((f) => f.endsWith('.json'));
    const out: EvalResult[] = [];
    for (const file of files) {
      const buf = await readFileOrNull(join(dir, file));
      if (buf !== null) out.push(JSON.parse(buf.toString('utf8')) as EvalResult);
    }
    return out.sort(
      (a, b) => a.evaluatedAt.localeCompare(b.evaluatedAt) || a.runId.localeCompare(b.runId),
    );
  };

  return {
    async put(result: EvalResult): Promise<void> {
      await atomicWrite(pathFor(result.runId), JSON.stringify(result, null, 2));
    },

    async get(runId: string): Promise<EvalResult | null> {
      const buf = await readFileOrNull(pathFor(runId));
      return buf === null ? null : (JSON.parse(buf.toString('utf8')) as EvalResult);
    },

    async recent(limit: number): Promise<readonly EvalResult[]> {
      return [...(await loadAll())].reverse().slice(0, limit);
    },

    async latest(): Promise<EvalResult | null> {
      const all = await loadAll();
      for (let i = all.length - 1; i >= 0; i -= 1) {
        const r = all[i];
        // A result that evaluated nothing is not a baseline — see the header note.
        if (r !== undefined && r.engagements.length > 0) return r;
      }
      return null;
    },
  };
}

function sanitize(runId: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(runId)) {
    throw new TypeError(`unsafe runId for a filename: ${JSON.stringify(runId)}`);
  }
  return runId;
}
