// The normativa collection (ADR-043 §I2) — regulation text with stable citation anchors.
//
// THE INVARIANT THIS EXISTS TO ENFORCE: the system never states a tax rule from model weights. It
// retrieves the rule text and cites it, or it says it does not know. Every function here returns
// either stored text WITH its anchor, or nothing. There is no generation path, and adding one
// would defeat the module.
//
// THE HARD REQUIREMENT IS "WHAT APPLIED ON DATE X", NOT "WHAT APPLIES NOW". Audits are
// retrospective: año tributario N is judged by the law in force during commercial year N-1. This
// project already lives that — the same taxpayer's AT2019 observación sat open for seven years
// (ADR-024), and régimenes `M14A`/`REGS`/`FAEL`/`SGGC` coexist across years. So every chunk
// carries a validity INTERVAL and every lookup takes an as-of date. A corpus modelled as "current
// text" would answer old questions with new law — confidently, and wrongly.
//
// STATUS: the store, the as-of query and the load-time validation are IMPLEMENTED. What is not
// here — deliberately — is any text. Transcribing a body and copying its effective ranges from the
// source's own version metadata is a human step (ADR-045 rejected a scraper + inferred dates
// outright), and the corpus lives in the user's local store, not in this repository. Retrieval
// against an empty corpus returns nothing and `ask/` declines, which is correct behaviour rather
// than a gap to paper over.

import { join } from 'node:path';
import { IntegrityError } from '../errors.js';
import { readJsonl, writeJsonl } from '../store/fs-util.js';

/**
 * A stable citation anchor: `<body>/<number>#<subdivision>`.
 *
 * Examples (shape only — none of these is loaded yet):
 *   `DL-825/1974#art-23`          Ley sobre Impuesto a las Ventas y Servicios, artículo 23
 *   `DL-824/1974#art-31-inc-3`    Ley sobre Impuesto a la Renta, artículo 31 inciso 3
 *   `LEY-19983/2004#art-3`        Mérito ejecutivo de la factura (the Art. 3 acuse clock, ADR-036)
 *   `CT/1974#art-200`             Código Tributario, prescripción
 *   `CIRC-SII-49/2016#num-4`      Circular — administrative interpretation, NOT law (see `rank`)
 *
 * STABILITY IS THE CONTRACT: an anchor must survive a re-chunking of the corpus, because rule
 * records and past findings cite it. Anchors are derived from the DOCUMENT'S OWN structure
 * (article/inciso numbers), never from chunk offsets.
 */
export type CitationAnchor = string;

/**
 * Where a text sits in the hierarchy of authority. Load-bearing for conflict resolution: a
 * circular cannot override a ley, and presenting one as if it could is exactly the kind of
 * confident-and-wrong output this project avoids.
 */
export type NormativeRank = 'ley' | 'decreto' | 'resolucion' | 'circular' | 'oficio';

/** A closed half-open interval `[from, to)`. `to: null` means "still in force". */
export interface EffectiveRange {
  readonly from: string;
  readonly to: string | null;
}

export interface NormativaChunk {
  readonly anchor: CitationAnchor;
  /** Short human title, e.g. `Código Tributario, art. 200`. */
  readonly title: string;
  readonly rank: NormativeRank;
  /** The text VERBATIM. Never summarised, never paraphrased — a citation must be quotable. */
  readonly text: string;
  readonly effective: EffectiveRange;
  /** Where this text was obtained. A URL plus the date it was retrieved (provenance, ADR-004). */
  readonly sourceUrl: string;
  readonly retrievedAt: string;
  /**
   * Corpus snapshot id. Frozen into a citation so a later amendment cannot silently rewrite what a
   * past finding claimed the law said.
   */
  readonly corpusVersion: string;
  /** Anchors this text supersedes, replaces or refers to. Powers "show me the amendment chain". */
  readonly relatedAnchors: readonly CitationAnchor[];
}

export interface NormativaQuery {
  /**
   * THE date the question is about — the commercial period under audit, NOT today. Required, with
   * no default: defaulting to `now` is precisely the retrospective bug described above.
   */
  readonly asOf: string;
  /** Free-text terms. Matched lexically against stored text; NO embedding model in this scope. */
  readonly terms?: readonly string[];
  /** Restrict to specific anchors — the path a rule record takes to fetch its own citation. */
  readonly anchors?: readonly CitationAnchor[];
  readonly rank?: readonly NormativeRank[];
  readonly limit?: number;
}

export interface NormativaStore {
  /**
   * Chunks in force on `query.asOf` and matching the filters, best match first. An empty result is
   * a legitimate "we do not have this" — the caller must DECLINE, never fill the gap.
   */
  search(query: NormativaQuery): Promise<readonly NormativaChunk[]>;

  /** One chunk by anchor as it stood on `asOf`, or `null`. The citation-resolution path. */
  resolve(anchor: CitationAnchor, asOf: string): Promise<NormativaChunk | null>;

