import { describe, it, expect } from 'vitest';
import { HOSTS, testing, type Runtime } from '@dostertags/sii-core';
import { connect, toolText } from '../test-helpers.js';

const datos = (): unknown => ({
  contribuyente: { rut: 11111111, dv: '1', nombres: 'Juan', apellidoPaterno: 'Pérez' },
});

const ROW_2026 = {
  data: [{ id: 1, titulo: 'Sobre Bienes Raíces Arrendados', dj: 1835, estados: { '2025': 'Observada', '2026': 'Aceptada' } }],
  errorMsg: null,
};

function makeRuntime(): Runtime {
  return {
    clock: new testing.FixedClock(new Date('2026-08-03T12:00:00Z')),
    audit: new testing.RecordingAuditSink(),
    store: new testing.InMemoryKeyValueStore(),
    portal: new testing.FakePortalDriver({
      loginSession: { landingUrl: HOSTS.miSii, evaluate: datos, storageState: { cookies: [] } },
      restoreSession: {
        landingUrl: HOSTS.miSii,
        evaluate: datos,
        requestJson: (_url: string, options?: { body?: unknown }) => {
          const body = options?.body as { periodo?: string } | undefined;
          if (body?.periodo === '2026') return ROW_2026;
          return { data: null, errorMsg: 'Se ha generado un error en getDjIntegralAnual' };
        },
      },
    }),
  };
}

describe('@dostertags/sii-mcp dj tools (in-memory client, fake runtime, no SII)', () => {
  it('dj_status returns the curated estado as JSON', async () => {
    const client = await connect(makeRuntime());
    await client.callTool({ name: 'auth_login', arguments: {} });
    const res = await client.callTool({ name: 'dj_status', arguments: { years: 3 } });
    const parsed = JSON.parse(toolText(res)) as { rows: { dj: number }[]; aniosConsultados: string[] };
    expect(parsed.rows.map((r) => r.dj)).toEqual([1835]);
    expect(parsed.aniosConsultados).toEqual(['2025', '2026']);
  });

  it('dj_status is read-only', async () => {
    const client = await connect(makeRuntime());
    const { tools } = await client.listTools();
    expect(tools.find((t) => t.name === 'dj_status')?.annotations?.readOnlyHint).toBe(true);
  });
});

describe('@dostertags/sii-mcp dj_historial / dj_detalle tools (in-memory client, fake runtime, no SII)', () => {
  const HISTORIAL_2025 = {
    data: [
      {
        id: 1,
        titulo: 'Sobre Base imponible de primera categoría y datos contables balance',
        dj: 1926,
        result: [
          { key: 1001, codEstado: 2, estado: 'Aceptada', fecha: '2025-05-07T20:37:16', mes: null, mesNombre: null, folio: 599782, medioPresentacion: 'Formulario Electrónico', tipoDeclaracion: 'Rectificatoria', casos: 0 },
        ],
      },
    ],
    errorMsg: null,
  };
  const DETALLE_BODY = {
    data: {
      listDetalle: {
        'Seccion B': {
          detalle2: {
            tabla: {
              '02': { tipoCelda: 'dato', fila: { '04': { value: '12.345.678', colspan: 1, rowspan: 1, style: 'fw-valorCampo', contactoRut: false } } },
            },
          },
        },
      },
    },
    errorMsg: null,
  };

  function makeRuntime2(): Runtime {
    return {
      clock: new testing.FixedClock(new Date('2026-08-03T12:00:00Z')),
      audit: new testing.RecordingAuditSink(),
      store: new testing.InMemoryKeyValueStore(),
      portal: new testing.FakePortalDriver({
        loginSession: { landingUrl: HOSTS.miSii, evaluate: datos, storageState: { cookies: [] } },
        restoreSession: {
          landingUrl: HOSTS.miSii,
          evaluate: datos,
          requestJson: (_url: string, options?: { body?: unknown }) => {
            const body = options?.body as { periodo?: number | string } | undefined;
            if (body?.periodo === 2025) return HISTORIAL_2025;
            if (body?.periodo === '202500') return DETALLE_BODY;
            throw new Error(`unexpected body: ${JSON.stringify(body)}`);
          },
        },
      }),
    };
  }

  it('dj_historial returns folio/estado/tipoDeclaracion as JSON', async () => {
    const client = await connect(makeRuntime2());
    await client.callTool({ name: 'auth_login', arguments: {} });
    const res = await client.callTool({ name: 'dj_historial', arguments: { anio: '2025' } });
    const parsed = JSON.parse(toolText(res)) as { rows: { presentaciones: { folio: number }[] }[] };
    expect(parsed.rows[0]?.presentaciones[0]?.folio).toBe(599782);
  });

  it('dj_detalle returns the render-oriented table as JSON', async () => {
    const client = await connect(makeRuntime2());
    await client.callTool({ name: 'auth_login', arguments: {} });
    const res = await client.callTool({
      name: 'dj_detalle',
      arguments: { anio: '2025', dj: 1926, key: 122399351 },
    });
    const parsed = JSON.parse(toolText(res)) as { secciones: { nombre: string }[] };
    expect(parsed.secciones[0]?.nombre).toBe('Seccion B');
  });

  it('dj_historial and dj_detalle are both read-only', async () => {
    const client = await connect(makeRuntime2());
    const { tools } = await client.listTools();
    expect(tools.find((t) => t.name === 'dj_historial')?.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === 'dj_detalle')?.annotations?.readOnlyHint).toBe(true);
  });
});
