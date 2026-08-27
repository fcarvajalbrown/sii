import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfidentialityError, IntegrityError } from '../errors.js';
import { contentHash, instant } from '../provenance.js';
import type { ContentHash } from '../provenance.js';
import type { FetchManifest } from '../ingest/manifest.js';
import type { AnyEntity, LedgerEntry, Taxpayer } from './entities.js';
import { entityId } from './normalized.js';
import {
  DEFAULT_STORE_ROOT,
  createFileArtifactStore,
  createFileNormalizedStore,
  resolveStoreRoot,
  storedKinds,
} from './file-backed.js';
import { readJsonl } from './fs-util.js';
import { memoryArtifactStore } from './memory.js';

let root: string;

beforeEach(async () => {
  root = await fsp.mkdtemp(join(tmpdir(), 'sii-auditor-test-'));
});

afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

const manifest = (over: Partial<FetchManifest> & { contentHash: ContentHash }): FetchManifest => ({
  url: 'https://www4.sii.cl/rcvInternet/getResumen',
  transport: 'requestJson',
  httpStatus: 200,
  retrievedAt: instant('2026-08-06T03:00:00.000Z'),
  contentType: 'application/json',
  byteLength: 3,
  durationMs: 10,
  taxpayer: 'tk-aaa',
  runId: 'run-1',
  ...over,
});

describe('resolveStoreRoot', () => {
  it('refuses a root inside the working tree — it holds raw SII responses', () => {
    expect(() => resolveStoreRoot(join(process.cwd(), 'store'), process.cwd())).toThrow(
      ConfidentialityError,
    );
  });

  it('refuses the working tree itself', () => {
    expect(() => resolveStoreRoot(process.cwd(), process.cwd())).toThrow(/inside the working tree/);
  });

  it('accepts a root outside the working tree', () => {
    expect(resolveStoreRoot(root, process.cwd())).toBe(root);
  });

  it('falls back to the default when unset or blank', () => {
    expect(resolveStoreRoot(undefined, process.cwd())).toBe(DEFAULT_STORE_ROOT);
    expect(resolveStoreRoot('   ', process.cwd())).toBe(DEFAULT_STORE_ROOT);
  });
});

