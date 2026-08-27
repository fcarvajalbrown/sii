// Unit tests for the `rcv-resumen` parser — the first strategy for a surface the fetch plan
// actually sweeps beyond the F29 propuesta (6 getResumen artifacts per 3-month sweep).
//
// Fixtures are SYNTHETIC (parsing edge cases); the real shape was observed first-hand on the six
// live artifacts of run-2026-08-12T12-39-34-503Z before this file was written.

import { describe, expect, it } from 'vitest';
import { instant } from '../../provenance.js';
import type { FetchManifest } from '../../ingest/manifest.js';
import type { ExtractionContext } from '../strategy.js';
import { inScope } from '../strategy.js';
import { REVIEW_THRESHOLD } from '../confidence.js';
import { rcvResumenStrategy } from './rcv-resumen.js';

const HASH = 'a'.repeat(64);

const manifest = (over: Partial<FetchManifest> = {}): FetchManifest => ({
  contentHash: HASH,
  url: 'https://www4.sii.cl/consdcvinternetui/services/data/facadeService/getResumen',
  transport: 'requestJson',
  httpStatus: 200,
  retrievedAt: instant('2026-08-12T12:39:40.000Z'),
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
  now: '2026-08-12T13:00:00.000Z',
});

/** Mirrors the live shape: rows + cabecera (período/side) + the cross-checkable totDocRes. */
const envelope = (
  rows: unknown[],
  extra: Record<string, unknown> = {},
  cabecera: Record<string, unknown> | null = { dcvPtributario: '202608', dcvOperacion: 'COMPRA' },
) => ({
  respEstado: { codError: null, codRespuesta: 0, msgeRespuesta: null },
  data: rows,
  dataCabecera: cabecera,
  totDocRes: rows.reduce(
    (n: number, r) => n + (Number((r as Record<string, unknown>)['rsmnTotDoc']) || 0),
    0,
  ),
  metaData: { conversationId: 'X', transactionId: 'Y' },
  ...extra,
});

const row33 = {
  rsmnTipoDocInteger: 33,
  dcvNombreTipoDoc: 'Factura Electrónica',
  rsmnTotDoc: 7,
  rsmnMntExe: 0,
  rsmnMntNeto: 13262969,
  rsmnMntIVA: 2519964,
  rsmnMntTotal: 15782933,
};

const row61 = {
  rsmnTipoDocInteger: 61,
  dcvNombreTipoDoc: 'Nota de Crédito Electrónica',
  rsmnTotDoc: 2,
  rsmnMntExe: 0,
  rsmnMntNeto: 100000,
  rsmnMntIVA: 19000,
  rsmnMntTotal: 119000,
};

const run = async (body: unknown) => rcvResumenStrategy.extract(ctx(body));

describe('scope', () => {
  it('matches getResumen over requestJson', () => {
    expect(inScope(rcvResumenStrategy.scope, manifest())).toBe(true);
  });

  it('ignores the same URL over a different transport', () => {
    expect(inScope(rcvResumenStrategy.scope, manifest({ transport: 'requestForm' }))).toBe(false);
  });

  it('ignores other SDI endpoints', () => {
    expect(
      inScope(rcvResumenStrategy.scope, manifest({ url: 'https://www4.sii.cl/x/getDetalle' })),
    ).toBe(false);
  });
});

describe('parsing', () => {
  it('projects rows into a map keyed by tipo de documento', async () => {
    const out = await run(envelope([row33, row61]));
    const v = out.records[0]?.value;
    expect(v?.periodo).toBe('202608');
    expect(v?.side).toBe('COMPRA');
    expect(v?.tipos['33']).toEqual({
      descripcion: 'Factura Electrónica',
      totalDocumentos: 7,
      montoExento: 0,
      montoNeto: 13262969,
      montoIva: 2519964,
      montoTotal: 15782933,
    });
    expect(Object.keys(v?.tipos ?? {})).toEqual(['33', '61']);
    expect(out.records[0]?.confidence).toBe(1);
  });

  it('reads an EMPTY data array as a legitimate "sin documentos", no penalty', async () => {
    const out = await run(envelope([]));
    const v = out.records[0]?.value;
    expect(v?.tipos).toEqual({});
    expect(out.records[0]?.confidence).toBe(1);
    expect(out.failures).toHaveLength(0);
  });

  it('keeps a Nota de Crédito row as its RAW magnitude — netting belongs to rules, not parsers', async () => {
    // The ADR-022 phantom-descuadre bug came from AGGREGATING resumen rows without netting tipo
    // 61. The parser must not encode that judgment: it surfaces rows verbatim and computes no
    // aggregate a rule could mistake for a netted figure.
    const out = await run(envelope([row61]));
    const v = out.records[0]?.value;
    expect(v?.tipos['61']?.montoIva).toBe(19000);
    expect(JSON.stringify(v)).not.toMatch(/reversa|netted|neteado/);
  });
});

