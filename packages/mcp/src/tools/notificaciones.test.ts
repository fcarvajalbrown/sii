import { describe, it, expect } from 'vitest';
import { HOSTS, testing, type Runtime } from '@dostertags/sii-core';
import { connect, toolText } from '../test-helpers.js';

const datos = (): unknown => ({
  contribuyente: { rut: 11111111, dv: '1', nombres: 'Juan', apellidoPaterno: 'Pérez' },
});

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

function makeRuntime(): Runtime {
  const requestForm = (_url: string, options?: { form?: Record<string, string> }): string => {
    const opc = options?.form?.['opc'];
    if (opc === '41') return LIST_FORMAL_EMPTY;
    if (opc === '40') return LIST_CORRESPONDENCIA;
    if (opc === '42') return DETALLE_BODY;
    throw new Error(`unexpected opc: ${opc}`);
  };
  return {
    clock: new testing.FixedClock(new Date('2026-08-03T12:00:00Z')),
    audit: new testing.RecordingAuditSink(),
    store: new testing.InMemoryKeyValueStore(),
    portal: new testing.FakePortalDriver({
      loginSession: { landingUrl: HOSTS.miSii, evaluate: datos, storageState: { cookies: [] } },
      restoreSession: { landingUrl: HOSTS.miSii, evaluate: datos, requestForm },
    }),
  };
}

describe('@dostertags/sii-mcp notificaciones tools (in-memory client, fake runtime, no SII)', () => {
  it('notificaciones_list defaults to FORMAL and returns the legitimate-empty result', async () => {
    const client = await connect(makeRuntime());
    await client.callTool({ name: 'auth_login', arguments: {} });
    const res = await client.callTool({ name: 'notificaciones_list', arguments: {} });
    const parsed = JSON.parse(toolText(res)) as { categoria: string; items: unknown[] };
    expect(parsed.categoria).toBe('FORMAL');
    expect(parsed.items).toEqual([]);
  });

  it('notificaciones_list categoria=correspondencia returns the rows', async () => {
    const client = await connect(makeRuntime());
    await client.callTool({ name: 'auth_login', arguments: {} });
    const res = await client.callTool({
      name: 'notificaciones_list',
      arguments: { categoria: 'correspondencia' },
    });
    const parsed = JSON.parse(toolText(res)) as { items: { id: number }[] };
    expect(parsed.items.map((i) => i.id)).toEqual([5790241]);
  });

  it('notificaciones_detalle returns asunto/body as JSON', async () => {
    const client = await connect(makeRuntime());
    await client.callTool({ name: 'auth_login', arguments: {} });
    const res = await client.callTool({
      name: 'notificaciones_detalle',
      arguments: { id: 5790241, tipo: '4', categoria: 'correspondencia' },
    });
    const parsed = JSON.parse(toolText(res)) as { asunto: string; bodyHtml: string };
    expect(parsed.asunto).toBe('Petición administrativa recibida');
    expect(parsed.bodyHtml).toContain('texto de la carta');
  });

  it('both tools are read-only', async () => {
    const client = await connect(makeRuntime());
    const { tools } = await client.listTools();
    expect(tools.find((t) => t.name === 'notificaciones_list')?.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === 'notificaciones_detalle')?.annotations?.readOnlyHint).toBe(true);
  });
});
