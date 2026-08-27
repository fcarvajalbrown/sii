import { describe, it, expect } from 'vitest';
import { HOSTS, testing, type Runtime } from '@dostertags/sii-core';
import { connect, datos, toolText } from '../test-helpers.js';

describe('@dostertags/sii-mcp honorarios tool (in-memory client, fake runtime, no SII)', () => {
  const GRID = {
    metaData: { errors: [] },
    data: [
      { codigo: '467', valor: '12.000.000', glosa: 'Total Honorarios' },
      { codigo: '1412', valor: '9.500.000', glosa: 'Honorarios régimen 14D Nº3' },
    ],
  };
  const DECLS = {
    metaData: { errors: [] },
    data: {
      decls: [{ folio: '77001', vgte: 'S', codConc: 'C1', fecIng: '20/04/2026' }],
      glosas: [{ codConclusion: 'C1', descripcion: 'Declaración vigente' }],
    },
  };

  function makeRuntime(): Runtime {
    const requestJson = (url: string): unknown => {
      if (url.includes('getDeclaracionConCondicionesYTipoPropuesta')) {
        return {
          metaData: { errors: null },
          data: {
            tipopropuesta: 40,
            estado: 0,
            // 151 = honorarios retention; 153 (Art. 48) must be ignored by the composite.
            listCodPropuestos: [
              { codigo: '151', valor: '0' },
              { codigo: '153', valor: '888888' },
            ],
          },
        };
      }
      if (url.includes('buscaDeclVgte')) return DECLS;
      if (url.includes('f22Compacto')) return GRID;
      throw new Error(`unexpected url: ${url}`);
    };
    // BPST (ADR-029) — a clean 0-boleta report, so this pre-existing test (which knows nothing
    // about BPST) is numerically unaffected by its addition to `honorarios`.
    const EMPTY_BPST =
      `<html><head><title>Boleta de Prestación de Servicios de Terceros Electrónica</title></head>` +
      `<body>INFORME BTE's EMITIDAS\nTotal Boletas : 0\nBoletas Vigentes : 0\nBoletas Anuladas : 0\n` +
      `<table><tr><td colspan="9" bgcolor="#CDCDCD"><b>(*)Totales</b></td>` +
      `<td><font class="reporte">0</font></td><td><font class="reporte">0</font></td>` +
      `<td><font class="reporte">0</font></td></tr></table>` +
      `<input type="button" name="NEXT" disabled></body></html>`;
    return {
      clock: new testing.FixedClock(new Date('2026-07-25T12:00:00Z')),
      audit: new testing.RecordingAuditSink(),
      store: new testing.InMemoryKeyValueStore(),
      portal: new testing.FakePortalDriver({
        loginSession: { landingUrl: HOSTS.miSii, evaluate: datos, storageState: { cookies: [] } },
        restoreSession: {
          landingUrl: HOSTS.miSii,
          evaluate: (expr: string) => (expr.includes('xml_values') ? { total_boletas: '0' } : {}),
          requestJson,
          requestForm: () => EMPTY_BPST,
          cookies: { TOKEN: 't' },
        },
      }),
    };
  }

  it('returns the reconciliation, pairs commercial year with AT+1, and is read-only', async () => {
    const client = await connect(makeRuntime());
    await client.callTool({ name: 'auth_login', arguments: {} });

    const res = await client.callTool({ name: 'honorarios', arguments: { anio: '2025' } });
    const parsed = JSON.parse(toolText(res)) as {
      anioComercial: string;
      anioTributario: string;
      fuente: string;
      meses: unknown[];
      reconciliacion: { retencionF29: number | null };
      f22: { codigos: { codigo: string; enTaxonomia: boolean }[] };
    };

    expect(parsed).toMatchObject({
      anioComercial: '2025',
      anioTributario: '2026',
      fuente: 'propuesta',
    });
    expect(parsed.meses).toHaveLength(12);
    // Código 153 (888.888) must NOT have leaked into the declared total.
    expect(parsed.reconciliacion.retencionF29).toBe(0);
    // 1412 is surfaced but explicitly flagged as outside the observed taxonomy.
    const c1412 = parsed.f22.codigos.find((c) => c.codigo === '1412');
    expect(c1412?.enTaxonomia).toBe(false);

    const { tools } = await client.listTools();
    expect(tools.find((t) => t.name === 'honorarios')?.annotations?.readOnlyHint).toBe(true);
  });

  it('declares the receptor-only rule and the propuesta caveat to the model', async () => {
    const client = await connect(makeRuntime());
    const { tools } = await client.listTools();
    const d = tools.find((t) => t.name === 'honorarios')?.description ?? '';

    expect(d).toMatch(/retencionReceptor/);
    expect(d).toMatch(/propuesta/i);
    expect(d).toMatch(/151/);
  });
});
