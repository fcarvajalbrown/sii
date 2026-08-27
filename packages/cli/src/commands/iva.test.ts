import { describe, it, expect } from 'vitest';
import { HOSTS, NotAuthenticatedError, testing, type Runtime } from '@dostertags/sii-core';
import { datos, run, runJson } from '../test-helpers.js';

describe('sii iva command (fake runtime, no SII)', () => {
  const VENTA_ENV = {
    respEstado: { codRespuesta: 0 },
    totDocRes: 1,
    data: [
      {
        rsmnTipoDocInteger: 33,
        dcvNombreTipoDoc: 'Factura electrónica',
        rsmnTotDoc: 1,
        rsmnMntNeto: 100000,
        rsmnMntIVA: 19000,
        rsmnMntTotal: 119000,
      },
    ],
  };
  const COMPRA_ENV = {
    respEstado: { codRespuesta: 0 },
    totDocRes: 1,
    data: [
      {
        rsmnTipoDocInteger: 33,
        dcvNombreTipoDoc: 'Factura electrónica',
        rsmnTotDoc: 1,
        rsmnMntNeto: 78947,
        rsmnMntIVA: 15000,
        rsmnMntTotal: 93947,
      },
    ],
  };
  const f29Env = (debito: number, credito: number) => ({
    metaData: { errors: null },
    data: {
      tipopropuesta: 40,
      estado: 0,
      listCodPropuestos: [
        { codigo: '538', valor: String(debito) },
        { codigo: '537', valor: String(credito) },
      ],
    },
  });

  function makeIvaRuntime(debito: number, credito: number): Runtime {
    const requestJson = (url: string, options?: unknown): unknown => {
      if (url.includes('getResumen')) {
        const op = (options as { body?: { data?: { operacion?: string } } })?.body?.data?.operacion;
        return op === 'VENTA' ? VENTA_ENV : COMPRA_ENV;
      }
      if (url.includes('getDeclaracionConCondicionesYTipoPropuesta'))
        return f29Env(debito, credito);
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

  it('prints both sides and a balanced verdict when the ledger matches the propuesta', async () => {
    const rt = makeIvaRuntime(19000, 15000);
    await run(rt, 'auth', 'login');

    const out = await run(rt, 'iva', '2026-06', '--human');

    expect(out).toContain('IVA 2026-06');
    expect(out).toContain('Débito');
    expect(out).toContain('Crédito');
    expect(out).toContain('CUADRA');
  });

  it('flags the mismatch and shows the signed delta when it does not balance', async () => {
    const rt = makeIvaRuntime(20000, 15000); // F29 débito 1.000 over the ledger
    await run(rt, 'auth', 'login');

    const out = await run(rt, 'iva', '2026-06', '--human');

    expect(out).toContain('NO CUADRA');
    expect(out).toContain('-1.000'); // RCV - F29, es-CL formatted
  });

  it('emits the reconciliation object as JSON by default (ADR-012)', async () => {
    const rt = makeIvaRuntime(19000, 15000);
    await run(rt, 'auth', 'login');

    const json = (await runJson(rt, 'iva', '2026-06')) as {
      periodo: string;
      fuente: string;
      reconciliacion: { cuadra: boolean; deltaDebito: number };
    };

    expect(json).toMatchObject({ periodo: '2026-06', fuente: 'propuesta' });
    expect(json.reconciliacion.cuadra).toBe(true);
    expect(json.reconciliacion.deltaDebito).toBe(0);
  });

  it('requires a session (NotAuthenticated → exit 2)', async () => {
    const rt = makeIvaRuntime(19000, 15000); // no login
    await expect(run(rt, 'iva', '2026-06')).rejects.toBeInstanceOf(NotAuthenticatedError);
  });
});
