// Unit tests for the `f29-propuesta` parser.
//
// These fixtures are SYNTHETIC and that is correct here: this is a unit test of parsing behaviour,
// not a golden set. The golden set measures accuracy against REAL engagements (never generated);
// a unit test pins the edge cases real data may not happen to contain — which matters, because the
// real 2023 evidence contains zero códigos with value 0, so the live artifacts alone would leave
// that path untested.

import { describe, expect, it } from 'vitest';
import { instant } from '../../provenance.js';
import { entityId } from '../../store/normalized.js';
import type { FetchManifest } from '../../ingest/manifest.js';
import type { ExtractionContext } from '../strategy.js';
import { inScope } from '../strategy.js';
import { REVIEW_THRESHOLD } from '../confidence.js';
import { f29PropuestaStrategy } from './f29-propuesta.js';

const HASH = 'a'.repeat(64);

const manifest = (over: Partial<FetchManifest> = {}): FetchManifest => ({
  contentHash: HASH,
  url: 'https://www4.sii.cl/propuestaf29ui/services/data/facadeAdapterService/getDeclaracionConCondicionesYTipoPropuesta',
  transport: 'requestJson',
  httpStatus: 200,
  retrievedAt: instant('2026-08-06T03:00:00.000Z'),
  contentType: 'application/json',
  byteLength: 0,
  durationMs: 5,
  taxpayer: 'tk-aaa',
  runId: 'run-1',
  requestFingerprint: null,
  ...over,
});

const ctx = (body: unknown): ExtractionContext => ({
  manifest: manifest(),
  bytes: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8'),
  runId: 'run-1',
  taxpayer: 'tk-aaa',
  now: '2026-08-06T03:00:00.000Z',
});

// Real responses ALWAYS carry `listCodBase` with código 15 (período tributario) — observed on all
// 12 golden 2023 artifacts. The fixture mirrors that; absence tests override it away.
const envelope = (rows: unknown[], extra: Record<string, unknown> = {}) => ({
  data: {
    listCodPropuestos: rows,
    tipopropuesta: 1,
    estado: 2,
    listCodBase: [{ codigo: '15', valor: '202312' }],
    ...extra,
  },
  metaData: { conversationId: 'X', transactionId: 'Y' },
});

const run = async (body: unknown) => f29PropuestaStrategy.extract(ctx(body));

describe('scope', () => {
  it('matches the propuesta endpoint over requestJson', () => {
    expect(inScope(f29PropuestaStrategy.scope, manifest())).toBe(true);
  });

  it('ignores the same URL over a different transport', () => {
    expect(inScope(f29PropuestaStrategy.scope, manifest({ transport: 'requestForm' }))).toBe(false);
  });

  it('ignores a different SDI endpoint', () => {
    expect(
      inScope(
        f29PropuestaStrategy.scope,
        manifest({ url: 'https://www4.sii.cl/x/getDeclaracionConEstados' }),
      ),
    ).toBe(false);
  });
});

describe('parsing', () => {
  it('projects códigos into a map keyed by código', async () => {
    const out = await run(
      envelope([
        { codigo: '502', valor: '125560432' },
        { codigo: '151', valor: '519868' },
      ]),
    );
    const v = out.records[0]?.value;
    expect(v?.codigos).toEqual({ '502': 125560432, '151': 519868 });
    expect(v?.totalCodigos).toBe(2);
    expect(out.records[0]?.confidence).toBe(1);
  });

  it('converts SII numeric-as-string to integers', async () => {
    const out = await run(envelope([{ codigo: '151', valor: ' 326825 ' }]));
    expect(out.records[0]?.value.codigos['151']).toBe(326825);
  });

  it('reads a value of 0 as 0, NOT as null or absent', async () => {
    // The real 2023 evidence has no zero-valued código, so only a fixture covers this.
    const out = await run(envelope([{ codigo: '151', valor: '0' }]));
    expect(out.records[0]?.value.codigos['151']).toBe(0);
    expect(out.records[0]?.value.totalCodigos).toBe(1);
  });

  it('treats an all-zero propuesta as tienePropuesta:false, mirroring the facade', async () => {
    const out = await run(envelope([{ codigo: '151', valor: '0' }]));
    expect(out.records[0]?.value.tienePropuesta).toBe(false);
  });

  it('treats a non-zero código as tienePropuesta:true', async () => {
    const out = await run(envelope([{ codigo: '151', valor: '1' }]));
    expect(out.records[0]?.value.tienePropuesta).toBe(true);
  });

  it('reads `data:null` as a legitimate "sin propuesta", with NO confidence penalty', async () => {
    const out = await run({ data: null, metaData: {} });
    expect(out.failures).toHaveLength(0);
    expect(out.records[0]?.value.tienePropuesta).toBe(false);
    expect(out.records[0]?.value.totalCodigos).toBe(0);
    // An honest absence is not a doubt.
    expect(out.records[0]?.confidence).toBe(1);
  });

  it('rejects a fractional value rather than rounding a peso figure', async () => {
    const out = await run(envelope([{ codigo: '151', valor: '100.5' }]));
    expect(out.records[0]?.value.codigos['151']).toBeNull();
    expect(out.records[0]?.signals.some((s) => s.code === 'unparseable_value')).toBe(true);
  });
});

