import { describe, it, expect } from 'vitest';
import { HOSTS, testing, type Runtime } from '@dostertags/sii-core';
import { connect, toolText } from '../test-helpers.js';

const datos = (): unknown => ({
  contribuyente: { rut: 11111111, dv: '1', nombres: 'Juan', apellidoPaterno: 'Pérez' },
});

const FIXTURES: Record<string, unknown> = {
  '112': {
    contribuyente: { razonSocial: 'MI EMPRESA SPA', fechaInicioActividades: '2019-06-19 00:00:00.0' },
    actEcos: [],
    timbrajes: [],
    socios: [{ rut: 22222222, razonSocial: 'SOCIO SECRETO' }],
    representantes: [],
    direcciones: [],
  },
  '118': {
    estado: 'Cumple sus obligaciones tributarias',
    atributos: [{ atrCodigo: 'DQDT', cumple: 'NO', titulo: 'No tener denuncias' }],
  },
  '22': { atributos: [{ atrCodigo: 'M14A', descAtrCodigo: 'REGIMEN GENERAL SEMI INTEGRADO (14A)' }] },
};

function makeRuntime(): Runtime {
  return {
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
  };
}

describe('@dostertags/sii-mcp situacion_tributaria tool (in-memory client, fake runtime, no SII)', () => {
  it('devuelve régimen, cumplimiento e incumplidos como JSON', async () => {
    const client = await connect(makeRuntime());
    await client.callTool({ name: 'auth_login', arguments: {} });
    const res = await client.callTool({ name: 'situacion_tributaria', arguments: {} });
    const parsed = JSON.parse(toolText(res)) as {
      regimenes: { codigo: string }[];
      requisitosIncumplidos: string[];
    };
    expect(parsed.regimenes[0]?.codigo).toBe('M14A');
    expect(parsed.requisitosIncumplidos).toEqual(['No tener denuncias']);
  });

  it('nunca expone PII de terceros', async () => {
    const client = await connect(makeRuntime());
    await client.callTool({ name: 'auth_login', arguments: {} });
    const res = await client.callTool({ name: 'situacion_tributaria', arguments: {} });
    expect(toolText(res)).not.toContain('SOCIO SECRETO');
  });

  it('es de solo lectura, sin argumentos, y declara la postura de PII', async () => {
    const client = await connect(makeRuntime());
    const { tools } = await client.listTools();
    const t = tools.find((x) => x.name === 'situacion_tributaria');
    expect(t?.annotations?.readOnlyHint).toBe(true);
    expect(t?.description).toMatch(/no expone socios/i);
    expect(t?.description).toMatch(/inicio de actividades/i);
  });
});