  /** Every version of an anchor across time, `effective.from` ascending — the amendment chain. */
  history(anchor: CitationAnchor): Promise<readonly NormativaChunk[]>;

  /** Distinct anchors held, for the coverage metric. */
  anchors(): Promise<readonly CitationAnchor[]>;

  /** Add or replace chunks. Called only by a loader, never by the loop's own stages. */
  upsert(chunks: readonly NormativaChunk[]): Promise<void>;
}

/** True when `chunk` was in force on `date`. Half-open: `from` inclusive, `to` exclusive. */
export function inForce(chunk: NormativaChunk, date: string): boolean {
  if (date < chunk.effective.from) return false;
  return chunk.effective.to === null || date < chunk.effective.to;
}

/**
 * The applicable corpus for a scope — the DENOMINATOR of the normativa-coverage metric.
 *
 * Coverage is meaningless without an explicit definition of "applicable": 100% of a corpus nobody
 * chose is not a number worth trending. This declares the intended scope per régimen/surface, and
 * `eval/metrics.ts` measures how much of it is actually loaded.
 */
export interface ApplicableCorpus {
  readonly id: string;
  readonly describes: string;
  /** The anchors an engagement of this kind is expected to be able to cite. */
  readonly expectedAnchors: readonly CitationAnchor[];
}

/**
 * A chunk as TRANSCRIBED from the source, before validation.
 *
 * `effective` is optional and nullable HERE and required on `NormativaChunk`, which is the type
 * system carrying ADR-045's hard rule: a version whose source metadata declares no range does not
 * become a chunk at all. Transcription is deliberately a human step — see `loadChunks`.
 */
export interface NormativaCandidate {
  readonly anchor: CitationAnchor;
  readonly title: string;
  readonly rank: NormativeRank;
  readonly text: string;
  /** COPIED from BCN's own version metadata. Absent or partial ⇒ refused. */
  readonly effective?: { readonly from?: string | null; readonly to?: string | null } | null;
  readonly sourceUrl: string;
  readonly retrievedAt: string;
  readonly corpusVersion: string;
  readonly relatedAnchors?: readonly CitationAnchor[];
}

/**
 * Validate transcribed candidates into loadable chunks, or refuse the batch.
 *
 * WHY THIS IS NOT A SCRAPER. ADR-045 rejected "a generic scraper plus an LLM that infers effective
 * dates" outright, because the failure is silent: an invented date produces a citation that reads
 * authoritative. So the pipeline is deliberately inverted — a human transcribes the text and COPIES
 * the range from the source's own version metadata, and this function's only job is to refuse
 * anything that cannot be dated. It never derives a range, never defaults one, and never guesses.
 *
 * REFUSING THE WHOLE BATCH, not filtering it: a partially-loaded corpus is one whose gaps nobody
 * declared, and coverage would then be measured against a denominator that silently shrank.
 *
 * Throws `IntegrityError` naming the offending anchor so the operator knows what to go and verify.
 */
export function loadChunks(candidates: readonly NormativaCandidate[]): readonly NormativaChunk[] {
  const out: NormativaChunk[] = [];

  for (const c of candidates) {
    const from = c.effective?.from;
    const to = c.effective?.to ?? null;

    if (from === undefined || from === null || from === '') {
      throw new IntegrityError(
        `normativa chunk ${c.anchor} has no effective.from — ADR-045 requires the range to be ` +
          "copied from the source's own version metadata, never inferred from a publication " +
          'date or read off the articulado. Verify it at the source, or do not load the chunk',
      );
    }
    if (to !== null && to <= from) {
      throw new IntegrityError(
        `normativa chunk ${c.anchor} has an empty or inverted effective range ` +
          `[${from}, ${to}) — a version that was never in force cannot be cited`,
      );
    }
    if (c.text.trim() === '') {
      throw new IntegrityError(
        `normativa chunk ${c.anchor} has no text — a citation has to be quotable, and an empty ` +
          'chunk would count toward coverage while citing nothing',
      );
    }
    if (c.sourceUrl.trim() === '' || c.retrievedAt.trim() === '') {
      throw new IntegrityError(
        `normativa chunk ${c.anchor} is missing sourceUrl or retrievedAt — without provenance the ` +
          'text cannot be re-verified against the source later (ADR-004)',
      );
    }

    out.push({
      anchor: c.anchor,
      title: c.title,
      rank: c.rank,
      text: c.text,
      effective: { from, to },
      sourceUrl: c.sourceUrl,
      retrievedAt: c.retrievedAt,
      corpusVersion: c.corpusVersion,
      relatedAnchors: c.relatedAnchors ?? [],
    });
  }

  assertNoOverlap(out);
  return out;
}

/**
 * Two versions of one anchor in force on the same day make `resolve` choose between two texts, and
 * choosing is guessing. Caught at load rather than papered over with an arbitrary tiebreak.
 */
