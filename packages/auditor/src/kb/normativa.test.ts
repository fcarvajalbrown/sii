// The normativa corpus (ADR-043 §I2, ADR-045).
//
// EVERY TEST HERE IS ABOUT THE SAME FAILURE: answering an old question with new law. Audits are
// retrospective — año tributario N is judged by the law in force during commercial year N-1 — so a
// store that models "current text" is confidently wrong on almost every real question. Absence
// declines; a wrong date ANSWERS. That is why a missing effective range refuses the chunk rather
// than defaulting it, and why `resolve` before a body existed returns `null` and not today's text.
//
// No real legal text appears in these fixtures. The corpus is the user's local store (ADR-045:
// BCN/SII text is not redistributed with the repository), so the machinery is tested on
// shape-only synthetic chunks.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IntegrityError } from '../errors.js';
import {
  createFileNormativaStore,
  loadChunks,
  memoryNormativaStore,
  inForce,
} from './normativa.js';
import type { NormativaCandidate, NormativaChunk, NormativaStore } from './normativa.js';

let root: string;
let store: NormativaStore;

beforeEach(async () => {
  root = await fsp.mkdtemp(join(tmpdir(), 'sii-auditor-normativa-'));
  store = createFileNormativaStore(root);
});

afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

/** Shape-only fixture. The text is a placeholder, never a quotation of real law. */
const chunk = (over: Partial<NormativaChunk> = {}): NormativaChunk => ({
  anchor: 'CT/1974#art-200',
  title: 'Código Tributario, art. 200',
  rank: 'ley',
  text: '<texto de prueba, no es la norma real>',
  effective: { from: '2015-01-01', to: null },
  sourceUrl: 'https://www.bcn.cl/leychile/navegar?idNorma=6374',
  retrievedAt: '2026-08-10T00:00:00.000Z',
  corpusVersion: 'test-corpus-1',
  relatedAnchors: [],
  ...over,
});

const candidate = (over: Partial<NormativaCandidate> = {}): NormativaCandidate => ({
  anchor: 'CT/1974#art-200',
  title: 'Código Tributario, art. 200',
  rank: 'ley',
  text: '<texto de prueba>',
  effective: { from: '2015-01-01', to: null },
  sourceUrl: 'https://www.bcn.cl/leychile/navegar?idNorma=6374',
  retrievedAt: '2026-08-10T00:00:00.000Z',
  corpusVersion: 'test-corpus-1',
  ...over,
});

describe('resolve — what applied on date X, never what applies now', () => {
  // The corpus holds two versions, the earliest taking force in 2017 — so 2016 predates the
  // loaded corpus entirely and must resolve to null rather than to either text.
  const V1 = chunk({ effective: { from: '2017-01-01', to: '2020-01-01' }, text: '<v1>' });
  const V2 = chunk({ effective: { from: '2020-01-01', to: null }, text: '<v2>' });

  it('returns the version in force on the as-of date', async () => {
    await store.upsert([V1, V2]);
    const got = await store.resolve('CT/1974#art-200', '2019-06-30');
    expect(got?.text).toBe('<v1>');
  });

  it('returns the LATER version for a later date', async () => {
    await store.upsert([V1, V2]);
    expect((await store.resolve('CT/1974#art-200', '2023-09-30'))?.text).toBe('<v2>');
  });

  it('returns null before the earliest version — not today’s text', async () => {
    // The roadmap's named case. Falling back to the current text here is the retrospectivity bug:
    // it answers a 2016 question with 2020 law, and answers it confidently.
    await store.upsert([V1, V2]);
    expect(await store.resolve('CT/1974#art-200', '2016-01-01')).toBeNull();
  });

  it('returns null for an anchor the corpus does not hold', async () => {
    expect(await store.resolve('DL-825/1974#art-23', '2023-09-30')).toBeNull();
  });

  it('treats the interval as half-open: `from` inclusive, `to` exclusive', async () => {
    await store.upsert([V1, V2]);
    // On the changeover day the NEW text governs; the old one ended the instant the new began.
    expect((await store.resolve('CT/1974#art-200', '2020-01-01'))?.text).toBe('<v2>');
    expect((await store.resolve('CT/1974#art-200', '2019-12-31'))?.text).toBe('<v1>');
  });

  it('survives a reopen — the corpus is on disk', async () => {
    await store.upsert([V1]);
    expect(
      await createFileNormativaStore(root).resolve('CT/1974#art-200', '2019-06-30'),
    ).not.toBeNull();
  });
});