describe('ArtifactStore', () => {
  it('keys an artifact by the sha-256 of its bytes', async () => {
    const store = createFileArtifactStore({ root });
    const hash = await store.put(Buffer.from('hello'));
    // Well-known digest of "hello".
    expect(hash).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  });

  it('round-trips bytes exactly, including binary', async () => {
    const store = createFileArtifactStore({ root });
    const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0xfe]);
    const hash = await store.put(bytes);
    expect(await store.get(hash)).toEqual(bytes);
  });

  it('de-duplicates identical bytes — that IS the "nothing changed" signal', async () => {
    const store = createFileArtifactStore({ root });
    const a = await store.put(Buffer.from('same'));
    const b = await store.put(Buffer.from('same'));
    expect(a).toBe(b);

    const files = await readJsonl(join(root, 'nope.jsonl')); // absent file ⇒ []
    expect(files).toEqual([]);
  });

  it('returns null for an unknown hash rather than throwing', async () => {
    const store = createFileArtifactStore({ root });
    expect(await store.get(contentHash('0'.repeat(64)))).toBeNull();
    expect(await store.has(contentHash('0'.repeat(64)))).toBe(false);
  });

  it('records one manifest per fetch even when the artifact is shared', async () => {
    const store = createFileArtifactStore({ root });
    const hash = await store.put(Buffer.from('same'));
    await store.putManifest(
      manifest({ contentHash: hash, retrievedAt: instant('2026-08-05T03:00:00.000Z') }),
    );
    await store.putManifest(
      manifest({ contentHash: hash, retrievedAt: instant('2026-08-06T03:00:00.000Z') }),
    );

    const found = await store.findManifests({});
    expect(found).toHaveLength(2);
    // "we checked again and it was the same" stays distinguishable from "we never checked".
    expect(found.map((m) => m.retrievedAt)).toEqual([
      '2026-08-05T03:00:00.000Z',
      '2026-08-06T03:00:00.000Z',
    ]);
  });

  it('filters manifests and returns them in a deterministic order', async () => {
    const store = createFileArtifactStore({ root });
    const h = await store.put(Buffer.from('x'));
    await store.putManifest(manifest({ contentHash: h, taxpayer: 'tk-bbb', runId: 'run-2' }));
    await store.putManifest(
      manifest({ contentHash: h, url: 'https://www2.sii.cl/app/djconsulta' }),
    );

    expect(await store.findManifests({ taxpayer: 'tk-bbb' })).toHaveLength(1);
    expect(await store.findManifests({ urlContains: 'djconsulta' })).toHaveLength(1);
    expect(await store.findManifests({ runId: 'run-2' })).toHaveLength(1);
    expect(await store.findManifests({ since: '2027-01-01T00:00:00.000Z' })).toHaveLength(0);
  });

  it('verifies stored bytes against their key', async () => {
    const store = createFileArtifactStore({ root });
    const hash = await store.put(Buffer.from('evidence'));
    expect(await store.verify()).toEqual([]);

    // Tamper on disk — the only way an artifact can diverge from its key.
    await fsp.writeFile(
      join(root, 'artifacts', hash.slice(0, 2), hash.slice(2, 4), hash),
      'altered',
    );
    expect(await store.verify()).toEqual([hash]);
  });

  it('reports a MISSING artifact as a verification failure', async () => {
    const store = createFileArtifactStore({ root });
    // A citation pointing at bytes that are gone is as unusable as one pointing at altered bytes.
    expect(await store.verify([contentHash('a'.repeat(64))])).toEqual(['a'.repeat(64)]);
  });

  it('prunes only artifacts whose every manifest predates the cutoff', async () => {
    const store = createFileArtifactStore({ root });
    const old = await store.put(Buffer.from('old'));
    const fresh = await store.put(Buffer.from('fresh'));
    await store.putManifest(
      manifest({ contentHash: old, retrievedAt: instant('2026-01-01T00:00:00.000Z') }),
    );
    await store.putManifest(
      manifest({ contentHash: fresh, retrievedAt: instant('2026-08-06T00:00:00.000Z') }),
    );

    expect(await store.prune('2026-06-01T00:00:00.000Z')).toEqual([old]);
    expect(await store.has(old)).toBe(false);
    expect(await store.has(fresh)).toBe(true);
  });

  it('never deletes a manifest — the record that a fetch happened IS the audit trail', async () => {
    const store = createFileArtifactStore({ root });
    const hash = await store.put(Buffer.from('old'));
    await store.putManifest(
      manifest({ contentHash: hash, retrievedAt: instant('2026-01-01T00:00:00.000Z') }),
    );

    await store.prune('2026-06-01T00:00:00.000Z');
    expect(await store.findManifests({})).toHaveLength(1);
    expect(await store.has(hash)).toBe(false);
  });

  it('never prunes an artifact a retained extraction still cites', async () => {
    const store = createFileArtifactStore({ root });
    const cited = await store.put(Buffer.from('cited'));
    const uncited = await store.put(Buffer.from('uncited'));
    for (const h of [cited, uncited]) {
      await store.putManifest(
        manifest({ contentHash: h, retrievedAt: instant('2026-01-01T00:00:00.000Z') }),
      );
    }
    // An extraction record referencing `cited` — how a live figure keeps its evidence alive.
    await fsp.mkdir(join(root, 'extractions'), { recursive: true });
    await fsp.writeFile(
      join(root, 'extractions', 'run-1.jsonl'),
      `${JSON.stringify({ id: 'e1', provenance: { artifact: cited } })}\n`,
    );

    expect(await store.prune('2026-06-01T00:00:00.000Z')).toEqual([uncited]);
    expect(await store.has(cited)).toBe(true);
  });

  it('rejects a runId that could escape the manifests directory', async () => {
    const store = createFileArtifactStore({ root });
    const hash = await store.put(Buffer.from('x'));
    await expect(
      store.putManifest(manifest({ contentHash: hash, runId: '../../etc/passwd' })),
    ).rejects.toThrow(/unsafe runId/);
  });
});

