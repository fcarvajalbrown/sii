import { describe, it, expect } from 'vitest';
import {
  FakePortalDriver,
  FixedClock,
  InMemoryKeyValueStore,
  RecordingAuditSink,
} from '../adapters/fake/index.js';
import type { FormRequest, Runtime } from '../seams/index.js';
import { NotAuthenticatedError } from '../errors/index.js';
import { initOperateState, setOperatingRut } from '../identity/index.js';
import { writeSession } from '../auth/index.js';
import { profile } from './profile.js';

const SELF = '11111111-1';
const EMPRESA = '77777777-7';

const PERFIL = {
  contribuyente: { razonSocial: 'MI EMPRESA SPA' },
  actEcos: [],
  timbrajes: [],
  socios: [
    {
      rut: '22222222',
      dv: '2',
      razonSocial: 'SOCIO SECRETO SPA',
      participacionCapital: '50.00',
      participacionUtilidades: '50.00',
      fechaIncorporacion: '2020-01-01 00:00:00.0',
      fechaFinParticipacion: null,
      vigente: 'S',
    },
  ],
  representantes: [
    {
      rut: '33333333',
      dv: '3',
      nombres: 'JUAN',
      apellidoPaterno: 'PEREZ',
      apellidoMaterno: 'SOTO',
      fechaInicio: '2019-01-01 00:00:00.0',
      fechaTermino: null,
      vigente: 'S',
    },
  ],
  direcciones: [
    {
      calle: 'CALLE SECRETA 123',
      comunaDescripcion: 'SANTIAGO',
      regionDescripcion: 'REGION METROPOLITANA',
      tipoDomicilioDescripcion: 'DOMICILIO',
      tipoPropiedadDescripcion: 'ARRENDADO NOTARIAL',
      telefono: null,
      rutPropietario: '44444444',
      dvPropietario: '4',
    },
  ],
};

function makeRuntime(): Runtime {
  const requestForm = (_url: string, options?: FormRequest): string => {
    const opc = options?.form?.['opc'] ?? '';
    if (opc !== '112') throw new Error(`opc inesperado: ${opc}`);
    return JSON.stringify(PERFIL);
  };
  return {
    clock: new FixedClock(new Date('2026-08-05T12:00:00Z')),
    audit: new RecordingAuditSink(),
    store: new InMemoryKeyValueStore(),
    portal: new FakePortalDriver({ restoreSession: { requestForm, cookies: { TOKEN: 't' } } }),
  };
}

async function seed(runtime: Runtime): Promise<void> {
  await writeSession(runtime.store, { rut: SELF, cookies: ['c'], savedAt: '2026-08-05T12:00:00Z' });
  await initOperateState(runtime.store, {
    selfRut: SELF,
    accountType: 'persona',
    operable: [
      { rut: SELF, razonSocial: 'Juan Pérez', isSelf: true },
      { rut: EMPRESA, razonSocial: 'Mi Empresa SpA', isSelf: false },
    ],
  });
}

const entries = (rt: Runtime) => (rt.audit as RecordingAuditSink).entries;
const driverOf = (rt: Runtime) => rt.portal as FakePortalDriver;

describe('profile (fakes, no SII)', () => {
  it('sin incluirTerceros: NO expone socios/representantes ni el RUT del arrendador', async () => {
    const rt = makeRuntime();
    await seed(rt);

    const res = await profile(rt);

    expect(res.incluyoTerceros).toBe(false);
    expect(res.socios).toEqual([]);
    expect(res.representantes).toEqual([]);
    expect(res.conteos).toEqual({ socios: 1, representantes: 1, direcciones: 1 });
    expect(res.direcciones[0]).toMatchObject({ calle: 'CALLE SECRETA 123', rutPropietario: null, dvPropietario: null });
    const json = JSON.stringify(res);
    expect(json).not.toContain('SOCIO SECRETO');
    expect(json).not.toContain('44444444');
  });

  it('con incluirTerceros: SÍ expone socios/representantes y el RUT del arrendador', async () => {
    const rt = makeRuntime();
    await seed(rt);

    const res = await profile(rt, { incluirTerceros: true });

    expect(res.incluyoTerceros).toBe(true);
    expect(res.socios).toEqual([
      {
        rut: '22222222',
        dv: '2',
        nombre: 'SOCIO SECRETO SPA',
        participacionCapital: 50,
        participacionUtilidades: 50,
        fechaIncorporacion: '2020-01-01 00:00:00.0',
        fechaFinParticipacion: null,
        vigente: true,
      },
    ]);
    expect(res.representantes[0]?.nombre).toBe('JUAN PEREZ SOTO');
    expect(res.direcciones[0]?.rutPropietario).toBe('44444444');
  });

  it('el domicilio propio se expone SIEMPRE (con o sin incluirTerceros)', async () => {
    const rt = makeRuntime();
    await seed(rt);

    const res = await profile(rt);
    expect(res.direcciones[0]?.calle).toBe('CALLE SECRETA 123');
    expect(res.direcciones[0]?.comuna).toBe('SANTIAGO');
  });

  it('rechaza un puntero operate representando a otro RUT ANTES de abrir sesión (ADR-005)', async () => {
    const rt = makeRuntime();
    await seed(rt);
    await setOperatingRut(rt.store, EMPRESA);

    await expect(profile(rt)).rejects.toThrow(/session-keyed/i);
    expect(driverOf(rt).restoreCalls).toBe(0);
  });

  it('audita rut + incluyoTerceros + conteos — NUNCA un RUT o nombre de tercero', async () => {
    const rt = makeRuntime();
    await seed(rt);

    await profile(rt, { incluirTerceros: true });

    const a = entries(rt).at(-1)!;
    expect(a).toMatchObject({
      action: 'profile',
      result: 'ok',
      rut: SELF,
      incluyoTerceros: true,
      socios: 1,
      representantes: 1,
    });
    const json = JSON.stringify(a);
    expect(json).not.toContain('SOCIO SECRETO');
    expect(json).not.toContain('22222222');
  });

  it('sin sesión lanza NotAuthenticated y audita el fallo', async () => {
    const rt = makeRuntime();

    await expect(profile(rt)).rejects.toThrow(NotAuthenticatedError);
    expect(entries(rt).at(-1)).toMatchObject({ action: 'profile', result: 'failed' });
  });
});