describe('history — the amendment chain', () => {
  it('returns every version, effective.from ascending', async () => {
    await store.upsert([
      chunk({ effective: { from: '2020-01-01', to: null }, text: '<v2>' }),
      chunk({ effective: { from: '2015-01-01', to: '2020-01-01' }, text: '<v1>' }),
    ]);
    expect((await store.history('CT/1974#art-200')).map((c) => c.text)).toEqual(['<v1>', '<v2>']);
  });

  it('is empty for an unknown anchor', async () => {
    expect(await store.history('DL-825/1974#art-23')).toEqual([]);
  });
});

describe('upsert', () => {
  it('replaces a version in place rather than duplicating it', async () => {
    await store.upsert([chunk({ text: '<first>' })]);
    await store.upsert([chunk({ text: '<corrected>' })]);

    const history = await store.history('CT/1974#art-200');
    expect(history).toHaveLength(1);
    expect(history[0]?.text).toBe('<corrected>');
  });

  it('keeps two DIFFERENT versions of the same anchor apart', async () => {
    await store.upsert([
      chunk({ effective: { from: '2015-01-01', to: '2020-01-01' } }),
      chunk({ effective: { from: '2020-01-01', to: null } }),
    ]);
    expect(await store.history('CT/1974#art-200')).toHaveLength(2);
  });
});

describe('anchors — the coverage numerator', () => {
  it('lists each anchor once regardless of how many versions it has', async () => {
    await store.upsert([
      chunk({ effective: { from: '2015-01-01', to: '2020-01-01' } }),
      chunk({ effective: { from: '2020-01-01', to: null } }),
      chunk({ anchor: 'DL-825/1974#art-23' }),
    ]);
    expect(await store.anchors()).toEqual(['CT/1974#art-200', 'DL-825/1974#art-23']);
  });
});

describe('search', () => {
  it('never returns text that was out of force on the as-of date', async () => {
    await store.upsert([chunk({ effective: { from: '2020-01-01', to: null } })]);
    expect(await store.search({ asOf: '2019-06-30' })).toEqual([]);
  });

  it('filters by rank, so a circular cannot stand in for a ley', async () => {
    await store.upsert([
      chunk({ anchor: 'CT/1974#art-200', rank: 'ley' }),
      chunk({ anchor: 'CIRC-SII-49/2016#num-4', rank: 'circular' }),
    ]);
    const only = await store.search({ asOf: '2023-09-30', rank: ['ley'] });
    expect(only.map((c) => c.anchor)).toEqual(['CT/1974#art-200']);
  });

  it('restricts to requested anchors — how a rule fetches its own citation', async () => {
    await store.upsert([chunk(), chunk({ anchor: 'DL-825/1974#art-23' })]);
    const got = await store.search({ asOf: '2023-09-30', anchors: ['DL-825/1974#art-23'] });
    expect(got.map((c) => c.anchor)).toEqual(['DL-825/1974#art-23']);
  });

  it('ranks a higher authority first when both match', async () => {
    // `rank` exists so a conflict resolves by hierarchy rather than by load order (ADR-045).
    await store.upsert([
      chunk({ anchor: 'CIRC-SII-49/2016#num-4', rank: 'circular', text: 'retención honorarios' }),
      chunk({ anchor: 'DL-824/1974#art-74', rank: 'ley', text: 'retención honorarios' }),
    ]);
    const got = await store.search({ asOf: '2023-09-30', terms: ['retención'] });
    expect(got[0]?.rank).toBe('ley');
  });

  it('honours a limit', async () => {
    await store.upsert([chunk(), chunk({ anchor: 'DL-825/1974#art-23' })]);
    expect(await store.search({ asOf: '2023-09-30', limit: 1 })).toHaveLength(1);
  });

  it('is empty, not an error, against an empty corpus — the caller must DECLINE', async () => {
    expect(await store.search({ asOf: '2023-09-30', terms: ['prescripción'] })).toEqual([]);
  });
});