describe('the memory store keeps parity with the file store', () => {
  it('protects an artifact a retained extraction still references', async () => {
    // The file store discovers references by reading `<root>/extractions/*.jsonl`. The memory store
    // has no such file, so it must be told — otherwise the two would diverge silently and only
    // bite in production.
    const store = memoryArtifactStore();
    const kept = await store.put(Buffer.from('cited'));
    const dropped = await store.put(Buffer.from('uncited'));
    for (const h of [kept, dropped]) {
      await store.putManifest(
        manifest({ contentHash: h, retrievedAt: instant('2026-01-01T00:00:00.000Z') }),
      );
    }
    store.noteExtractionRef(kept);

    expect(await store.prune('2026-06-01T00:00:00.000Z')).toEqual([dropped]);
    expect(await store.has(kept)).toBe(true);
  });

  it('agrees with the file store on hashing, de-duplication and verification', async () => {
    const mem = memoryArtifactStore();
    const file = createFileArtifactStore({ root });
    const bytes = Buffer.from('parity');

    expect(await mem.put(bytes)).toBe(await file.put(bytes));
    expect(await mem.put(bytes)).toBe(await file.put(bytes)); // idempotent on both
    expect(await mem.verify()).toEqual(await file.verify());
    expect(await mem.verify([contentHash('b'.repeat(64))])).toEqual(
      await file.verify([contentHash('b'.repeat(64))]),
    );
  });
});

describe('NormalizedStore', () => {
  const now = '2026-08-06T03:00:00.000Z';

  const ledger = (folio: string, over: Partial<LedgerEntry> = {}): LedgerEntry => ({
    id: entityId('ledgerEntry', 'tk-aaa', '202403', '33', folio),
    taxpayer: 'tk-aaa',
    derivedFrom: 'ext-1',
    recordedAt: now,
    period: '202403',
    side: 'COMPRA',
    tipoDoc: '33',
    folio,
    fechaEmision: '2024-03-15',
    montoNeto: 1000,
    montoIva: 190,
    montoTotal: 1190,
    reversa: false,
    eventoReceptor: 'A',
    ...over,
  });

  it('upserts and reads back, sorted by id', async () => {
    const store = createFileNormalizedStore({ root });
    await store.upsert('ledgerEntry', [ledger('3'), ledger('1'), ledger('2')]);

    const rows = await store.select('ledgerEntry');
    expect(rows).toHaveLength(3);
    expect([...rows].map((r) => r.id)).toEqual([...rows].map((r) => r.id).sort());
  });

  it('is idempotent on id — re-reading a closed period converges, never duplicates', async () => {
    const store = createFileNormalizedStore({ root });
    await store.upsert('ledgerEntry', [ledger('1')]);
    await store.upsert('ledgerEntry', [ledger('1')]);
    expect(await store.count('ledgerEntry')).toBe(1);
  });

  it('last write wins for the same id', async () => {
    const store = createFileNormalizedStore({ root });
    await store.upsert('ledgerEntry', [ledger('1', { montoTotal: 1190 })]);
    await store.upsert('ledgerEntry', [ledger('1', { montoTotal: 2380 })]);

    const row = (await store.select('ledgerEntry'))[0] as LedgerEntry;
    expect(row.montoTotal).toBe(2380);
  });

  it('filters by taxpayer, period and arbitrary fields', async () => {
    const store = createFileNormalizedStore({ root });
    await store.upsert('ledgerEntry', [
      ledger('1'),
      ledger('2', { side: 'VENTA' }),
      ledger('3', { period: '202404' }),
      ledger('4', { taxpayer: 'tk-bbb' }),
    ]);

    expect(await store.count('ledgerEntry', { taxpayer: 'tk-aaa' })).toBe(3);
    expect(await store.count('ledgerEntry', { period: '202403' })).toBe(3);
    expect(await store.count('ledgerEntry', { where: { side: 'VENTA' } })).toBe(1);
  });

  it('finds rows by the extraction that produced them', async () => {
    const store = createFileNormalizedStore({ root });
    await store.upsert('ledgerEntry', [ledger('1'), ledger('2', { derivedFrom: 'ext-2' })]);
    expect(await store.selectByExtraction('ext-2')).toHaveLength(1);
  });

  it('retracts an extraction wholesale, leaving nothing behind', async () => {
    const store = createFileNormalizedStore({ root });
    await store.upsert('ledgerEntry', [
      ledger('1'),
      ledger('2'),
      ledger('3', { derivedFrom: 'ext-2' }),
    ]);

    expect(await store.retractExtraction('ext-1')).toBe(2);
    expect(await store.count('ledgerEntry')).toBe(1);
    // Retraction rewrites, so the append log is compacted too — no tombstones left to re-fold.
    expect(await readJsonl(join(root, 'entities', 'ledgerEntry.jsonl'))).toHaveLength(1);
  });

  it('lists taxpayers from the taxpayer kind, distinct and sorted', async () => {
    const store = createFileNormalizedStore({ root });
    const tp = (key: string, rut: string): Taxpayer => ({
      id: entityId('taxpayer', key),
      taxpayer: key,
      derivedFrom: 'ext-1',
      recordedAt: now,
      rut,
      razonSocial: null,
      fechaInicioActividades: null,
      regimen: null,
      autorizadoDeclararDia20: null,
    });
    await store.upsert('taxpayer', [tp('tk-bbb', '22222222-2'), tp('tk-aaa', '11111111-1')]);
    expect(await store.taxpayers()).toEqual(['tk-aaa', 'tk-bbb']);
  });

  it('compacts a grown append log without changing what it holds', async () => {
    const store = createFileNormalizedStore({ root });
    for (let i = 0; i < 5; i += 1) await store.upsert('ledgerEntry', [ledger('1')]);

    const before = await store.select('ledgerEntry');
    expect(await store.compact('ledgerEntry')).toBe(4);
    expect(await store.select('ledgerEntry')).toEqual(before);
    expect(await store.compact('ledgerEntry')).toBe(0);
  });

  it('reports which kinds are on disk', async () => {
    const store = createFileNormalizedStore({ root });
    await store.upsert('ledgerEntry', [ledger('1')]);
    expect(await storedKinds({ root })).toEqual(['ledgerEntry']);
  });

  it('treats an absent file as an empty collection', async () => {
    const store = createFileNormalizedStore({ root });
    expect(await store.select('giro')).toEqual([]);
    expect(await store.taxpayers()).toEqual([]);
  });
});

