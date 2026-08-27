import { describe, it, expect } from 'vitest';
import { HOSTS, testing, type Runtime } from '@dostertags/sii-core';
import { connect, toolText } from '../test-helpers.js';

const datos = (): unknown => ({
  contribuyente: { rut: 11111111, dv: '1', nombres: 'Juan', apellidoPaterno: 'Pérez' },
});

const INFORME = {
  listCarpetaTributaria: [
    {
      periodoDj: 202502,
      glosaNombreBanco: 'BANCO DEL ESTADO DE CHILE',
      glosaTipoCuenta: 'CUENTA CORRIENTE',
      semestre: 'Primer semestre 2025',
      sumaCantidadAbonos: 1433,
      sumaMontoTotalAbonos: 619837498,
    },
  ],
};

function makeRuntime(): Runtime {
  return {
    clock: new testing.FixedClock(new Date('2026-08-05T12:00:00Z')),
    audit: new testing.RecordingAuditSink(),
    store: new testing.InMemoryKeyValueStore(),
    portal: new testing.FakePortalDriver({
      loginSession: { landingUrl: HOSTS.miSii, evaluate: datos, storageState: { cookies: [] } },
      restoreSession: {
        landingUrl: HOSTS.miSii,
        evaluate: datos,
        requestForm: () => JSON.stringify(INFORME),
      },
    }),
  };
}

describe('@dostertags/sii-mcp bancario_resumen tool (in-memory client, fake runtime, no SII)', () => {
  it('devuelve los semestres como JSON', async () => {
    const client = await connect(makeRuntime());
    await client.callTool({ name: 'auth_login', arguments: {} });
    const res = await client.callTool({ name: 'bancario_resumen', arguments: {} });
    const parsed = JSON.parse(toolText(res)) as { semestres: { montoTotalAbonos: number }[] };
    expect(parsed.semestres[0]?.montoTotalAbonos).toBe(619837498);
  });

  it('es de solo lectura, sin argumentos, y declara qué expone', async () => {
    const client = await connect(makeRuntime());
    const { tools } = await client.listTools();
    const t = tools.find((x) => x.name === 'bancario_resumen');
    expect(t?.annotations?.readOnlyHint).toBe(true);
    expect(t?.description).toMatch(/depósitos bancarios/i);
  });
});
