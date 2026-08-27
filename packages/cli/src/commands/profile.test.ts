import { describe, it, expect } from 'vitest';
import { HOSTS, NotAuthenticatedError, testing, type Runtime } from '@dostertags/sii-core';
import { datos, run, runJson } from '../test-helpers.js';

const PERFIL = {
  contribuyente: { razonSocial: 'MI EMPRESA SPA', fechaInicioActividades: '2019-06-19 00:00:00.0' },
  actEcos: [],
  timbrajes: [],
  socios: [
    {
      rut: '22222222',
      dv: '2',
      razonSocial: 'SOCIO SECRETO SPA',
      participacionCapital: '50.00',
      participacionUtilidades: '50.00',
      vigente: 'S',
    },
  ],
  representantes: [],
  direcciones: [
    {
      calle: 'CALLE SECRETA 123',
      comunaDescripcion: 'SANTIAGO',
      regionDescripcion: 'REGION METROPOLITANA',
      tipoDomicilioDescripcion: 'DOMICILIO',
      rutPropietario: '44444444',
      dvPropietario: '4',
    },
  ],
};

describe('sii profile command (fake runtime, no SII)', () => {
  const makeRuntime = (): Runtime => ({
    clock: new testing.FixedClock(new Date('2026-08-05T12:00:00Z')),
    audit: new testing.RecordingAuditSink(),
    store: new testing.InMemoryKeyValueStore(),
    portal: new testing.FakePortalDriver({
      loginSession: { landingUrl: HOSTS.miSii, evaluate: datos, storageState: { cookies: [] } },
      restoreSession: {
        landingUrl: HOSTS.miSii,
        evaluate: datos,
        requestForm: () => JSON.stringify(PERFIL),
      },
    }),
  });

  it('sin --incluir-terceros: no imprime socios ni el RUT del arrendador', async () => {
    const rt = makeRuntime();
    await run(rt, 'auth', 'login');
    const out = await run(rt, 'profile');
    expect(out).not.toContain('SOCIO SECRETO');
    expect(out).toContain('CALLE SECRETA 123');
    expect(out).toContain('usa --incluir-terceros');
  });

  it('con --incluir-terceros: imprime socios y el RUT del arrendador', async () => {
    const rt = makeRuntime();
    await run(rt, 'auth', 'login');
    const out = await run(rt, 'profile', '--incluir-terceros');
    expect(out).toContain('SOCIO SECRETO SPA');
    expect(out).toContain('44.444.444-4');
  });

  it('JSON por defecto: emite el objeto curado', async () => {
    const rt = makeRuntime();
    await run(rt, 'auth', 'login');
    const json = (await runJson(rt, 'profile', '--incluir-terceros')) as {
      socios: { nombre: string }[];
    };
    expect(json.socios[0]?.nombre).toBe('SOCIO SECRETO SPA');
  });

  it('requiere sesión (NotAuthenticated)', async () => {
    await expect(run(makeRuntime(), 'profile')).rejects.toBeInstanceOf(NotAuthenticatedError);
  });
});
