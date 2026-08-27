import { describe, it, expect } from 'vitest';
import { HOSTS, NotAuthenticatedError, testing, type Runtime } from '@dostertags/sii-core';
import { datos, run, runJson } from '../test-helpers.js';

describe('sii carpeta historial command (fake runtime, no SII)', () => {
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
  const requestJson = (url: string): unknown => {
    if (url.includes('agno=2025')) return [];
    return [ROW];
  };
  const makeRuntime = (): Runtime => ({
    clock: new testing.FixedClock(new Date('2026-08-03T12:00:00Z')),
    audit: new testing.RecordingAuditSink(),
    store: new testing.InMemoryKeyValueStore(),
    portal: new testing.FakePortalDriver({
      loginSession: { landingUrl: HOSTS.miSii, evaluate: datos, storageState: { cookies: [] } },
      restoreSession: { landingUrl: HOSTS.miSii, evaluate: datos, requestJson },
    }),
  });

  it('carpeta historial prints the rows for every año by default', async () => {
    const rt = makeRuntime();
    await run(rt, 'auth', 'login');
    const out = await run(rt, 'carpeta', 'historial');
    expect(out).toContain('Carpetas Tributarias Regulares (todos los años)');
    expect(out).toContain('código=30000001');
    expect(out).toContain('institución=OTRA INSTITUCIÓN');
  });

  it('carpeta historial --anio filters and reports an empty result cleanly', async () => {
    const rt = makeRuntime();
    await run(rt, 'auth', 'login');
    const out = await run(rt, 'carpeta', 'historial', '--anio', '2025');
    expect(out).toContain('Sin carpetas tributarias generadas.');
  });

  it('JSON default: carpeta historial emits the curated object', async () => {
    const rt = makeRuntime();
    await run(rt, 'auth', 'login');
    const json = (await runJson(rt, 'carpeta', 'historial')) as {
      items: { codigoRepositorio: number; receptorNombre: string }[];
    };
    expect(json.items[0]?.codigoRepositorio).toBe(30000001);
    expect(json.items[0]?.receptorNombre).toBe('Empresa A SpA');
  });

  it('carpeta historial requires a session (NotAuthenticated)', async () => {
    await expect(run(makeRuntime(), 'carpeta', 'historial')).rejects.toBeInstanceOf(NotAuthenticatedError);
  });
});
