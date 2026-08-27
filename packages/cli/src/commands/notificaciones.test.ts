import { describe, it, expect } from 'vitest';
import { HOSTS, NotAuthenticatedError, testing, type Runtime } from '@dostertags/sii-core';
import { datos, run, runJson } from '../test-helpers.js';

describe('sii notificaciones commands (fake runtime, no SII)', () => {
  const LIST_FORMAL_EMPTY = JSON.stringify({
    estado: 1403,
    glosa: 'No existen registros',
    data: [],
    metaData: null,
  });
  const LIST_CORRESPONDENCIA = JSON.stringify({
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
  const DETALLE_BODY = JSON.stringify({
    estado: 0,
    glosa: 'OK',
    data: {
      from: null,
      to: 'contacto@empresa.cl',
      asunto: 'Petición administrativa recibida',
      adjunto: [],
      body: '<p>texto de la carta</p>',
    },
    metaData: { page: null },
  });

  const requestForm = (_url: string, options?: { form?: Record<string, string> }): string => {
    const opc = options?.form?.['opc'];
    if (opc === '41') return LIST_FORMAL_EMPTY;
    if (opc === '40') return LIST_CORRESPONDENCIA;
    if (opc === '42') return DETALLE_BODY;
    throw new Error(`unexpected opc: ${opc}`);
  };
  const makeRuntime = (): Runtime => ({
    clock: new testing.FixedClock(new Date('2026-08-03T12:00:00Z')),
    audit: new testing.RecordingAuditSink(),
    store: new testing.InMemoryKeyValueStore(),
    portal: new testing.FakePortalDriver({
      loginSession: { landingUrl: HOSTS.miSii, evaluate: datos, storageState: { cookies: [] } },
      restoreSession: { landingUrl: HOSTS.miSii, evaluate: datos, requestForm },
    }),
  });

  it('notificaciones list defaults to FORMAL and reports an empty result cleanly', async () => {
    const rt = makeRuntime();
    await run(rt, 'auth', 'login');
    const out = await run(rt, 'notificaciones', 'list');
    expect(out).toContain('Notificaciones formales');
    expect(out).toContain('Sin registros.');
  });

  it('notificaciones list --correspondencia prints the rows', async () => {
    const rt = makeRuntime();
    await run(rt, 'auth', 'login');
    const out = await run(rt, 'notificaciones', 'list', '--correspondencia');
    expect(out).toContain('Correspondencia');
    expect(out).toContain('Petición administrativa recibida');
  });

  it('JSON default: notificaciones list emits the curated object', async () => {
    const rt = makeRuntime();
    await run(rt, 'auth', 'login');
    const json = (await runJson(rt, 'notificaciones', 'list', '--correspondencia')) as {
      categoria: string;
      items: { id: number }[];
    };
    expect(json.categoria).toBe('CORRESPONDENCIA');
    expect(json.items.map((i) => i.id)).toEqual([5790241]);
  });

  it('notificaciones detalle prints asunto + body', async () => {
    const rt = makeRuntime();
    await run(rt, 'auth', 'login');
    const out = await run(rt, 'notificaciones', 'detalle', '5790241', '4', '--correspondencia');
    expect(out).toContain('Petición administrativa recibida');
    expect(out).toContain('texto de la carta');
  });

  it('notificaciones list requires a session (NotAuthenticated)', async () => {
    await expect(run(makeRuntime(), 'notificaciones', 'list')).rejects.toBeInstanceOf(
      NotAuthenticatedError,
    );
  });
});
