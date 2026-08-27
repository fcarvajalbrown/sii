import { describe, it, expect } from 'vitest';
import { HOSTS, testing, type Runtime } from '@dostertags/sii-core';
import { connect, toolText } from '../test-helpers.js';

const datos = (): unknown => ({
  contribuyente: { rut: 11111111, dv: '1', nombres: 'Juan', apellidoPaterno: 'Pérez' },
});

const PERFIL = {
  contribuyente: { razonSocial: 'MI EMPRESA SPA' },
  actEcos: [],
  timbrajes: [],
  socios: [
    { rut: '22222222', dv: '2', razonSocial: 'SOCIO SECRETO SPA', vigente: 'S' },
  ],
  representantes: [],
  direcciones: [{ calle: 'CALLE SECRETA 123', rutPropietario: '44444444', dvPropietario: '4' }],
};

function makeRuntime(): Runtime {
  return {
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
  };
}

describe('@dostertags/sii-mcp profile tool (in-memory client, fake runtime, no SII)', () => {
  it('sin incluirTerceros: no expone socios ni el RUT del arrendador', async () => {
    const client = await connect(makeRuntime());
    await client.callTool({ name: 'auth_login', arguments: {} });
    const res = await client.callTool({ name: 'profile', arguments: {} });
    const text = toolText(res);
    expect(text).not.toContain('SOCIO SECRETO');
    expect(text).not.toContain('44444444');
    const parsed = JSON.parse(text) as { conteos: { socios: number } };
    expect(parsed.conteos.socios).toBe(1);
  });

  it('con incluirTerceros: expone socios y el RUT del arrendador', async () => {
    const client = await connect(makeRuntime());
    await client.callTool({ name: 'auth_login', arguments: {} });
    const res = await client.callTool({ name: 'profile', arguments: { incluirTerceros: true } });
    const parsed = JSON.parse(toolText(res)) as {
      socios: { nombre: string }[];
      direcciones: { rutPropietario: string | null }[];
    };
    expect(parsed.socios[0]?.nombre).toBe('SOCIO SECRETO SPA');
    expect(parsed.direcciones[0]?.rutPropietario).toBe('44444444');
  });

  it('es de solo lectura y declara la exposición de terceros en su descripción', async () => {
    const client = await connect(makeRuntime());
    const { tools } = await client.listTools();
    const t = tools.find((x) => x.name === 'profile');
    expect(t?.annotations?.readOnlyHint).toBe(true);
    expect(t?.description).toMatch(/terceros/i);
  });
});