describe('the natural key comes from dataCabecera', () => {
  it('flags structural drift when dataCabecera is missing — an unkeyable resumen needs review', async () => {
    const out = await run(envelope([row33], {}, null));
    const record = out.records[0];
    expect(record?.value.periodo).toBeNull();
    expect(record?.value.side).toBeNull();
    expect(record?.signals.some((s) => s.code === 'structural_drift')).toBe(true);
    expect(record?.confidence).toBeLessThan(REVIEW_THRESHOLD);
  });

  it('flags an unobserved operación value instead of trusting it as a side', async () => {
    const out = await run(
      envelope([row33], {}, { dcvPtributario: '202608', dcvOperacion: 'AJUSTE' }),
    );
    const record = out.records[0];
    expect(record?.value.side).toBeNull();
    expect(record?.signals.some((s) => s.code === 'out_of_observed_range' && s.field === 'side')).toBe(
      true,
    );
  });

  it('rejects a non-YYYYMM período', async () => {
    const out = await run(
      envelope([row33], {}, { dcvPtributario: 'agosto', dcvOperacion: 'VENTA' }),
    );
    expect(out.records[0]?.value.periodo).toBeNull();
    expect(
      out.records[0]?.signals.some((s) => s.code === 'unparseable_value' && s.field === 'periodo'),
    ).toBe(true);
  });
});

describe('internal totals', () => {
  it('cross-checks totDocRes against the sum of row counts — the BPST lesson', async () => {
    const out = await run(envelope([row33, row61], { totDocRes: 99 }));
    const record = out.records[0];
    expect(
      record?.signals.some((s) => s.code === 'internal_total_mismatch' && s.field === 'totalDocumentos'),
    ).toBe(true);
    // A total that disagrees with its own rows is severe: below the threshold, to a human.
    expect(record?.confidence).toBeLessThan(REVIEW_THRESHOLD);
  });

  it('a matching total raises no signal', async () => {
    const out = await run(envelope([row33, row61]));
    expect(out.records[0]?.signals).toEqual([]);
  });
});

describe('confidence signals', () => {
  it('flags an alias fallback when SII renames a key', async () => {
    const out = await run(
      envelope([{ ...row33, rsmnMntNeto: undefined, mntNeto: 13262969 }]),
    );
    const record = out.records[0];
    expect(record?.value.tipos['33']?.montoNeto).toBe(13262969);
    expect(record?.signals.some((s) => s.code === 'alias_fallback')).toBe(true);
  });

  it('flags unknown row keys without distrusting the fields that parsed', async () => {
    const out = await run(envelope([{ ...row33, campoNuevo: 'x' }]));
    const record = out.records[0];
    expect(record?.signals.some((s) => s.code === 'unknown_keys')).toBe(true);
    expect(record?.confidence).toBeGreaterThanOrEqual(REVIEW_THRESHOLD);
  });

  it('flags a repeated tipo instead of silently overwriting it', async () => {
    const out = await run(envelope([row33, { ...row33, rsmnMntNeto: 1 }]));
    expect(out.records[0]?.signals.some((s) => s.code === 'structural_drift')).toBe(true);
  });
});

describe('failures', () => {
  it('fails on non-JSON bytes', async () => {
    const out = await run('<html>login</html>');
    expect(out.records).toHaveLength(0);
    expect(out.failures[0]?.message).toMatch(/no es JSON/);
  });

  it('surfaces a non-zero respEstado VERBATIM (ADR-004)', async () => {
    const out = await run({
      respEstado: { codError: 7, codRespuesta: 7, msgeRespuesta: 'Periodo no disponible' },
      data: null,
      metaData: {},
    });
    expect(out.records).toHaveLength(0);
    expect(out.failures[0]?.message).toContain('Periodo no disponible');
  });

  it('codRespuesta 3 ("sin movimientos", RCV_OK del facade) es un mes VACÍO legítimo, no un failure', async () => {
    // Mirror de portal/rcv.ts RCV_OK (observado en vivo 2026-06-28): un período sin compras o sin
    // ventas es rutinario en el barrido COMPRA+VENTA; registrarlo como failure contaminaría las
    // métricas del gate y, por ADR-046 ("attempted"), el artifact jamás se re-extraería.
    const out = await run({
      respEstado: { codError: null, codRespuesta: 3, msgeRespuesta: 'Sin movimientos' },
      data: [],
      dataCabecera: { dcvPtributario: '202607', dcvOperacion: 'VENTA' },
      totDocRes: 0,
      metaData: {},
    });
    expect(out.failures).toHaveLength(0);
    expect(out.records).toHaveLength(1);
    expect(out.records[0]?.value).toMatchObject({ periodo: '202607', side: 'VENTA', totalTipos: 0 });
  });

  it('carries provenance on a failure', async () => {
    const out = await run('nope');
    expect(out.failures[0]?.provenance.artifact).toBe(HASH);
    expect(out.failures[0]?.provenance.strategy).toBe('rcv-resumen@1');
  });
});

describe('PII', () => {
  it('reads ONLY período and operación from dataCabecera — the own-RUT fields stay out', async () => {
    const out = await run(
      envelope([row33], {}, {
        dcvPtributario: '202608',
        dcvOperacion: 'COMPRA',
        // Synthetic RUT (CONVENTIONS: tests never carry real PII).
        dcvRutEmisor: 11111111,
        dcvDvEmisor: '1',
      }),
    );
    const serialised = JSON.stringify(out.records[0]?.value);
    expect(out.records[0]?.value.periodo).toBe('202608');
    expect(serialised).not.toContain('11111111');
    expect(serialised).not.toContain('RutEmisor');
  });
});

describe('determinism', () => {
  it('same bytes, same records — including id and confidence', async () => {
    const body = envelope([row33, row61]);
    expect(JSON.stringify(await run(body))).toBe(JSON.stringify(await run(body)));
  });
});
