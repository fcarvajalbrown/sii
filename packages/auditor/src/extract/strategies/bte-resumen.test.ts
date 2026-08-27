import { describe, expect, it } from 'vitest';
import { instant } from '../../provenance.js';
import type { FetchManifest } from '../../ingest/manifest.js';
import { inScope } from '../strategy.js';
import type { ExtractionContext } from '../strategy.js';
import { BTE_RESUMEN_PII_KEYS, bteResumenStrategy } from './bte-resumen.js';

const manifest = (over: Partial<FetchManifest> = {}): FetchManifest => ({
  contentHash: 'a'.repeat(64),
  url: 'evaluate:403d6e6c',
  transport: 'goto',
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

const run = (map: unknown, over: Partial<FetchManifest> = {}) => {
  const ctx: ExtractionContext = {
    manifest: manifest(over),
    bytes: Buffer.from(JSON.stringify(map), 'utf8'),
    runId: 'run-1',
    taxpayer: 'tk-aaa',
    now: '2026-08-06T03:00:00.000Z',
  };
  return bteResumenStrategy.extract(ctx);
};

/** Shaped after a real observed `xml_values` (values changed; no real PII in a tracked file). */
const XML_VALUES = {
  anio_consulta: '2023',
  mes_consulta: '01',
  cant_boletas: '3',
  total_boletas: '3',
  suma_honorarios: 1051724,
  suma_retencion_receptor: 136724,
  suma_liquido: 915000,
  pagina_actual: '1',
  nombre_contribuyente: 'EMPRESA DE PRUEBA SPA',
  rut_arrastre: '11111111',
  dv_arrastre: '1',
};

describe('scope', () => {
  it('matches an evaluate artifact', () => {
    expect(inScope(bteResumenStrategy.scope, manifest())).toBe(true);
  });

  it('ignores a real HTTP artifact', () => {
    expect(
      inScope(
        bteResumenStrategy.scope,
        manifest({ url: 'https://zeus.sii.cl/x', transport: 'requestForm' }),
      ),
    ).toBe(false);
  });
});

describe('parsing', () => {
  it('reads the monthly aggregates', async () => {
    const v = (await run(XML_VALUES)).records[0]?.value;
    expect(v?.periodo).toBe('2023-01');
    expect(v?.honorarios).toBe(1051724);
    expect(v?.retencionReceptor).toBe(136724);
    expect(v?.liquido).toBe(915000);
    expect(v?.cantBoletas).toBe(3);
  });

  it('zero-pads a single-digit month', async () => {
    const v = (await run({ ...XML_VALUES, mes_consulta: '9' })).records[0]?.value;
    expect(v?.periodo).toBe('2023-09');
  });

  it('accepts es-CL dot-formatted montos as well as raw numbers', async () => {
    const v = (await run({ ...XML_VALUES, suma_honorarios: '1.051.724' })).records[0]?.value;
    expect(v?.honorarios).toBe(1051724);
  });

  it('leaves retencionEmisor null on a RECIBIDAS report without flagging a doubt', async () => {
    // The key is simply absent there — a real absence, not an unparseable value.
    const out = await run(XML_VALUES);
    expect(out.records[0]?.value.retencionEmisor).toBeNull();
    expect(out.records[0]?.confidence).toBe(1);
  });

  it('flags a missing período — the artifact could not be attributed', async () => {
    const out = await run({ ...XML_VALUES, anio_consulta: '', mes_consulta: '' });
    expect(out.records[0]?.value.periodo).toBeNull();
    expect(out.records[0]?.signals.some((s) => s.code === 'missing_field')).toBe(true);
  });

  it('flags an unparseable monto', async () => {
    const out = await run({ ...XML_VALUES, suma_retencion_receptor: 'N/D' });
    expect(out.records[0]?.value.retencionReceptor).toBeNull();
    expect(out.records[0]?.signals.some((s) => s.code === 'unparseable_value')).toBe(true);
  });
});

describe('the sibling map', () => {
  it('emits NOTHING for arr_informe_mensual — and does NOT count it as a failure', async () => {
    // Both maps arrive as `evaluate:` artifacts. Counting the row map as a failed extraction would
    // drag extraction accuracy down every single month for no reason.
    const out = await run({ nroboleta_1: '123', nombre_emisor_1: 'X' });
    expect(out.records).toHaveLength(0);
    expect(out.failures).toHaveLength(0);
  });

  it('fails loudly on genuinely unreadable bytes', async () => {
    const ctx: ExtractionContext = {
      manifest: manifest(),
      bytes: Buffer.from('not json', 'utf8'),
      runId: 'run-1',
      taxpayer: 'tk-aaa',
      now: '2026-08-06T03:00:00.000Z',
    };
    const out = await bteResumenStrategy.extract(ctx);
    expect(out.failures).toHaveLength(1);
  });
});

describe('PII', () => {
  it('never emits the taxpayer own-identity fields (live BUG-1, ADR-028)', async () => {
    const out = await run(XML_VALUES);
    const serialised = JSON.stringify(out.records[0]?.value);
    for (const key of BTE_RESUMEN_PII_KEYS) {
      expect(serialised).not.toContain(key);
    }
    expect(serialised).not.toContain('EMPRESA DE PRUEBA');
    expect(serialised).not.toContain('11111111');
  });
});

describe('determinism', () => {
  it('same bytes, same record', async () => {
    expect(JSON.stringify(await run(XML_VALUES))).toBe(JSON.stringify(await run(XML_VALUES)));
  });
});
