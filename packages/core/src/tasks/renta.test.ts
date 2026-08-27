import { describe, it, expect } from 'vitest';
import {
  FakePortalDriver,
  FixedClock,
  InMemoryKeyValueStore,
  RecordingAuditSink,
} from '../adapters/fake/index.js';
import type { JsonRequest, Runtime } from '../seams/index.js';
import { NotAuthenticatedError, ValidationError } from '../errors/index.js';
import { initOperateState, setOperatingRut } from '../identity/index.js';
import { writeSession } from '../auth/index.js';
import { rentaAnual } from './renta.js';

// Synthetic data only (no SII, no real PII): persona 20.000.042-0, empresa 77.777.777-7.
const SELF = '20000042-0';
const EMPRESA = '77777777-7';

const DECLS_ENV = {
  metaData: { errors: [] },
  data: {
    decls: [
      { folio: '99001', vgte: 'S', codConc: 'C1', fecIng: '20/04/2026', nombres: 'PII NAME' },
    ],
    glosas: [{ codConclusion: 'C1', descripcion: 'Declaración vigente — aceptada' }],
  },
};

// f22Compacto grid: a tax código plus an identity código (1 = apellidos) that MUST be dropped.
const GRID_ENV = {
  metaData: { errors: [] },
  data: [
    { codigo: '1', valor: 'PII APELLIDO', glosa: 'Apellido paterno' },
    { codigo: '158', valor: '12.500.000', glosa: 'Honorarios' },
    { codigo: '305', valor: '900.000', glosa: 'Impuesto a pagar' },
  ],
};

/** F29 estado for one month; `monto` is the declared total a pagar. */
const estadoEnv = (folio: number, monto: number) => ({
  metaData: { errors: [] },
  data: [
    {
      estadoDeclaracionId: 1,
      estado: 'Vigente',
      folio,
      declFechaCreacion: '12/02/2025',
      monto,
    },
  ],
});

const EMPTY_ESTADO = { metaData: { errors: [] }, data: [] };

function makeRuntime(
  opts: {
    decls?: unknown;
    grid?: unknown;
    /** Per-`YYYYMM` F29 estado envelope; a missing month falls back to EMPTY_ESTADO. */
    estados?: Record<string, unknown>;
  } = {},
): Runtime {
  const requestJson = (url: string, options?: JsonRequest): unknown => {
    if (url.includes('buscaDeclVgte')) return opts.decls ?? DECLS_ENV;
    if (url.includes('f22Compacto')) return opts.grid ?? GRID_ENV;
    if (url.includes('getDeclaracionConEstados')) {
      const data = (options?.body as { data?: Record<string, unknown> } | undefined)?.data ?? {};
      // The F29 estado request carries the período as anno + mes (observed).
      const key = `${String(data['anno'] ?? '')}${String(data['mes'] ?? '').padStart(2, '0')}`;
      return opts.estados?.[key] ?? EMPTY_ESTADO;
    }
    throw new Error(`unexpected URL in renta composite: ${url}`);
  };
  return {
    clock: new FixedClock(new Date('2026-07-25T12:00:00Z')),
    audit: new RecordingAuditSink(),
    store: new InMemoryKeyValueStore(),
    portal: new FakePortalDriver({ restoreSession: { requestJson, cookies: { TOKEN: 't' } } }),
  };
}