// ADR-045's hard rule: `effective.from`/`to` are COPIED from BCN's own version metadata, never
// inferred. A version without an explicit range is NOT loaded. The loader is the enforcement point
// because a bad range is undetectable downstream — it produces a citation that reads authoritative.
describe('loadChunks — refusing what cannot be dated', () => {
  it('refuses a chunk whose version metadata carries no range at all', async () => {
    expect(() => loadChunks([candidate({ effective: null })])).toThrow(IntegrityError);
  });

  it('refuses a chunk with no `from`, even when `to` is present', () => {
    expect(() => loadChunks([candidate({ effective: { to: '2020-01-01' } })])).toThrow(
      /effective\.from/,
    );
  });

  it('names the anchor it refused, so the operator knows which one to go and verify', () => {
    expect(() =>
      loadChunks([candidate({ anchor: 'DL-824/1974#art-74', effective: null })]),
    ).toThrow(/DL-824\/1974#art-74/);
  });

  it('refuses an inverted or empty range', () => {
    expect(() =>
      loadChunks([candidate({ effective: { from: '2020-01-01', to: '2015-01-01' } })]),
    ).toThrow(IntegrityError);
    expect(() =>
      loadChunks([candidate({ effective: { from: '2020-01-01', to: '2020-01-01' } })]),
    ).toThrow(IntegrityError);
  });

  it('refuses two versions of one anchor that are in force on the same day', () => {
    // Overlap makes `resolve` pick between two texts, and picking is guessing. Refused at load
    // rather than resolved by an arbitrary tiebreak.
    expect(() =>
      loadChunks([
        candidate({ effective: { from: '2015-01-01', to: '2021-01-01' } }),
        candidate({ effective: { from: '2020-01-01', to: null } }),
      ]),
    ).toThrow(/overlap/i);
  });

  it('refuses empty text — a citation has to be quotable', () => {
    expect(() => loadChunks([candidate({ text: '   ' })])).toThrow(IntegrityError);
  });

  it('refuses a chunk with no source URL or no retrieval date', () => {
    expect(() => loadChunks([candidate({ sourceUrl: '' })])).toThrow(IntegrityError);
    expect(() => loadChunks([candidate({ retrievedAt: '' })])).toThrow(IntegrityError);
  });

  it('accepts a well-formed candidate and normalises it into a chunk', () => {
    const [got] = loadChunks([candidate()]);
    expect(got?.effective).toEqual({ from: '2015-01-01', to: null });
    expect(got?.relatedAnchors).toEqual([]);
  });

  it('accepts adjacent, non-overlapping versions of one anchor', () => {
    const got = loadChunks([
      candidate({ effective: { from: '2015-01-01', to: '2020-01-01' } }),
      candidate({ effective: { from: '2020-01-01', to: null } }),
    ]);
    expect(got).toHaveLength(2);
  });
});

describe('inForce', () => {
  it('is half-open on both ends', () => {
    const c = chunk({ effective: { from: '2020-01-01', to: '2021-01-01' } });
    expect(inForce(c, '2019-12-31')).toBe(false);
    expect(inForce(c, '2020-01-01')).toBe(true);
    expect(inForce(c, '2020-12-31')).toBe(true);
    expect(inForce(c, '2021-01-01')).toBe(false);
  });
});

describe('memory/file parity', () => {
  it('both resolve the same version for the same date', async () => {
    const V1 = chunk({ effective: { from: '2017-01-01', to: '2020-01-01' }, text: '<v1>' });
    const V2 = chunk({ effective: { from: '2020-01-01', to: null }, text: '<v2>' });

    for (const [name, s] of [
      ['file', createFileNormativaStore(root)],
      ['memory', memoryNormativaStore()],
    ] as const) {
      await s.upsert([V1, V2]);
      expect((await s.resolve('CT/1974#art-200', '2019-06-30'))?.text, name).toBe('<v1>');
      expect(await s.resolve('CT/1974#art-200', '2016-01-01'), name).toBeNull();
      expect((await s.history('CT/1974#art-200')).length, name).toBe(2);
    }
  });
});
