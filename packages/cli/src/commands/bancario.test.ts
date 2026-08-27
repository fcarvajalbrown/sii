import { describe, it, expect } from 'vitest';
import { HOSTS, NotAuthenticatedError, testing, type Runtime } from '@dostertags/sii-core';
import { datos, run, runJson } from '../test-helpers.js';

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

describe('sii bancario resumen command (fake runtime, no SII)', () => {
  const makeRuntime = (): Runtime => ({
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
  });

  it('imprime semestre, banco, y monto total', async () => {
    const rt = makeRuntime();
    await run(rt, 'auth', 'login');
    const out = await run(rt, 'bancario', 'resumen');
    expect(out).toContain('Primer semestre 2025');
    expect(out).toContain('BANCO DEL ESTADO DE CHILE');
    expect(out).toContain('Abonos: 1433');
  });

  it('JSON por defecto: emite el objeto curado', async () => {
    const rt = makeRuntime();
    await run(rt, 'auth', 'login');
    const json = (await runJson(rt, 'bancario', 'resumen')) as {
      rut: string;
      semestres: { montoTotalAbonos: number }[];
    };
    expect(json.semestres[0]?.montoTotalAbonos).toBe(619837498);
  });

  it('requiere sesión (NotAuthenticated)', async () => {
    await expect(run(makeRuntime(), 'bancario', 'resumen')).rejects.toBeInstanceOf(
      NotAuthenticatedError,
    );
  });
});
