import { describe, it, expect } from 'vitest';
import { HOSTS, testing, type Runtime } from '@dostertags/sii-core';
import { connect, toolText } from '../test-helpers.js';

const datos = (): unknown => ({
  contribuyente: { rut: 11111111, dv: '1', nombres: 'Juan', apellidoPaterno: 'Pérez' },
});

const ROW = {
  carpetaTributaria: {
    carpCodigoRepositorio: 30000001,
    carpClaveCarpeta: 'XXXXXXXXXX',
    carpFechaGeneracion: '2026-01-20',
    carpNombreReceptor: 'Empresa A SpA',
    carpRutReceptor: 77777777,
    carpDvReceptor: '7',
    carpEstado: 1,
    carpTipo: 1,
    enfinCodigo: '000',
    carpParametros: '{}',
  },
  enfinDescripcion: 'OTRA INSTITUCIÓN',
};

function makeRuntime(): Runtime {
  const requestJson = (url: string): unknown => (url.includes('agno=2025') ? [] : [ROW]);
  return {
    clock: new testing.FixedClock(new Date('2026-08-03T12:00:00Z')),
    audit: new testing.RecordingAuditSink(),
    store: new testing.InMemoryKeyValueStore(),
    portal: new testing.FakePortalDriver({
      loginSession: { landingUrl: HOSTS.miSii, evaluate: datos, storageState: { cookies: [] } },
      restoreSession: { landingUrl: HOSTS.miSii, evaluate: datos, requestJson },
    }),
  };
}

describe('@dostertags/sii-mcp carpeta_tributaria_historial tool (in-memory client, fake runtime, no SII)', () => {
  it('returns the curated historial as JSON', async () => {
    const client = await connect(makeRuntime());
    await client.callTool({ name: 'auth_login', arguments: {} });
    const res = await client.callTool({ name: 'carpeta_tributaria_historial', arguments: {} });
    const parsed = JSON.parse(toolText(res)) as { items: { codigoRepositorio: number }[] };
    expect(parsed.items[0]?.codigoRepositorio).toBe(30000001);
  });

  it('filters by anio', async () => {
    const client = await connect(makeRuntime());
    await client.callTool({ name: 'auth_login', arguments: {} });
    const res = await client.callTool({
      name: 'carpeta_tributaria_historial',
      arguments: { anio: '2025' },
    });
    const parsed = JSON.parse(toolText(res)) as { items: unknown[] };
    expect(parsed.items).toEqual([]);
  });

  it('is read-only', async () => {
    const client = await connect(makeRuntime());
    const { tools } = await client.listTools();
    expect(
      tools.find((t) => t.name === 'carpeta_tributaria_historial')?.annotations?.readOnlyHint,
    ).toBe(true);
  });
});