function assertNoOverlap(chunks: readonly NormativaChunk[]): void {
  const byAnchor = new Map<string, NormativaChunk[]>();
  for (const c of chunks) byAnchor.set(c.anchor, [...(byAnchor.get(c.anchor) ?? []), c]);

  for (const [anchor, versions] of byAnchor) {
    const sorted = [...versions].sort((a, b) => a.effective.from.localeCompare(b.effective.from));
    for (let i = 1; i < sorted.length; i += 1) {
      const prev = sorted[i - 1];
      const next = sorted[i];
      if (prev === undefined || next === undefined) continue;
      // Half-open: `prev.to === next.from` is adjacency, not overlap.
      if (prev.effective.to === null || prev.effective.to > next.effective.from) {
        throw new IntegrityError(
          `normativa versions of ${anchor} overlap: [${prev.effective.from}, ${prev.effective.to}) ` +
            `and [${next.effective.from}, ${next.effective.to}) are both in force on ` +
            `${next.effective.from} — resolve() would have to pick between two texts`,
        );
      }
    }
  }
}

/** Authority order for ranking search hits. Lower index wins — a ley outranks a circular. */
const RANK_ORDER: readonly NormativeRank[] = ['ley', 'decreto', 'resolucion', 'circular', 'oficio'];

/** Shared query logic, so the two backends cannot answer the same question differently. */
function queryChunks(
  all: readonly NormativaChunk[],
  query: NormativaQuery,
): readonly NormativaChunk[] {
  const terms = (query.terms ?? []).map((t) => t.toLowerCase()).filter((t) => t !== '');

  const scored = all
    // The as-of filter comes FIRST and is not optional: text out of force on the date is not a
    // weaker answer, it is the wrong year's law.
    .filter((c) => inForce(c, query.asOf))
    .filter((c) => query.anchors === undefined || query.anchors.includes(c.anchor))
    .filter((c) => query.rank === undefined || query.rank.includes(c.rank))
    .map((c) => {
      const haystack = `${c.title}\n${c.text}`.toLowerCase();
      return { chunk: c, hits: terms.filter((t) => haystack.includes(t)).length };
    })
    .filter((s) => terms.length === 0 || s.hits > 0)
    .sort(
      (a, b) =>
        b.hits - a.hits ||
        RANK_ORDER.indexOf(a.chunk.rank) - RANK_ORDER.indexOf(b.chunk.rank) ||
        a.chunk.anchor.localeCompare(b.chunk.anchor),
    )
    .map((s) => s.chunk);

  return query.limit === undefined ? scored : scored.slice(0, Math.max(0, query.limit));
}

/** A version's identity: the anchor plus the instant it took force. */
const versionKey = (c: NormativaChunk): string => `${c.anchor}|${c.effective.from}`;

function storeOver(
  read: () => Promise<readonly NormativaChunk[]>,
  write: (chunks: readonly NormativaChunk[]) => Promise<void>,
): NormativaStore {
  return {
    async search(query) {
      return queryChunks(await read(), query);
    },

    async resolve(anchor, asOf) {
      // At most one version can match, because `loadChunks` refuses overlaps.
      return (await read()).find((c) => c.anchor === anchor && inForce(c, asOf)) ?? null;
    },

    async history(anchor) {
      return (await read())
        .filter((c) => c.anchor === anchor)
        .sort((a, b) => a.effective.from.localeCompare(b.effective.from));
    },

    async anchors() {
      return [...new Set((await read()).map((c) => c.anchor))].sort();
    },

    async upsert(chunks) {
      const current = new Map((await read()).map((c) => [versionKey(c), c]));
      for (const c of chunks) current.set(versionKey(c), c);
      await write(
        [...current.values()].sort(
          (a, b) =>
            a.anchor.localeCompare(b.anchor) || a.effective.from.localeCompare(b.effective.from),
        ),
      );
    },
  };
}

/**
 * File-backed corpus at `<root>/normativa/chunks.jsonl`.
 *
 * Rewritten wholesale on upsert rather than appended, unlike the artifact and entity stores. The
 * corpus is small (ADR-045 scopes it to ~10 anchors, not "Chilean tax law") and correcting a
 * mis-transcribed range must REPLACE the bad version, not leave it in the log where a fold could
 * resurrect it.
 */
export function createFileNormativaStore(root: string): NormativaStore {
  const path = join(root, 'normativa', 'chunks.jsonl');
  return storeOver(
    () => readJsonl<NormativaChunk>(path),
    (chunks) => writeJsonl(path, chunks),
  );
}

/** In-memory peer with identical semantics — same reason as `memoryReviewQueue`. */
export function memoryNormativaStore(): NormativaStore {
  let chunks: readonly NormativaChunk[] = [];
  return storeOver(
    async () => chunks,
    async (next) => {
      chunks = next;
    },
  );
}
