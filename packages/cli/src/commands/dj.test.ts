import { describe, it, expect } from 'vitest';
import { HOSTS, NotAuthenticatedError, testing, type Runtime } from '@dostertags/sii-core';
import { datos, run, runJson } from '../test-helpers.js';

describe('sii dj command (fake runtime, no SII)', () => {
  const ROW_2026 = {
    data: [{ id: 1, titulo: 'Sobre Bienes Raíces Arrendados', dj: 1835, estados: { '2025': 'Observada', '2026': 'Aceptada' } }],
    errorMsg: null,
  };
  const requestJson = (_url: string, options?: { body?: unknown }): unknown => {
    const body = options?.body as { periodo?: string } | undefined;
    if (body?.periodo === '2026') return ROW_2026;
    return { data: null, errorMsg: 'Se ha generado un error en getDjIntegralAnual' };
  };
  const makeDjRuntime = (): Runtime => ({
    clock: new testing.FixedClock(new Date('2026-08-03T12:00:00Z')),
    audit: new testing.RecordingAuditSink(),
    store: new testing.InMemoryKeyValueStore(),
    portal: new testing.FakePortalDriver({
      loginSession: { landingUrl: HOSTS.miSii, evaluate: datos, storageState: { cookies: [] } },
      restoreSession: { landingUrl: HOSTS.miSii, evaluate: datos, requestJson },
    }),
  });

  it('dj status prints the DJ rows for the requested window', async () => {
    const rt = makeDjRuntime();
    await run(rt, 'auth', 'login');
    const out = await run(rt, 'dj', 'status', '--years', '3');
    expect(out).toContain('Estado DJ');
    expect(out).toContain('DJ 1835');
    expect(out).toContain('AT2026: Aceptada');
  });

  it('JSON default: dj status emits the curated object', async () => {
    const rt = makeDjRuntime();
    await run(rt, 'auth', 'login');
    const json = (await runJson(rt, 'dj', 'status', '--years', '3')) as {
      rows: { dj: number }[];
      aniosConsultados: string[];
    };
    expect(json.rows.map((r) => r.dj)).toEqual([1835]);
    expect(json.aniosConsultados).toEqual(['2025', '2026']);
  });

  it('dj status requires a session (NotAuthenticated → exit 2)', async () => {
    await expect(run(makeDjRuntime(), 'dj', 'status')).rejects.toBeInstanceOf(NotAuthenticatedError);
  });
});

describe('sii dj historial/detalle commands (fake runtime, no SII)', () => {
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
  const requestJson2 = (_url: string, options?: { body?: unknown }): unknown => {
    const body = options?.body as { periodo?: number | string } | undefined;
    if (body?.periodo === 2025) return HISTORIAL_2025;
    if (body?.periodo === '202500') return DETALLE_BODY;
    throw new Error(`unexpected body: ${JSON.stringify(body)}`);
  };
  const makeRuntime2 = (): Runtime => ({
    clock: new testing.FixedClock(new Date('2026-08-03T12:00:00Z')),
    audit: new testing.RecordingAuditSink(),
    store: new testing.InMemoryKeyValueStore(),
    portal: new testing.FakePortalDriver({
      loginSession: { landingUrl: HOSTS.miSii, evaluate: datos, storageState: { cookies: [] } },
      restoreSession: { landingUrl: HOSTS.miSii, evaluate: datos, requestJson: requestJson2 },
    }),
  });

  it('dj historial prints folio/estado/tipoDeclaracion', async () => {
    const rt = makeRuntime2();
    await run(rt, 'auth', 'login');
    const out = await run(rt, 'dj', 'historial', '2025');
    expect(out).toContain('folio=599782');
    expect(out).toContain('Rectificatoria');
  });

  it('dj detalle prints the table cell values', async () => {
    const rt = makeRuntime2();
    await run(rt, 'auth', 'login');
    const out = await run(rt, 'dj', 'detalle', '2025', '1926', '122399351');
    expect(out).toContain('Seccion B');
    expect(out).toContain('12.345.678');
  });

  it('JSON default: dj detalle emits the curated structure', async () => {
    const rt = makeRuntime2();
    await run(rt, 'auth', 'login');
    const json = (await runJson(rt, 'dj', 'detalle', '2025', '1926', '122399351')) as {
      secciones: { nombre: string }[];
    };
    expect(json.secciones[0]?.nombre).toBe('Seccion B');
  });
});