async function seed(runtime: Runtime): Promise<void> {
  await writeSession(runtime.store, { rut: SELF, cookies: ['c'], savedAt: '2026-07-25T12:00:00Z' });
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
const driver = (rt: Runtime) => rt.portal as FakePortalDriver;
const clock = (rt: Runtime) => rt.clock as FixedClock;

describe('rentaAnual composite (fakes, no SII)', () => {
  it('pairs the F22 of año tributario N with the TWELVE F29 months of commercial year N-1', async () => {
    // AT 2026 declares commercial year 2025 — the domain rule that makes the halves comparable.
    const rt = makeRuntime({ estados: { '202501': estadoEnv(11, 50000) } });
    await seed(rt);

    const res = await rentaAnual(rt, { anio: '2026' });

    expect(res.anio).toBe('2026');
    expect(res.anioComercial).toBe('2025');
    expect(res.iva.meses).toHaveLength(12);
    expect(res.iva.meses[0]?.periodo).toBe('2025-01');
    expect(res.iva.meses[11]?.periodo).toBe('2025-12');
  });

  it('returns the F22 folio/estado plus the contador grouping of the código grid', async () => {
    const rt = makeRuntime();
    await seed(rt);

    const res = await rentaAnual(rt, { anio: '2026' });

    expect(res.f22).toMatchObject({
      tieneDeclaracion: true,
      folio: '99001',
      estado: 'Declaración vigente — aceptada',
    });
    expect(res.f22.grupos).not.toBeNull();
    // The grouping is over the same PII-filtered grid f22Status uses.
    const all = JSON.stringify(res.f22.grupos);
    expect(all).toContain('158');
    expect(all).not.toContain('PII APELLIDO');
  });

  it('picks the VIGENTE declaración of the month — never a saved-only draft (folio 0) listed first', async () => {
    // A month can carry a saved-but-never-filed draft (folio 0 — portal/f29.ts documents it) next
    // to the vigente declaración; `folio !== null` would report the draft's total as "lo que pagué".
    const conBorrador = {
      metaData: { errors: [] },
      data: [
        { estadoDeclaracionId: 5, estado: 'Guardada', folio: 0, declFechaCreacion: '10/02/2025', monto: 999999 },
        { estadoDeclaracionId: 1, estado: 'Vigente', folio: 1234, declFechaCreacion: '12/02/2025', monto: 500000 },
      ],
    };
    const rt = makeRuntime({ estados: { '202501': conBorrador } });
    await seed(rt);

    const res = await rentaAnual(rt, { anio: '2026' });

    const enero = res.iva.meses[0]!;
    expect(enero.folio).toBe(1234);
    expect(enero.estado).toBe('Vigente');
    expect(enero.total).toBe(500000);
    expect(res.iva.totalDeclarado).toBe(500000); // the draft's 999999 never counted
  });

  it('aggregates the declared monthly totals and counts the months actually filed', async () => {
    const rt = makeRuntime({
      estados: {
        '202501': estadoEnv(11, 50000),
        '202502': estadoEnv(12, 30000),
        // the other ten months have nothing filed
      },
    });
    await seed(rt);

    const res = await rentaAnual(rt, { anio: '2026' });

    expect(res.iva.mesesConDeclaracion).toBe(2);
    expect(res.iva.totalDeclarado).toBe(80000);
    expect(res.iva.meses[0]).toMatchObject({
      periodo: '2025-01',
      tieneDeclaracion: true,
      folio: 11,
      total: 50000,
    });
    expect(res.iva.meses[5]).toMatchObject({ periodo: '2025-06', tieneDeclaracion: false });
  });

  it('opens exactly ONE session for all fourteen POSTs', async () => {
    const rt = makeRuntime();
    await seed(rt);

    await rentaAnual(rt, { anio: '2026' });

    expect(driver(rt).restoreCalls).toBe(1);
  });

  it('paces every POST after the first (14 POSTs → 13 gaps)', async () => {
    const rt = makeRuntime();
    await seed(rt);

    await rentaAnual(rt, { anio: '2026' });

    expect(clock(rt).slept).toHaveLength(13);
    expect(new Set(clock(rt).slept)).toEqual(new Set([1000]));
  });

  it('rejects a representing operate pointer BEFORE opening a session (ADR-005)', async () => {
    const rt = makeRuntime();
    await seed(rt);
    await setOperatingRut(rt.store, EMPRESA);

    await expect(rentaAnual(rt, { anio: '2026' })).rejects.toThrow(/session-keyed/i);
    expect(driver(rt).restoreCalls).toBe(0);
  });

  it('treats a year with no F22 declaración as data, and still returns the F29 months', async () => {
    const rt = makeRuntime({
      decls: { metaData: { errors: [] }, data: { decls: [], glosas: [] } },
      estados: { '202503': estadoEnv(13, 7000) },
    });
    await seed(rt);

    const res = await rentaAnual(rt, { anio: '2026' });

    expect(res.f22).toMatchObject({ tieneDeclaracion: false, folio: null, grupos: null });
    expect(res.iva.mesesConDeclaracion).toBe(1);
    expect(res.iva.totalDeclarado).toBe(7000);
  });

  it('skips the grid POST when there is no folio (13 POSTs → 12 gaps)', async () => {
    const rt = makeRuntime({
      decls: { metaData: { errors: [] }, data: { decls: [], glosas: [] } },
    });
    await seed(rt);

    await rentaAnual(rt, { anio: '2026' });

    expect(clock(rt).slept).toHaveLength(12);
  });

  it('writes one audit receipt with the año and month count — and no montos', async () => {
    const rt = makeRuntime({ estados: { '202501': estadoEnv(11, 50000) } });
    await seed(rt);

    await rentaAnual(rt, { anio: '2026' });

    const a = entries(rt).at(-1)!;
    expect(a).toMatchObject({ action: 'renta_anual', result: 'ok', rut: SELF, period: '2026' });
    expect(JSON.stringify(a)).not.toContain('50000');
  });

  it('validates the año locally before opening a session', async () => {
    const rt = makeRuntime();
    await seed(rt);

    await expect(rentaAnual(rt, { anio: 'no-es-anio' })).rejects.toThrow(ValidationError);
    expect(driver(rt).restoreCalls).toBe(0);
  });

  it('raises NotAuthenticated when there is no session, and audits the failure', async () => {
    const rt = makeRuntime();

    await expect(rentaAnual(rt, { anio: '2026' })).rejects.toThrow(NotAuthenticatedError);
    expect(entries(rt).at(-1)).toMatchObject({ action: 'renta_anual', result: 'failed' });
  });
});