describe('rate códigos (tasas)', () => {
  // Live observation 2026-08-12 (first real fetch+learn): período 202606 carried
  // {"codigo":"115","valor":"0.125"} — the PPM rate, fractionally-valued by NATURE — and the
  // integer-pesos rule routed the whole month to review over a value that was never a peso
  // amount. Rates get their own typed field; `codigos` stays strictly integer pesos.

  it('reads a RATE código as a decimal into tasas, never into codigos', async () => {
    const out = await run(
      envelope([
        { codigo: '115', valor: '0.125' },
        { codigo: '151', valor: '1365572' },
      ]),
    );
    const v = out.records[0]?.value;
    expect(v?.tasas).toEqual({ '115': 0.125 });
    expect(v?.codigos).toEqual({ '151': 1365572 });
    // A rate being fractional is not a doubt — that was the whole bug.
    expect(out.records[0]?.confidence).toBe(1);
  });

  it('counts rates in totalCodigos — sealed ground truth counts raw rows', async () => {
    const out = await run(
      envelope([
        { codigo: '115', valor: '0.125' },
        { codigo: '151', valor: '1' },
      ]),
    );
    expect(out.records[0]?.value.totalCodigos).toBe(2);
  });

  it('a non-zero rate alone still reads as tienePropuesta, mirroring the facade', async () => {
    const out = await run(envelope([{ codigo: '115', valor: '0.125' }]));
    expect(out.records[0]?.value.tienePropuesta).toBe(true);
  });

  it('flags an unparseable rate without inventing a number', async () => {
    const out = await run(envelope([{ codigo: '115', valor: 'no-numérico' }]));
    const record = out.records[0];
    expect(record?.value.tasas['115']).toBeNull();
    expect(
      record?.signals.some((s) => s.code === 'unparseable_value' && s.field === 'tasas.115'),
    ).toBe(true);
  });
});

describe('confidence signals', () => {
  it('flags an alias fallback — SII renamed a key and our primary is stale', async () => {
    const out = await run(envelope([{ cod: '151', monto: '519868' }]));
    const record = out.records[0];
    expect(record?.value.codigos['151']).toBe(519868);
    expect(record?.signals.filter((s) => s.code === 'alias_fallback')).toHaveLength(2);
    expect(record?.confidence).toBeLessThan(1);
  });

  it('flags unknown keys without distrusting the fields that parsed', async () => {
    const out = await run(envelope([{ codigo: '151', valor: '1', glosaNueva: 'x' }]));
    const record = out.records[0];
    expect(record?.signals.some((s) => s.code === 'unknown_keys')).toBe(true);
    // `.loose()` doing its job is interesting, not a reason for review.
    expect(record?.confidence).toBeGreaterThanOrEqual(REVIEW_THRESHOLD);
  });

  it('flags structural drift when listCodPropuestos disappears', async () => {
    const out = await run({ data: { tipopropuesta: 1 }, metaData: {} });
    const record = out.records[0];
    expect(record?.signals.some((s) => s.code === 'structural_drift')).toBe(true);
    // Near-fatal: a changed page shape is how a scraper breaks.
    expect(record?.confidence).toBeLessThan(REVIEW_THRESHOLD);
  });

  it('flags a repeated código instead of silently overwriting it', async () => {
    const out = await run(
      envelope([
        { codigo: '151', valor: '1' },
        { codigo: '151', valor: '2' },
      ]),
    );
    expect(out.records[0]?.signals.some((s) => s.code === 'structural_drift')).toBe(true);
  });

  it('flags a row with no código', async () => {
    const out = await run(envelope([{ valor: '1' }]));
    expect(out.records[0]?.signals.some((s) => s.code === 'missing_field')).toBe(true);
  });
});

