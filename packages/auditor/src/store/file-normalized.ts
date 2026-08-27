// File-backed `NormalizedStore` (ADR-043) — the entity layer.
//
// Layout: `<root>/entities/<kind>.jsonl`, append-only, LAST WRITE WINS on `id`.
//
// WHY APPEND-ONLY WITH FOLD-ON-READ, rather than rewriting the file per upsert:
//
//   * A write costs O(rows added), not O(rows total). Ingest upserts per period; a year of RCV is
//     tens of thousands of rows and rewriting all of them twelve times is pointless work.
//   * A crash mid-write loses the tail line, not the file — and `readJsonl` distinguishes a torn
//     final append from real corruption, so a partial upsert degrades to "that row did not land"
//     rather than to a silently shorter store.
//   * It matches the append-only spirit of the artifact store beside it.
//
// The cost is duplicate rows for a re-upserted id, paid on read by folding and repaid by
// `compact()`. At this domain's scale (one taxpayer-year is single-digit MB) folding is
// milliseconds. `retractExtraction` compacts as a side effect, since it must rewrite anyway.
//
// DETERMINISM (ADR-043 §I5): every read sorts by `id` ascending, so two identical runs produce
// identical output and a diff between runs is signal rather than iteration-order noise.

import { join } from 'node:path';
import type { AnyEntity, EntityKind, TaxpayerRef, Taxpayer } from './entities.js';
import type { EntityFilter, NormalizedStore } from './normalized.js';
import type { StoreConfig } from './file-backed.js';
import { appendJsonl, listDir, readJsonl, writeJsonl } from './fs-util.js';

/** Every kind the store knows, so `selectByExtraction` can sweep without a registry. */
const KINDS: readonly EntityKind[] = [
  'taxpayer',
  'period',
  'taxReturnForm',
  'formLine',
  'observacion',
  'ledgerEntry',
  'electronicInvoice',
  'journalEntry',
  'swornStatement',
  'giro',
  'communication',
];

/** Extended surface of the file backend. `compact` is a storage concern, not a domain one, so it
 *  is deliberately absent from `NormalizedStore` — a SQL adapter would have no use for it. */
export interface FileNormalizedStore extends NormalizedStore {
  /** Rewrite a kind's file with one row per id. Returns how many duplicate rows were dropped. */
  compact(kind: EntityKind): Promise<number>;
}

export function createFileNormalizedStore(config: StoreConfig): FileNormalizedStore {
  const entitiesDir = join(config.root, 'entities');
  const pathFor = (kind: EntityKind): string => join(entitiesDir, `${kind}.jsonl`);

  /** Fold the append log into current state: last occurrence of an id wins, sorted by id. */
  const load = async (kind: EntityKind): Promise<readonly AnyEntity[]> => {
    const rows = await readJsonl<AnyEntity>(pathFor(kind));
    const byId = new Map<string, AnyEntity>();
    for (const row of rows) byId.set(row.id, row);
    return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  };

  const matches = (row: AnyEntity, filter?: EntityFilter): boolean => {
    if (filter === undefined) return true;
    if (filter.taxpayer !== undefined && row.taxpayer !== filter.taxpayer) return false;
    if (filter.since !== undefined && row.recordedAt < filter.since) return false;
    if (filter.until !== undefined && row.recordedAt > filter.until) return false;
    if (filter.period !== undefined && periodOf(row) !== filter.period) return false;
    if (filter.where !== undefined) {
      const bag = row as unknown as Record<string, unknown>;
      for (const [key, want] of Object.entries(filter.where)) {
        if (bag[key] !== want) return false;
      }
    }
    return true;
  };

  const store: FileNormalizedStore = {
    async upsert(kind: EntityKind, rows: readonly AnyEntity[]): Promise<void> {
      // One append call for the whole batch — that is what makes an upsert land together.
      await appendJsonl(pathFor(kind), rows);
    },

    async select(kind: EntityKind, filter?: EntityFilter): Promise<readonly AnyEntity[]> {
      return (await load(kind)).filter((row) => matches(row, filter));
    },

    async get(kind: EntityKind, id: string): Promise<AnyEntity | null> {
      return (await load(kind)).find((row) => row.id === id) ?? null;
    },

    async count(kind: EntityKind, filter?: EntityFilter): Promise<number> {
      return (await store.select(kind, filter)).length;
    },

    async selectByExtraction(extractionId: string): Promise<readonly AnyEntity[]> {
      const out: AnyEntity[] = [];
      for (const kind of KINDS) {
        out.push(...(await load(kind)).filter((row) => row.derivedFrom === extractionId));
      }
      return out.sort((a, b) => a.id.localeCompare(b.id));
    },

    /**
     * Remove every row an extraction produced.
     *
     * Used when a strategy is found faulty and its output must be WITHDRAWN rather than corrected
     * in place — a store that keeps a superseded figure alongside its replacement holds two
     * answers to one question, and nothing downstream can tell which is current.
     */
    async retractExtraction(extractionId: string): Promise<number> {
      let removed = 0;
      for (const kind of KINDS) {
        const current = await load(kind);
        const keep = current.filter((row) => row.derivedFrom !== extractionId);
        if (keep.length === current.length) continue;
        removed += current.length - keep.length;
        // Rewrites anyway, so this compacts the log as a side effect.
        await writeJsonl(pathFor(kind), keep);
      }
      return removed;
    },

    async taxpayers(): Promise<readonly TaxpayerRef[]> {
      const rows = (await load('taxpayer')) as readonly Taxpayer[];
      return [...new Set(rows.map((t) => t.taxpayer))].sort();
    },

    async compact(kind: EntityKind): Promise<number> {
      const raw = await readJsonl<AnyEntity>(pathFor(kind));
      const folded = await load(kind);
      if (raw.length === folded.length) return 0;
      await writeJsonl(pathFor(kind), folded);
      return raw.length - folded.length;
    },
  };

  return store;
}

/** Kinds name their period differently (`Period.key` vs `period` elsewhere) — normalise for the
 *  filter rather than forcing callers to know which. */
function periodOf(row: AnyEntity): string | undefined {
  const bag = row as unknown as Record<string, unknown>;
  const value = bag['period'] ?? bag['key'] ?? bag['anioTributario'];
  return typeof value === 'string' ? value : undefined;
}

/** Kinds present on disk — for diagnostics and for a caller that wants to compact everything. */
export async function storedKinds(config: StoreConfig): Promise<readonly EntityKind[]> {
  const files = await listDir(join(config.root, 'entities'));
  return KINDS.filter((k) => files.includes(`${k}.jsonl`));
}