describe('JSONL durability', () => {
  it('drops a TORN final append — a crash loses the row, not the file', async () => {
    const store = createFileNormalizedStore({ root });
    const row: AnyEntity = {
      id: entityId('giro', 'tk-aaa', '1'),
      taxpayer: 'tk-aaa',
      derivedFrom: 'ext-1',
      recordedAt: '2026-08-06T03:00:00.000Z',
      folio: '1',
      formularioOrigen: null,
      fechaEmision: null,
      fechaVencimiento: null,
      estado: 'Vigente',
      saldo: 0,
      moneda: 'CLP',
    };
    await store.upsert('giro', [row]);

    // Simulate a process dying mid-append: a partial line with NO trailing newline.
    const path = join(root, 'entities', 'giro.jsonl');
    await fsp.appendFile(path, '{"id":"giro:tor');

    expect(await store.count('giro')).toBe(1);
  });

  it('THROWS on corruption that is not a torn final append', async () => {
    // Silently skipping a bad line would turn a corrupt store into one that quietly reports fewer
    // rows — indistinguishable from "nothing is wrong".
    const path = join(root, 'entities', 'giro.jsonl');
    await fsp.mkdir(join(root, 'entities'), { recursive: true });
    await fsp.writeFile(path, '{"id":"a","taxpayer":"t"}\nNOT JSON\n{"id":"b","taxpayer":"t"}\n');

    const store = createFileNormalizedStore({ root });
    await expect(store.select('giro')).rejects.toThrow(IntegrityError);
  });

  it('serialises with sorted keys, so identical data yields identical bytes', async () => {
    const store = createFileNormalizedStore({ root });
    await store.upsert('giro', [
      {
        taxpayer: 'tk-aaa',
        id: 'giro:1',
        recordedAt: '2026-08-06T03:00:00.000Z',
        derivedFrom: 'ext-1',
        folio: '1',
        formularioOrigen: null,
        fechaEmision: null,
        fechaVencimiento: null,
        estado: 'Vigente',
        saldo: 0,
        moneda: 'CLP',
      },
    ]);
    const raw = await fsp.readFile(join(root, 'entities', 'giro.jsonl'), 'utf8');
    expect(raw.startsWith('{"derivedFrom":')).toBe(true);
  });
});