describe('failures', () => {
  it('fails on non-JSON bytes', async () => {
    const out = await run('<html>login</html>');
    expect(out.records).toHaveLength(0);
    expect(out.failures[0]?.message).toMatch(/no es JSON/);
  });

  it('fails when listCodPropuestos is not an array', async () => {
    const out = await run({ data: { listCodPropuestos: 'nope' }, metaData: {} });
    expect(out.failures[0]?.message).toMatch(/no es un arreglo/);
  });

  it('carries provenance on a failure, not just on success', async () => {
    const out = await run('nope');
    expect(out.failures[0]?.provenance.artifact).toBe(HASH);
    expect(out.failures[0]?.provenance.strategy).toBe('f29-propuesta@3');
  });
});

describe('período (código 15 de listCodBase)', () => {
  it('reads the período from código 15 — the period axis of the natural key', async () => {
    const out = await run(envelope([{ codigo: '151', valor: '1' }]));
    expect(out.records[0]?.value.periodo).toBe('202312');
    expect(out.records[0]?.confidence).toBe(1);
  });

  it('flags structural drift when listCodBase disappears — an unkeyable propuesta needs review', async () => {
    // `undefined` drops the key at JSON.stringify time, simulating the list's absence.
    const out = await run(envelope([{ codigo: '151', valor: '1' }], { listCodBase: undefined }));
    const record = out.records[0];
    expect(record?.value.periodo).toBeNull();
    expect(
      record?.signals.some((s) => s.code === 'structural_drift' && s.field === 'listCodBase'),
    ).toBe(true);
    expect(record?.confidence).toBeLessThan(REVIEW_THRESHOLD);
  });

  it('flags structural drift when código 15 is missing from listCodBase', async () => {
    const out = await run(
      envelope([{ codigo: '151', valor: '1' }], {
        // Synthetic RUT under código 03 (CONVENTIONS: tests never carry real PII).
        listCodBase: [{ codigo: '03', valor: '11111111' }],
      }),
    );
    const record = out.records[0];
    expect(record?.value.periodo).toBeNull();
    expect(record?.signals.some((s) => s.code === 'structural_drift' && s.field === 'periodo')).toBe(
      true,
    );
    expect(record?.confidence).toBeLessThan(REVIEW_THRESHOLD);
  });

  it('rejects a non-YYYYMM período rather than keying entities with garbage', async () => {
    const out = await run(
      envelope([{ codigo: '151', valor: '1' }], {
        listCodBase: [{ codigo: '15', valor: '2023-12' }],
      }),
    );
    const record = out.records[0];
    expect(record?.value.periodo).toBeNull();
    expect(
      record?.signals.some((s) => s.code === 'unparseable_value' && s.field === 'periodo'),
    ).toBe(true);
  });

  it('a sin-propuesta (`data:null`) has no período and no penalty — nothing was read', async () => {
    const out = await run({ data: null, metaData: {} });
    expect(out.records[0]?.value.periodo).toBeNull();
    expect(out.records[0]?.confidence).toBe(1);
  });
});

