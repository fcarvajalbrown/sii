import { describe, it, expect } from 'vitest';
import { HOSTS, NotAuthenticatedError, testing, type Runtime } from '@dostertags/sii-core';
import { datos, run, runJson } from '../test-helpers.js';

const HEADERS = [
  'Período',
  'Folio Giro',
  'Formulario Giro',
  'Formulario Asociado',
  'Fecha de Emisión',
  'Fecha de Vencimiento',
  'Estado',
  'Moneda',
  'Saldo',
  'Ver',
  'Pagar en linea',
  'Imprimir Giro',
];

describe('sii giros list command (fake runtime, no SII)', () => {
  const makeRuntime = (): Runtime => {
    const evaluate = (expr: string): unknown => {
      if (/CONSULTAR_GIROS/.test(expr)) return 'ok';
      if (/LEER_GIROS/.test(expr)) {
        return JSON.stringify({
          tabla: true,
          conteo: '1',
          rows: [
            ['Consulta Giros'],
            HEADERS,
            ['Abril 2026', '9121778576', '21', '29', '25/06/2026', '20/05/2026', 'Vigente', 'CLP', '$0', '', '', ''],
          ],
        });
      }
      return datos();
    };
    return {
      clock: new testing.FixedClock(new Date('2026-08-03T12:00:00Z')),
      audit: new testing.RecordingAuditSink(),
      store: new testing.InMemoryKeyValueStore(),
      portal: new testing.FakePortalDriver({
        loginSession: { landingUrl: HOSTS.miSii, evaluate: datos, storageState: { cookies: [] } },
        restoreSession: { landingUrl: HOSTS.miSii, evaluate },
      }),
    };
  };

  it('imprime los giros del año en curso', async () => {
    const rt = makeRuntime();
    await run(rt, 'auth', 'login');
    const out = await run(rt, 'giros', 'list');
    expect(out).toContain('Giros —');
    expect(out).toContain('folio=9121778576');
    expect(out).toContain('vence=20/05/2026');
  });

  it('JSON por defecto: emite el objeto curado', async () => {
    const rt = makeRuntime();
    await run(rt, 'auth', 'login');
    const json = (await runJson(rt, 'giros', 'list')) as {
      giros: { folio: string; saldo: number; anio: string }[];
      saldoTotal: number;
    };
    expect(json.giros[0]).toMatchObject({ folio: '9121778576', saldo: 0, anio: '2026' });
    expect(json.saldoTotal).toBe(0);
  });

  it('nunca expone las columnas de acción de la página', async () => {
    const rt = makeRuntime();
    await run(rt, 'auth', 'login');
    const json = await runJson(rt, 'giros', 'list');
    expect(JSON.stringify(json)).not.toMatch(/pagar/i);
  });

  it('requiere sesión (NotAuthenticated)', async () => {
    await expect(run(makeRuntime(), 'giros', 'list')).rejects.toBeInstanceOf(NotAuthenticatedError);
  });
});
