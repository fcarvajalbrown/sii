import { describe, it, expect } from 'vitest';
import { HOSTS, testing, type Runtime } from '@dostertags/sii-core';
import { connect, datos, toolText } from '../test-helpers.js';

describe('@dostertags/sii-mcp renta tool (in-memory client, fake runtime, no SII)', () => {
  const DECLS = {
    metaData: { errors: [] },
    data: {
      decls: [{ folio: '99001', vgte: 'S', codConc: 'C1', fecIng: '20/04/2026' }],
      glosas: [{ codConclusion: 'C1', descripcion: 'Declaración vigente' }],
    },
  };
  const GRID = {
    metaData: { errors: [] },
    data: [
      { codigo: '1', valor: 'PII APELLIDO', glosa: 'Apellido paterno' },
      { codigo: '158', valor: '12.500.000', glosa: 'Honorarios' },
    ],
  };

  function makeRuntime(): Runtime {
    const requestJson = (url: string): unknown => {
      if (url.includes('buscaDeclVgte')) return DECLS;
      if (url.includes('f22Compacto')) return GRID;
      if (url.includes('getDeclaracionConEstados')) return { metaData: { errors: [] }, data: [] };
      throw new Error(`unexpected url: ${url}`);
    };
    return {
      clock: new testing.FixedClock(new Date('2026-07-25T12:00:00Z')),
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

  it('returns the annual pack, pairs AT N with commercial N-1, and is read-only', async () => {
    const client = await connect(makeRuntime());
    await client.callTool({ name: 'auth_login', arguments: {} });

    const res = await client.callTool({ name: 'renta', arguments: { anio: '2026' } });
    const parsed = JSON.parse(toolText(res)) as {
      anio: string;
      anioComercial: string;
      iva: { meses: unknown[] };
      f22: { folio: string | null };
    };

    expect(parsed.anio).toBe('2026');
    expect(parsed.anioComercial).toBe('2025');
    expect(parsed.iva.meses).toHaveLength(12);
    expect(parsed.f22.folio).toBe('99001');
    // No identity PII rides the grid into the model's context.
    expect(toolText(res)).not.toContain('PII APELLIDO');

    const { tools } = await client.listTools();
    expect(tools.find((t) => t.name === 'renta')?.annotations?.readOnlyHint).toBe(true);
  });

  it('declares the year-offset rule to the model, so it cannot mis-state the period', async () => {
    const client = await connect(makeRuntime());
    const { tools } = await client.listTools();
    const d = tools.find((t) => t.name === 'renta')?.description ?? '';

    expect(d).toMatch(/año comercial/i);
    expect(d).toMatch(/2025/); // the worked example (AT 2026 declares 2025)
  });
});
