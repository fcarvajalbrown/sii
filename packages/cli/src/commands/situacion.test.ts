import { describe, it, expect } from 'vitest';
import { HOSTS, NotAuthenticatedError, testing, type Runtime } from '@dostertags/sii-core';
import { datos, run, runJson } from '../test-helpers.js';

const FIXTURES: Record<string, unknown> = {
  '112': {
    contribuyente: {
      razonSocial: 'MI EMPRESA SPA',
      tipoContribuyenteDescripcion: 'PERSONA JURIDICA COMERCIAL',
      segmentoDescripcion: 'GRAN EMPRESA',
      fechaInicioActividades: '2019-06-19 00:00:00.0',
    },
    actEcos: [
      { codigo: 466302, descripcion: 'VENTA MATERIALES', categoriaTributaria: 1, afectoIva: 'S', fechaInicio: '19-06-2019' },
    ],
    timbrajes: [{ codigo: 33, descripcion: 'FACTURA ELECTRONICA', fechaLegalizacion: '30-07-2026' }],
    socios: [{ rut: 22222222, razonSocial: 'SOCIO SECRETO' }],
    representantes: [],
    direcciones: [],
  },
  '118': {
    estado: 'Cumple sus obligaciones tributarias',
    atributos: [{ atrCodigo: 'NDIR', cumple: 'SI', titulo: 'No tener atrasos' }],
  },
  '22': {
    atributos: [
      { atrCodigo: 'M14A', descAtrCodigo: 'REGIMEN GENERAL SEMI INTEGRADO (14A)', fechaInicio: '01-01-2022' },
    ],
  },
};

describe('sii situacion command (fake runtime, no SII)', () => {
  const makeRuntime = (): Runtime => ({
    clock: new testing.FixedClock(new Date('2026-08-04T12:00:00Z')),
    audit: new testing.RecordingAuditSink(),
    store: new testing.InMemoryKeyValueStore(),
    portal: new testing.FakePortalDriver({
      loginSession: { landingUrl: HOSTS.miSii, evaluate: datos, storageState: { cookies: [] } },
      restoreSession: {
        landingUrl: HOSTS.miSii,
        evaluate: datos,
        requestForm: (_url, options) => JSON.stringify(FIXTURES[options?.form?.['opc'] ?? ''] ?? {}),
      },
    }),
  });

  it('imprime régimen, inicio de actividades y cumplimiento COT', async () => {
    const rt = makeRuntime();
    await run(rt, 'auth', 'login');
    const out = await run(rt, 'situacion');
    expect(out).toContain('REGIMEN GENERAL SEMI INTEGRADO (14A)');
    expect(out).toContain('Inicio de actividades: 2019-06-19');
    expect(out).toContain('Cumple sus obligaciones tributarias');
    expect(out).toContain('[OK  ] No tener atrasos');
  });

  it('informa el conteo de socios sin identificarlos', async () => {
    const rt = makeRuntime();
    await run(rt, 'auth', 'login');
    const out = await run(rt, 'situacion');
    expect(out).toContain('1 socio(s)');
    expect(out).not.toContain('SOCIO SECRETO');
  });

  it('JSON por defecto: emite el objeto curado sin PII de terceros', async () => {
    const rt = makeRuntime();
    await run(rt, 'auth', 'login');
    const json = (await runJson(rt, 'situacion')) as {
      perfil: { fechaInicioActividades: string };
      regimenes: { codigo: string }[];
    };
    expect(json.perfil.fechaInicioActividades).toBe('2019-06-19 00:00:00.0');
    expect(json.regimenes[0]?.codigo).toBe('M14A');
    expect(JSON.stringify(json)).not.toContain('SOCIO SECRETO');
  });

  it('requiere sesión (NotAuthenticated)', async () => {
    await expect(run(makeRuntime(), 'situacion')).rejects.toBeInstanceOf(NotAuthenticatedError);
  });
});
