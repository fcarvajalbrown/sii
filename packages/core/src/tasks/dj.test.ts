import { describe, it, expect } from 'vitest';
import {
  FakePortalDriver,
  FixedClock,
  InMemoryKeyValueStore,
  RecordingAuditSink,
} from '../adapters/fake/index.js';
import type { JsonRequest, Runtime } from '../seams/index.js';
import { DjError, NotAuthenticatedError } from '../errors/index.js';
import { initOperateState, setOperatingRut } from '../identity/index.js';
import { writeSession } from '../auth/index.js';
import { djDetalle, djHistorial, djStatus } from './dj.js';

// Synthetic data (no SII, no real PII): persona 11.111.111-1, empresa 77.777.777-7.
const SELF = '11111111-1';
const EMPRESA = '77777777-7';

/** Per-`periodo` (año tributario string) fixture responses. `null` → the DJ "out of range"
 *  error shape (`data: null, errorMsg: "..."`). */
function makeRuntime(byPeriodo: Record<string, unknown | null>): Runtime {
  const requestJson = (_url: string, options?: JsonRequest): unknown => {
    const body = options?.body as { periodo?: string } | undefined;
    const periodo = body?.periodo ?? '';
    const fixture = byPeriodo[periodo];
    if (fixture === undefined) throw new Error(`unexpected periodo requested: ${periodo}`);
    if (fixture === null) return { data: null, errorMsg: 'Se ha generado un error en getDjIntegralAnual' };
    return fixture;
  };
  return {
    clock: new FixedClock(new Date('2026-08-03T12:00:00Z')),
    audit: new RecordingAuditSink(),
    store: new InMemoryKeyValueStore(),
    portal: new FakePortalDriver({ restoreSession: { requestJson, cookies: { TOKEN: 't' } } }),
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

const ROW_2026 = {
  data: [{ id: 1, titulo: 'Sobre Bienes Raíces Arrendados', dj: 1835, estados: { '2025': 'Observada', '2026': 'Aceptada' } }],
  errorMsg: null,
};
const ROW_2023 = {
  data: [{ id: 1, titulo: 'Sobre Bienes Raíces Arrendados', dj: 1835, estados: { '2021': 'Aceptada', '2022': 'Aceptada', '2023': 'Aceptada' } }],
  errorMsg: null,
};

describe('djStatus (fakes, no SII)', () => {
  it('fetches one window when years <= 3, merges nothing to merge', async () => {
    const rt = makeRuntime({ '2026': ROW_2026 });
    await seed(rt);

    const res = await djStatus(rt, { years: 3 });

    expect(res.rut).toBe(SELF);
    expect(res.aniosConsultados).toEqual(['2025', '2026']);
    expect(res.rows).toEqual([
      { id: 1, dj: 1835, titulo: 'Sobre Bienes Raíces Arrendados', estados: { '2025': 'Observada', '2026': 'Aceptada' } },
    ]);
    expect(res.historiaAgotada).toBe(false);
  });

  it('fans out multiple non-overlapping-by-3 windows and MERGES estados by dj number', async () => {
    const rt = makeRuntime({ '2026': ROW_2026, '2023': ROW_2023 });
    await seed(rt);

    const res = await djStatus(rt, { years: 6 });

    expect(res.rows).toHaveLength(1); // same dj (1835) across both windows — merged, not duplicated
    expect(res.rows[0]?.estados).toEqual({
      '2021': 'Aceptada',
      '2022': 'Aceptada',
      '2023': 'Aceptada',
      '2025': 'Observada',
      '2026': 'Aceptada',
    });
    expect(res.aniosConsultados).toEqual(['2021', '2022', '2023', '2025', '2026']);
  });

  it('stops sweeping (soft stop) when an OLDER periodo runs off the front of SII\'s history — not a hard failure', async () => {
    const rt = makeRuntime({ '2026': ROW_2026, '2023': null }); // 2023 = out-of-range shape
    await seed(rt);

    const res = await djStatus(rt, { years: 6 });

    expect(res.rows).toHaveLength(1);
    expect(res.aniosConsultados).toEqual(['2025', '2026']); // only what the first window gave
    expect(res.historiaAgotada).toBe(true); // sweep stopped early because SII ran out of history
  });

  it('the MOST RECENT periodo failing is NOT treated as a soft stop — it propagates', async () => {
    const rt = makeRuntime({ '2026': null });
    await seed(rt);

    await expect(djStatus(rt, { years: 6 })).rejects.toBeInstanceOf(DjError);
  });

  it('rejects a representing operate pointer BEFORE opening a session (ADR-005)', async () => {
    const rt = makeRuntime({ '2026': ROW_2026 });
    await seed(rt);
    await setOperatingRut(rt.store, EMPRESA);

    await expect(djStatus(rt, { years: 3 })).rejects.toThrow(/session-keyed/i);
    expect(driverOf(rt).restoreCalls).toBe(0);
  });

  it('opens exactly ONE session for the whole sweep', async () => {
    const rt = makeRuntime({ '2026': ROW_2026, '2023': ROW_2023 });
    await seed(rt);

    await djStatus(rt, { years: 6 });

    expect(driverOf(rt).restoreCalls).toBe(1);
  });

  it('audits rut, años count and result — never a DJ estado value', async () => {
    const rt = makeRuntime({ '2026': ROW_2026 });
    await seed(rt);

    await djStatus(rt, { years: 3 });

    const a = entries(rt).at(-1)!;
    expect(a).toMatchObject({ action: 'dj_status', result: 'ok', rut: SELF });
    expect(JSON.stringify(a)).not.toContain('Aceptada');
  });

  it('raises NotAuthenticated with no session, and audits the failure', async () => {
    const rt = makeRuntime({});

    await expect(djStatus(rt, { years: 3 })).rejects.toThrow(NotAuthenticatedError);
    expect(entries(rt).at(-1)).toMatchObject({ action: 'dj_status', result: 'failed' });
  });
});

describe('djHistorial (fakes, no SII)', () => {
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

  function makeHistorialRuntime(): Runtime {
    const requestJson = (_url: string, options?: JsonRequest): unknown => {
      const body = options?.body as { periodo?: number } | undefined;
      if (body?.periodo === 2025) return HISTORIAL_2025;
      throw new Error(`unexpected periodo requested: ${JSON.stringify(body)}`);
    };
    return {
      clock: new FixedClock(new Date('2026-08-03T12:00:00Z')),
      audit: new RecordingAuditSink(),
      store: new InMemoryKeyValueStore(),
      portal: new FakePortalDriver({ restoreSession: { requestJson, cookies: { TOKEN: 't' } } }),
    };
  }

  it('reads one año and returns the presentation history, audited without leaking data', async () => {
    const rt = makeHistorialRuntime();
    await seed(rt);

    const res = await djHistorial(rt, { anio: '2025' });

    expect(res.rows[0]?.presentaciones[0]).toMatchObject({ folio: 599782, estado: 'Aceptada' });
    const a = entries(rt).at(-1)!;
    expect(a).toMatchObject({ action: 'dj_historial', result: 'ok', rut: SELF });
    expect(JSON.stringify(a)).not.toContain('599782');
  });

  it('rejects a representing operate pointer BEFORE opening a session (ADR-005)', async () => {
    const rt = makeHistorialRuntime();
    await seed(rt);
    await setOperatingRut(rt.store, EMPRESA);

    await expect(djHistorial(rt, { anio: '2025' })).rejects.toThrow(/session-keyed/i);
    expect(driverOf(rt).restoreCalls).toBe(0);
  });
});

describe('djDetalle (fakes, no SII)', () => {
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

  function makeDetalleRuntime(): Runtime {
    const requestJson = (_url: string, options?: JsonRequest): unknown => {
      const body = options?.body as { periodo?: string; dj?: number; key?: number } | undefined;
      if (body?.periodo === '202500' && body.dj === 1926 && body.key === 122399351) return DETALLE_BODY;
      throw new Error(`unexpected body: ${JSON.stringify(body)}`);
    };
    return {
      clock: new FixedClock(new Date('2026-08-03T12:00:00Z')),
      audit: new RecordingAuditSink(),
      store: new InMemoryKeyValueStore(),
      portal: new FakePortalDriver({ restoreSession: { requestJson, cookies: { TOKEN: 't' } } }),
    };
  }

  it('reads the content for a given (anio, dj, key) and audits without leaking cell values', async () => {
    const rt = makeDetalleRuntime();
    await seed(rt);

    const res = await djDetalle(rt, { anio: '2025', dj: 1926, key: 122399351 });

    expect(res.secciones[0]?.tablas[0]?.filas['02']?.celdas['04']).toMatchObject({ value: '12.345.678' });
    const a = entries(rt).at(-1)!;
    expect(a).toMatchObject({ action: 'dj_detalle', result: 'ok', rut: SELF });
    expect(JSON.stringify(a)).not.toContain('12.345.678');
  });

  it('rejects a representing operate pointer BEFORE opening a session (ADR-005)', async () => {
    const rt = makeDetalleRuntime();
    await seed(rt);
    await setOperatingRut(rt.store, EMPRESA);

    await expect(djDetalle(rt, { anio: '2025', dj: 1926, key: 122399351 })).rejects.toThrow(/session-keyed/i);
    expect(driverOf(rt).restoreCalls).toBe(0);
  });
});
