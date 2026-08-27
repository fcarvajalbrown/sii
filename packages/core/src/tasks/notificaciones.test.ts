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
import { notificacionesDetalle, notificacionesList } from './notificaciones.js';

const SELF = '11111111-1';
const EMPRESA = '77777777-7';

const LIST_BODY_FORMAL_EMPTY = JSON.stringify({
  estado: 1403,
  glosa: 'No existen registros',
  data: [],
  metaData: null,
});
const LIST_BODY_CORRESPONDENCIA = JSON.stringify({
  estado: 0,
  glosa: 'OK',
  data: [
    {
      id: '5790241',
      descripcion: 'Petición administrativa recibida',
      fecha: 1629864000000,
      periodo: null,
      tipo: '4',
      descTipo: 'MAQUINA',
      origen: 'EMAIL',
      tipoNotificacion: 'Correo Electrónico',
    },
  ],
  metaData: { page: { fullSize: 1, currentPageIndex: 1, pageSize: 1000, lastPageIndex: 1 } },
});
const DETAIL_BODY = JSON.stringify({
  estado: 0,
  glosa: 'OK',
  data: {
    from: null,
    to: 'contacto@empresa.cl',
    asunto: 'Petición administrativa recibida',
    adjunto: [],
    body: '<html>carta</html>',
  },
  metaData: { page: null },
});

function makeRuntime(byOpc: Record<string, string>): Runtime {
  const requestForm = (_url: string, options?: FormRequest): string => {
    const opc = options?.form?.['opc'] ?? '';
    const fixture = byOpc[opc];
    if (fixture === undefined) throw new Error(`unexpected opc requested: ${opc}`);
    return fixture;
  };
  return {
    clock: new FixedClock(new Date('2026-08-03T12:00:00Z')),
    audit: new RecordingAuditSink(),
    store: new InMemoryKeyValueStore(),
    portal: new FakePortalDriver({ restoreSession: { requestForm, cookies: { TOKEN: 't' } } }),
  };
}

async function seed(runtime: Runtime): Promise<void> {
  await writeSession(runtime.store, { rut: SELF, cookies: ['c'], savedAt: '2026-08-03T12:00:00Z' });
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

describe('notificacionesList (fakes, no SII)', () => {
  it('defaults to FORMAL (opc=41) and returns the legitimate-empty result', async () => {
    const rt = makeRuntime({ '41': LIST_BODY_FORMAL_EMPTY });
    await seed(rt);

    const res = await notificacionesList(rt, {});

    expect(res.categoria).toBe('FORMAL');
    expect(res.items).toEqual([]);
  });

  it('reads CORRESPONDENCIA (opc=40) when requested', async () => {
    const rt = makeRuntime({ '40': LIST_BODY_CORRESPONDENCIA });
    await seed(rt);

    const res = await notificacionesList(rt, { categoria: 'correspondencia' });

    expect(res.categoria).toBe('CORRESPONDENCIA');
    expect(res.items).toHaveLength(1);
  });

  it('rejects a representing operate pointer BEFORE opening a session (ADR-005)', async () => {
    const rt = makeRuntime({ '41': LIST_BODY_FORMAL_EMPTY });
    await seed(rt);
    await setOperatingRut(rt.store, EMPRESA);

    await expect(notificacionesList(rt, {})).rejects.toThrow(/session-keyed/i);
    expect(driverOf(rt).restoreCalls).toBe(0);
  });

  it('audits rut + categoria + count, never a descripción value', async () => {
    const rt = makeRuntime({ '40': LIST_BODY_CORRESPONDENCIA });
    await seed(rt);

    await notificacionesList(rt, { categoria: 'correspondencia' });

    const a = entries(rt).at(-1)!;
    expect(a).toMatchObject({ action: 'notificaciones_list', result: 'ok', rut: SELF });
    expect(JSON.stringify(a)).not.toContain('Petición administrativa recibida');
  });

  it('raises NotAuthenticated with no session, and audits the failure', async () => {
    const rt = makeRuntime({});

    await expect(notificacionesList(rt, {})).rejects.toThrow(NotAuthenticatedError);
    expect(entries(rt).at(-1)).toMatchObject({ action: 'notificaciones_list', result: 'failed' });
  });
});

describe('notificacionesDetalle (fakes, no SII)', () => {
  it('reads a detail by id + tipo, audits without leaking body/asunto', async () => {
    const rt = makeRuntime({ '42': DETAIL_BODY });
    await seed(rt);

    const res = await notificacionesDetalle(rt, { categoria: 'correspondencia', id: 5790241, tipo: '4' });

    expect(res).toMatchObject({ id: 5790241, tipo: '4', to: 'contacto@empresa.cl' });
    const a = entries(rt).at(-1)!;
    expect(a).toMatchObject({ action: 'notificaciones_detalle', result: 'ok', rut: SELF });
    expect(JSON.stringify(a)).not.toContain('carta');
  });

  it('rejects a representing operate pointer BEFORE opening a session (ADR-005)', async () => {
    const rt = makeRuntime({ '42': DETAIL_BODY });
    await seed(rt);
    await setOperatingRut(rt.store, EMPRESA);

    await expect(
      notificacionesDetalle(rt, { categoria: 'correspondencia', id: 1, tipo: '4' }),
    ).rejects.toThrow(/session-keyed/i);
    expect(driverOf(rt).restoreCalls).toBe(0);
  });
});