describe('entity projection (toEntities)', () => {
  const project = async (body: unknown) => {
    const out = await f29PropuestaStrategy.extract(ctx(body));
    const record = out.records[0];
    if (record === undefined) throw new Error('expected an extraction record');
    if (f29PropuestaStrategy.toEntities === undefined) throw new Error('expected toEntities');
    return {
      record,
      rows: f29PropuestaStrategy.toEntities(record, {
        recordedAt: '2026-08-10T04:00:00.000Z',
        taxpayer: 'tk-aaa',
      }),
    };
  };

  // The id the stage routes on: `entityId(kind, …natural key)` — the kind prefix is what
  // `kindOf` in loop/stages/extract.ts reads to pick the upsert bucket.
  const FORM_ID = entityId('taxReturnForm', 'tk-aaa', 'F29', '202312', 'propuesta');

  it('projects one TaxReturnForm on the natural key, plus one FormLine per código', async () => {
    const { record, rows } = await project(
      envelope([
        { codigo: '502', valor: '100' },
        { codigo: '151', valor: '2' },
      ]),
    );

    expect(rows[0]).toEqual({
      id: FORM_ID,
      taxpayer: 'tk-aaa',
      derivedFrom: record.id,
      recordedAt: '2026-08-10T04:00:00.000Z',
      form: 'F29',
      period: '202312',
      folio: null,
      // The propuesta's numeric estado, verbatim as a string — never normalised (ADR-004).
      estado: '2',
      fechaPresentacion: null,
      rectificatoria: false,
      fuente: 'propuesta',
    });
    // Lines sorted by código for a deterministic run-to-run diff.
    expect(rows.slice(1)).toEqual([
      {
        id: entityId('formLine', FORM_ID, '151'),
        taxpayer: 'tk-aaa',
        derivedFrom: record.id,
        recordedAt: '2026-08-10T04:00:00.000Z',
        formId: FORM_ID,
        codigo: '151',
        monto: 2,
        glosa: null,
      },
      {
        id: entityId('formLine', FORM_ID, '502'),
        taxpayer: 'tk-aaa',
        derivedFrom: record.id,
        recordedAt: '2026-08-10T04:00:00.000Z',
        formId: FORM_ID,
        codigo: '502',
        monto: 100,
        glosa: null,
      },
    ]);
  });

  it('builds ids the stage can route — entityId(kind, …), never a bare string', async () => {
    // Found 2026-08-10 before it could bite: the first cut minted ids like
    // `f29:202312:propuesta:tk-aaa`, whose prefix `kindOf` would have read as a bogus kind `f29`
    // and upserted rows into a bucket nothing selects from.
    const { rows } = await project(envelope([{ codigo: '151', valor: '2' }]));
    expect(rows[0]?.id.startsWith('taxReturnForm:')).toBe(true);
    expect(rows[1]?.id.startsWith('formLine:')).toBe(true);
  });

  it('preserves a null monto as null, never 0 — the project’s oldest trap', async () => {
    const { rows } = await project(envelope([{ codigo: '151', valor: 'no-numérico' }]));
    const line = rows.find((r) => 'codigo' in r && r.codigo === '151');
    expect(line).toBeDefined();
    expect((line as { monto: number | null }).monto).toBeNull();
  });

  it('projects NOTHING for a sin-propuesta — there is no form to record', async () => {
    const { rows } = await project({ data: null, metaData: {} });
    expect(rows).toEqual([]);
  });

  it('projects NOTHING when the período could not be read — an unkeyable row is worse than none', async () => {
    // Such a record carries structural_drift and routes to review anyway; this pins the backstop.
    const { rows } = await project(
      envelope([{ codigo: '151', valor: '1' }], { listCodBase: undefined }),
    );
    expect(rows).toEqual([]);
  });

  it('projects only PESO códigos into FormLines — a rate is a parameter, not an amount', async () => {
    // FormLine.monto is documented as integer pesos; 0.125 there would lie about units. The rate
    // stays on the extraction record (`value.tasas`), which every entity cites via derivedFrom.
    const { rows } = await project(
      envelope([
        { codigo: '115', valor: '0.125' },
        { codigo: '151', valor: '2' },
      ]),
    );
    const codigos = rows.filter((r) => 'codigo' in r).map((r) => (r as { codigo: string }).codigo);
    expect(codigos).toEqual(['151']);
  });

  it('derives ids only from the natural key: same bytes, same ids (ADR-043 §I5)', async () => {
    const body = envelope([{ codigo: '151', valor: '2' }]);
    const a = await project(body);
    const b = await project(body);
    expect(a.rows).toEqual(b.rows);
  });
});

describe('PII', () => {
  it('reads ONLY código 15 from listCodBase — identity códigos stay out (ADR-006)', async () => {
    const out = await run(
      envelope([{ codigo: '151', valor: '1' }], {
        // Synthetic RUT (CONVENTIONS: real PII never lands in a tracked file, tests included).
        // Código 15 (período) is the single, deliberate exception: a período is not PII.
        listCodBase: [
          { codigo: '9306', valor: '11111111' },
          { codigo: '03', valor: '11111111' },
          { codigo: '15', valor: '202312' },
        ],
        traza: 'pp29-internal',
      }),
    );
    const record = out.records[0];
    expect(record?.value.periodo).toBe('202312');
    const serialised = JSON.stringify(record?.value);
    expect(serialised).not.toContain('9306');
    expect(serialised).not.toContain('11111111');
    expect(serialised).not.toContain('traza');
  });
});

describe('determinism', () => {
  it('same bytes, same records — including the id and confidence', async () => {
    const body = envelope([
      { codigo: '502', valor: '1' },
      { codigo: '151', valor: '2' },
    ]);
    expect(JSON.stringify(await run(body))).toBe(JSON.stringify(await run(body)));
  });

  it('key order in the response does not change the output', async () => {
    const a = await run(envelope([{ codigo: '151', valor: '2' }]));
    const b = await run(envelope([{ valor: '2', codigo: '151' }]));
    expect(a.records[0]?.value).toEqual(b.records[0]?.value);
  });
});
