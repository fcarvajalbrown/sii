import { describe, it, expect } from 'vitest';
import { HOSTS, NotAuthenticatedError, testing, type Runtime } from '@dostertags/sii-core';
import { datos, run, runJson } from '../test-helpers.js';

describe('sii renta command (fake runtime, no SII)', () => {
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

  function makeRentaRuntime(estados: Record<string, unknown> = {}): Runtime {
    const requestJson = (url: string, options?: unknown): unknown => {
      if (url.includes('buscaDeclVgte')) return DECLS;
      if (url.includes('f22Compacto')) return GRID;
      if (url.includes('getDeclaracionConEstados')) {
        const d = (options as { body?: { data?: Record<string, unknown> } })?.body?.data ?? {};
        const key = `${String(d['anno'] ?? '')}${String(d['mes'] ?? '')}`;
        return estados[key] ?? { metaData: { errors: [] }, data: [] };
      }
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

  const mes = (folio: number, monto: number) => ({
    metaData: { errors: [] },
    data: [
      { estadoDeclaracionId: 1, estado: 'Vigente', folio, declFechaCreacion: '12/02/2025', monto },
    ],
  });

  it('prints the año tributario alongside the commercial year it declares', async () => {
    const rt = makeRentaRuntime({ '202501': mes(11, 50000) });
    await run(rt, 'auth', 'login');

    const out = await run(rt, 'renta', '2026', '--human');

    // The year offset is the domain rule — it must be visible to the user, not just in the JSON.
    expect(out).toContain('AT 2026');
    expect(out).toContain('2025');
    expect(out).toContain('F22');
    expect(out).toContain('F29');
  });

  it('emits the pack as JSON by default with both years and twelve months (ADR-012)', async () => {
    const rt = makeRentaRuntime({ '202501': mes(11, 50000) });
    await run(rt, 'auth', 'login');

    const json = (await runJson(rt, 'renta', '2026')) as {
      anio: string;
      anioComercial: string;
      iva: { meses: unknown[]; mesesConDeclaracion: number };
    };

    expect(json.anio).toBe('2026');
    expect(json.anioComercial).toBe('2025');
    expect(json.iva.meses).toHaveLength(12);
    expect(json.iva.mesesConDeclaracion).toBe(1);
  });

  it('never renders F22 identity PII in the human output', async () => {
    const rt = makeRentaRuntime();
    await run(rt, 'auth', 'login');

    const out = await run(rt, 'renta', '2026', '--human');

    expect(out).not.toContain('PII APELLIDO');
  });

  it('requires a session (NotAuthenticated → exit 2)', async () => {
    const rt = makeRentaRuntime(); // no login
    await expect(run(rt, 'renta', '2026')).rejects.toBeInstanceOf(NotAuthenticatedError);
  });
});
