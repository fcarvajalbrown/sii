import { describe, it, expect } from 'vitest';
import { HOSTS, testing, type Runtime } from '@dostertags/sii-core';
import { connect, datos, toolText } from '../test-helpers.js';

describe('@dostertags/sii-mcp iva tool (in-memory client, fake runtime, no SII)', () => {
  const VENTA_ENV = {
    respEstado: { codRespuesta: 0 },
    totDocRes: 1,
    data: [
      { rsmnTipoDocInteger: 33, dcvNombreTipoDoc: 'Factura', rsmnTotDoc: 1, rsmnMntIVA: 19000 },
    ],
  };
  const COMPRA_ENV = {
    respEstado: { codRespuesta: 0 },
    totDocRes: 1,
    data: [
      { rsmnTipoDocInteger: 33, dcvNombreTipoDoc: 'Factura', rsmnTotDoc: 1, rsmnMntIVA: 15000 },
    ],
  };

  function makeRuntime(debito: number, credito: number): Runtime {
    const requestJson = (url: string, options?: unknown): unknown => {
      if (url.includes('getResumen')) {
        const op = (options as { body?: { data?: { operacion?: string } } })?.body?.data?.operacion;
        return op === 'VENTA' ? VENTA_ENV : COMPRA_ENV;
      }
      if (url.includes('getDeclaracionConCondicionesYTipoPropuesta')) {
        return {
          metaData: { errors: null },
          data: {
            tipopropuesta: 40,
            estado: 0,
            listCodPropuestos: [
              { codigo: '538', valor: String(debito) },
              { codigo: '537', valor: String(credito) },
            ],
          },
        };
      }
      throw new Error(`unexpected URL: ${url}`);
    };
    return {
      clock: new testing.FixedClock(new Date('2026-06-27T12:00:00Z')),
      audit: new testing.RecordingAuditSink(),
      store: new testing.InMemoryKeyValueStore(),
      portal: new testing.FakePortalDriver({
        loginSession: { landingUrl: HOSTS.miSii, evaluate: datos, storageState: { cookies: [] } },
        restoreSession: {
          landingUrl: HOSTS.miSii,
          evaluate: datos,
          requestJson,
          cookies: { TOKEN: 't' },
        },
      }),
    };
  }

  it('iva returns the reconciliation as JSON and is read-only', async () => {
    const client = await connect(makeRuntime(19000, 15000));
    await client.callTool({ name: 'auth_login', arguments: {} });

    const res = await client.callTool({ name: 'iva', arguments: { periodo: '2026-06' } });
    const parsed = JSON.parse(toolText(res)) as {
      periodo: string;
      fuente: string;
      reconciliacion: { cuadra: boolean; debitoRcv: number; creditoRcv: number };
    };

    expect(parsed).toMatchObject({ periodo: '2026-06', fuente: 'propuesta' });
    expect(parsed.reconciliacion).toMatchObject({
      cuadra: true,
      debitoRcv: 19000,
      creditoRcv: 15000,
    });

    const { tools } = await client.listTools();
    expect(tools.find((t) => t.name === 'iva')?.annotations?.readOnlyHint).toBe(true);
  });

  it('reports a mismatch with signed deltas rather than failing', async () => {
    const client = await connect(makeRuntime(20000, 15000));
    await client.callTool({ name: 'auth_login', arguments: {} });

    const res = await client.callTool({ name: 'iva', arguments: { periodo: '2026-06' } });
    const parsed = JSON.parse(toolText(res)) as {
      reconciliacion: { cuadra: boolean; deltaDebito: number };
    };

    expect(parsed.reconciliacion.cuadra).toBe(false);
    expect(parsed.reconciliacion.deltaDebito).toBe(-1000);
  });

  it("declares that it reconciles against SII's propuesta, not the filed form (ADR-013)", async () => {
    const client = await connect(makeRuntime(19000, 15000));
    const { tools } = await client.listTools();
    const iva = tools.find((t) => t.name === 'iva');

    expect(iva?.description).toMatch(/propuesta/i);
  });
});
