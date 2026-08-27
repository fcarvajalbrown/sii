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
import { situacionTributaria } from './situacion.js';

const SELF = '11111111-1';
const EMPRESA = '77777777-7';

const FIXTURES: Record<string, unknown> = {
  '112': {
    contribuyente: {
      razonSocial: 'MI EMPRESA SPA',
      tipoContribuyenteDescripcion: 'PERSONA JURIDICA COMERCIAL',
      segmentoDescripcion: 'GRAN EMPRESA',
      fechaInicioActividades: '2019-06-19 00:00:00.0',
      eMail: 'privado@empresa.cl',
    },
    actEcos: [{ codigo: 466302, descripcion: 'VENTA', categoriaTributaria: 1, afectoIva: 'S' }],
    timbrajes: [{ codigo: 33, descripcion: 'FACTURA ELECTRONICA' }],
    socios: [{ rut: 22222222, razonSocial: 'SOCIO SECRETO' }],
    representantes: [],
    direcciones: [],
  },
  '118': {
    estado: 'Cumple sus obligaciones tributarias',
    atributos: [
      { atrCodigo: 'NDIR', cumple: 'SI', titulo: 'No tener atrasos' },
      { atrCodigo: 'DQDT', cumple: 'NO', titulo: 'No tener denuncias o querellas por delito' },
    ],
  },
  '22': {
    atributos: [
      { atrCodigo: 'M14A', descAtrCodigo: 'REGIMEN GENERAL SEMI INTEGRADO (14A)', fechaInicio: '01-01-2022' },
    ],
  },
};

function makeRuntime(): Runtime {
  const requestForm = (_url: string, options?: FormRequest): string => {
    const opc = options?.form?.['opc'] ?? '';
    if (!(opc in FIXTURES)) throw new Error(`opc inesperado: ${opc}`);
    return JSON.stringify(FIXTURES[opc]);
  };
  return {
    clock: new FixedClock(new Date('2026-08-04T12:00:00Z')),
    audit: new RecordingAuditSink(),
    store: new InMemoryKeyValueStore(),
    portal: new FakePortalDriver({ restoreSession: { requestForm, cookies: { TOKEN: 't' } } }),
  };
}

async function seed(runtime: Runtime): Promise<void> {
  await writeSession(runtime.store, { rut: SELF, cookies: ['c'], savedAt: '2026-08-04T12:00:00Z' });
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

describe('situacionTributaria (fakes, no SII)', () => {
  it('compone perfil + cumplimiento + régimen en UNA sola sesión', async () => {
    const rt = makeRuntime();
    await seed(rt);

    const res = await situacionTributaria(rt);

    expect(res.rut).toBe(SELF);
    expect(res.perfil.fechaInicioActividades).toBe('2019-06-19 00:00:00.0');
    expect(res.cumplimiento.estado).toBe('Cumple sus obligaciones tributarias');
    expect(res.regimenes[0]?.codigo).toBe('M14A');
    expect(driverOf(rt).restoreCalls).toBe(1);
  });

  it('resume los requisitos INCUMPLIDOS para no obligar a filtrar a mano', async () => {
    const rt = makeRuntime();
    await seed(rt);

    const res = await situacionTributaria(rt);

    expect(res.requisitosIncumplidos).toEqual(['No tener denuncias o querellas por delito']);
  });

  it('nunca expone PII de terceros ni el email propio', async () => {
    const rt = makeRuntime();
    await seed(rt);

    const res = await situacionTributaria(rt);
    const json = JSON.stringify(res);

    expect(json).not.toContain('SOCIO SECRETO');
    expect(json).not.toContain('privado@empresa.cl');
    expect(res.perfil.conteos.socios).toBe(1);
  });

  it('rechaza un puntero operate representando a otro RUT ANTES de abrir sesión (ADR-005)', async () => {
    const rt = makeRuntime();
    await seed(rt);
    await setOperatingRut(rt.store, EMPRESA);

    await expect(situacionTributaria(rt)).rejects.toThrow(/session-keyed/i);
    expect(driverOf(rt).restoreCalls).toBe(0);
  });

  it('audita rut y conteo de incumplidos — nunca la razón social ni las actividades', async () => {
    const rt = makeRuntime();
    await seed(rt);

    await situacionTributaria(rt);

    const a = entries(rt).at(-1)!;
    expect(a).toMatchObject({ action: 'situacion_tributaria', result: 'ok', rut: SELF });
    expect(JSON.stringify(a)).not.toContain('MI EMPRESA SPA');
    expect(JSON.stringify(a)).not.toContain('466302');
  });

  it('sin sesión lanza NotAuthenticated y audita el fallo', async () => {
    const rt = makeRuntime();

    await expect(situacionTributaria(rt)).rejects.toThrow(NotAuthenticatedError);
    expect(entries(rt).at(-1)).toMatchObject({ action: 'situacion_tributaria', result: 'failed' });
  });
});
