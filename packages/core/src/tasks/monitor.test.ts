import { describe, it, expect } from 'vitest';
import {
  FakePortalDriver,
  FixedClock,
  InMemoryKeyValueStore,
  RecordingAuditSink,
} from '../adapters/fake/index.js';
import type { JsonRequest, Runtime } from '../seams/index.js';
import { NotAuthenticatedError, RateLimitError, SessionExpiredError } from '../errors/index.js';
import { initOperateState, setOperatingRut } from '../identity/index.js';
import { writeSession } from '../auth/index.js';
import { monitorSweep } from './monitor.js';

// Synthetic data only (no SII, no real PII): persona 20.000.042-0, empresa 77.777.777-7.
const SELF = '20000042-0';
const EMPRESA = '77777777-7';

const decls = (folio: string | null) => ({
  metaData: { errors: [] },
  data: {
    decls: folio ? [{ folio, vgte: 'S', codConc: 'C1', fecIng: '20/04/2026' }] : [],
    glosas: [{ codConclusion: 'C1', descripcion: 'Declaración vigente' }],
  },
});

/** situacionObservacion payload. `descripcion` is FREE TEXT and must never reach the snapshot. */
const obs = (rows: { codigo: string; descripcion: string }[]) => ({
  metaData: { errors: [] },
  data: rows.map((r) => ({ codigo: r.codigo, descripcion: r.descripcion, url: null })),
});

/** buscaEventos payload. `nombre` is FREE TEXT and must never reach the snapshot. */
const eventos = (rows: { codEvento: string; fechaEvento: string; nombre: string }[]) => ({
  metaData: { errors: [] },
  data: rows,
});

const f29Mes = (tiene: boolean) => ({
  metaData: { errors: [] },
  data: tiene ? [{ estadoDeclaracionId: 1, estado: 'Vigente', folio: 9, monto: 1000 }] : [],
});

const NO_PETICIONES = '//OK[0,[],0,7]';

interface Script {
  folio?: string | null;
  /** Per-año override of `folio`, keyed by año tributario (e.g. `'2024'`). Takes precedence
   *  over `folio` when the requested año has an entry. */
  folioPorAnio?: Record<string, string | null>;
  obs?: { codigo: string; descripcion: string }[];
  eventos?: { codEvento: string; fechaEvento: string; nombre: string }[];
  /** `YYYYMM` → whether a declaración exists. Missing ⇒ exists. */
  f29?: Record<string, boolean>;
  /** Reloj fijo del barrido. Por defecto 2026-07-25 (el mismo de siempre). */
  now?: Date;
  /** Payload crudo de `opc=112` (perfil del contribuyente). `undefined` ⇒ cuerpo vacío, el mismo
   *  fallback silencioso que antes de P1/P2 (SituacionError capturado, ancla heurística). */
  perfil?: unknown;
}

function makeRuntime(s: Script = {}): Runtime {
  const requestJson = (url: string, options?: JsonRequest): unknown => {
    if (url.includes('buscaDeclVgte')) {
      const d = (options?.body as { data?: Record<string, unknown> } | undefined)?.data ?? {};
      const anio = String(d['periodo'] ?? '');
      const folio =
        s.folioPorAnio && anio in s.folioPorAnio
          ? s.folioPorAnio[anio]!
          : s.folio === undefined
            ? '900'
            : s.folio;
      return decls(folio);
    }
    if (url.includes('situacionObservacion')) return obs(s.obs ?? []);
    if (url.includes('buscaEventos')) return eventos(s.eventos ?? []);
    if (url.includes('getDeclaracionConEstados')) {
      const d = (options?.body as { data?: Record<string, unknown> } | undefined)?.data ?? {};
      const key = `${String(d['anno'] ?? '')}${String(d['mes'] ?? '')}`;
      return f29Mes(s.f29?.[key] ?? true);
    }
    throw new Error(`unexpected url: ${url}`);
  };
  // Solo responde `opc=112` (perfil, P1/P2); cualquier otro `opc` (ej. 118, Ley COT) cae en el
  // mismo cuerpo vacío que el default de `FakePortalSession` — SiiError capturado, sin romper el
  // resto de tests que nunca lo scriptaron.
  const requestForm = (_url: string, options?: { form?: Record<string, string> }): string => {
    const opc = options?.form?.['opc'] ?? '';
    if (opc === '112') return s.perfil === undefined ? '' : JSON.stringify(s.perfil);
    return '';
  };
  return {
    clock: new FixedClock(s.now ?? new Date('2026-07-25T12:00:00Z')),
    audit: new RecordingAuditSink(),
    store: new InMemoryKeyValueStore(),
    portal: new FakePortalDriver({
      restoreSession: {
        requestJson,
        requestForm,
        requestText: () => NO_PETICIONES,
        cookies: { TOKEN: 't' },
      },
    }),
  };
}

async function seed(runtime: Runtime, savedAt = '2026-07-25T12:00:00Z'): Promise<void> {
  await writeSession(runtime.store, { rut: SELF, cookies: ['c'], savedAt });
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
const snapshotOf = (rt: Runtime) => rt.store.read<Record<string, unknown>>('monitor');

const SECRET_GLOSA = 'GLOSA LIBRE CON NOMBRE DE FUNCIONARIO';

describe('monitorSweep (fakes, no SII)', () => {
  it('first run establishes a baseline and reports NO changes', async () => {
    const rt = makeRuntime({ obs: [{ codigo: 'F121', descripcion: SECRET_GLOSA }] });
    await seed(rt);

    const res = await monitorSweep(rt, { anios: 1, meses: 1 });

    expect(res.baseline).toBe(true);
    expect(res.cambios).toEqual([]); // pre-existing state is never "change"
    expect(res.resumen.observaciones).toBe(1); // but it IS counted
  });

  it('NEVER writes free text to the snapshot — only códigos, fingerprints and states', async () => {
    const rt = makeRuntime({
      obs: [{ codigo: 'F121', descripcion: SECRET_GLOSA }],
      eventos: [{ codEvento: '2', fechaEvento: '20/05/2019', nombre: SECRET_GLOSA }],
    });
    await seed(rt);

    await monitorSweep(rt, { anios: 1, meses: 1 });

    const dump = JSON.stringify(await snapshotOf(rt));
    expect(dump).not.toContain(SECRET_GLOSA); // the load-bearing privacy rule (ADR-024)
    expect(dump).toContain('F121'); // the código IS stored — it is the change key
  });

  it('detects a NEW observación on the second run, at alta severity', async () => {
    const rt = makeRuntime({ obs: [{ codigo: 'F121', descripcion: SECRET_GLOSA }] });
    await seed(rt);
    await monitorSweep(rt, { anios: 1, meses: 1 }); // baseline

    // SII raises a second observación.
    const rt2 = makeRuntime({
      obs: [
        { codigo: 'F121', descripcion: SECRET_GLOSA },
        { codigo: 'B92', descripcion: 'otra glosa' },
      ],
    });
    // carry the baseline over
    await seed(rt2);
    await rt2.store.write('monitor', await snapshotOf(rt));

    const res = await monitorSweep(rt2, { anios: 1, meses: 1 });

    expect(res.baseline).toBe(false);
    const nueva = res.cambios.filter((c) => c.tipo === 'observacion_nueva');
    expect(nueva).toHaveLength(1);
    expect(nueva[0]).toMatchObject({ severidad: 'alta' });
    expect(nueva[0]?.detalle).toContain('B92');
  });

  it('detects a NEW historial event — the signal that SII acted', async () => {
    const rt = makeRuntime({
      eventos: [{ codEvento: '48', fechaEvento: '08/05/2019', nombre: 'a' }],
    });
    await seed(rt);
    await monitorSweep(rt, { anios: 1, meses: 1 });

    const rt2 = makeRuntime({
      eventos: [
        { codEvento: '48', fechaEvento: '08/05/2019', nombre: 'a' },
        { codEvento: '2', fechaEvento: '20/05/2019', nombre: 'Declaración con inconsistencias.' },
      ],
    });
    await seed(rt2);
    await rt2.store.write('monitor', await snapshotOf(rt));

    const res = await monitorSweep(rt2, { anios: 1, meses: 1 });

    const nuevos = res.cambios.filter((c) => c.tipo === 'evento_nuevo');
    expect(nuevos).toHaveLength(1);
    expect(nuevos[0]?.severidad).toBe('alta');
  });

  it('reports a resolved observación as info, not as a problem', async () => {
    const rt = makeRuntime({ obs: [{ codigo: 'F121', descripcion: SECRET_GLOSA }] });
    await seed(rt);
    await monitorSweep(rt, { anios: 1, meses: 1 });

    const rt2 = makeRuntime({ obs: [] }); // SII cleared it
    await seed(rt2);
    await rt2.store.write('monitor', await snapshotOf(rt));

    const res = await monitorSweep(rt2, { anios: 1, meses: 1 });

    const resueltas = res.cambios.filter((c) => c.tipo === 'observacion_resuelta');
    expect(resueltas).toHaveLength(1);
    expect(resueltas[0]?.severidad).toBe('info');
  });

  it('flags a month with no F29 declaración, but never the still-open current month', async () => {
    // Clock is 2026-07-25, so 2026-07 is the CURRENT (open) period and must not be flagged.
    // Keys are `anno + zero-padded mes` (the shape `mesAnno` sends), i.e. 202607 / 202606.
    const rt = makeRuntime({ f29: { '202607': false, '202606': false } });
    await seed(rt);

    const res = await monitorSweep(rt, { anios: 1, meses: 2 });

    const faltantes = res.cambios.filter((c) => c.tipo === 'f29_mes_sin_declaracion');
    expect(faltantes.map((c) => c.ambito)).toEqual(['F29 2026-06']);
  });

  // LIVE-VALIDATION FINDING (2026-07-26): the sweep reported "sin hallazgos" for a taxpayer with
  // THREE entirely unfiled F22 años. It watched observaciones, events and missing F29 months, but
  // never the most consequential deficiency of all — a missing annual return.
  it('flags a PAST año tributario with no F22 declaración, as a state finding', async () => {
    // Clock is 2026-07-25 → AT 2025 and earlier are unambiguously late. `folio:null` here means
    // buscaDeclVgte returned no declaración for the year.
    const rt = makeRuntime({ folio: null });
    await seed(rt);

    const res = await monitorSweep(rt, { anios: 2, meses: 1 });

    const faltantes = res.cambios.filter((c) => c.tipo === 'f22_sin_declaracion');
    // AT 2026 is the CURRENT año tributario — deliberately not flagged (its deadline varies).
    expect(faltantes.map((c) => c.ambito)).toEqual(['F22 AT2025']);
    expect(faltantes[0]?.severidad).toBe('alta');
  });

  it('reports a missing F22 on the FIRST run too — it is state, not change', async () => {
    const rt = makeRuntime({ folio: null });
    await seed(rt);

    const res = await monitorSweep(rt, { anios: 2, meses: 1 });

    expect(res.baseline).toBe(true);
    expect(res.cambios.some((c) => c.tipo === 'f22_sin_declaracion')).toBe(true);
  });

  it('does not flag a year that HAS a declaración', async () => {
    const rt = makeRuntime(); // default folio '900' ⇒ filed
    await seed(rt);

    const res = await monitorSweep(rt, { anios: 3, meses: 1 });

    expect(res.cambios.filter((c) => c.tipo === 'f22_sin_declaracion')).toEqual([]);
  });

  // LIVE FINDING (2026-07-29, a real taxpayer account): AT2019 had no F22 while every later
  // año did — the taxpayer simply did not exist yet in the commercial year AT2019 covers. The
  // sweep does not have (and per ADR-004 must not invent) an observed "fecha de inicio de
  // actividades" field, so the only defensible anchor is the earliest año it DID find a
  // declaración for: a gap strictly BEFORE that is not evidence of an omission and must not be
  // reported at `alta` — it is still surfaced (never silently dropped), at `info`.
  it('downgrades a gap BEFORE the earliest filed año to info, not alta (pre-inception)', async () => {
    // Clock 2026-07-25 → AT2026 is current. anios:3 sweeps AT2024/2025/2026.
    const rt = makeRuntime({ folioPorAnio: { '2024': null, '2025': '900', '2026': '900' } });
    await seed(rt);

    const res = await monitorSweep(rt, { anios: 3, meses: 1 });

    const faltantes = res.cambios.filter((c) => c.tipo === 'f22_sin_declaracion');
    expect(faltantes).toHaveLength(1);
    expect(faltantes[0]).toMatchObject({ ambito: 'F22 AT2024', severidad: 'info' });
    // The resumen count of real deficiencies must not include the downgraded year.
    expect(res.resumen.aniosSinF22).toBe(0);
  });

  it('still flags a gap AFTER the earliest filed año as alta (a real skipped year)', async () => {
    const rt = makeRuntime({ folioPorAnio: { '2024': '900', '2025': null, '2026': '900' } });
    await seed(rt);

    const res = await monitorSweep(rt, { anios: 3, meses: 1 });

    const faltantes = res.cambios.filter((c) => c.tipo === 'f22_sin_declaracion');
    expect(faltantes).toHaveLength(1);
    expect(faltantes[0]).toMatchObject({ ambito: 'F22 AT2025', severidad: 'alta' });
    expect(res.resumen.aniosSinF22).toBe(1);
  });

  it('downgrades an F29 month BEFORE the earliest filed period to info (pre-inception)', async () => {
    // meses:3 from clock 2026-07-25 sweeps 2026-07 (current, excluded), 2026-06, 2026-05.
    const rt = makeRuntime({ f29: { '202605': false, '202606': true } });
    await seed(rt);

    const res = await monitorSweep(rt, { anios: 1, meses: 3 });

    const faltantes = res.cambios.filter((c) => c.tipo === 'f29_mes_sin_declaracion');
    expect(faltantes).toHaveLength(1);
    expect(faltantes[0]).toMatchObject({ ambito: 'F29 2026-05', severidad: 'info' });
    expect(res.resumen.mesesSinDeclaracion).toBe(0);
  });

  it('still flags an F29 month AFTER the earliest filed period as alta (a real skipped month)', async () => {
    const rt = makeRuntime({ f29: { '202605': true, '202606': false } });
    await seed(rt);

    const res = await monitorSweep(rt, { anios: 1, meses: 3 });

    const faltantes = res.cambios.filter((c) => c.tipo === 'f29_mes_sin_declaracion');
    expect(faltantes).toHaveLength(1);
    expect(faltantes[0]).toMatchObject({ ambito: 'F29 2026-06', severidad: 'alta' });
    expect(res.resumen.mesesSinDeclaracion).toBe(1);
  });

  // LIVE FINDING (2026-07-26): widening --anios produced twelve "Nuevo evento" alerts for years
  // that had simply never been swept. Absence of a baseline is not change — the same rule the
  // first-run case already follows, applied PER YEAR.
  it('does not report a year entering the window for the first time as "new"', async () => {
    const withData = {
      obs: [{ codigo: 'F121', descripcion: SECRET_GLOSA }],
      eventos: [{ codEvento: '48', fechaEvento: '08/05/2019', nombre: 'recibida' }],
    };
    // Baseline over ONE año only.
    const rt = makeRuntime(withData);
    await seed(rt);
    await monitorSweep(rt, { anios: 1, meses: 1 });

    // Now widen to three años. The two extra years were never swept before.
    const rt2 = makeRuntime(withData);
    await seed(rt2);
    await rt2.store.write('monitor', await snapshotOf(rt));

    const res = await monitorSweep(rt2, { anios: 3, meses: 1 });

    // No phantom "nuevo" findings for the newly-included years.
    expect(res.cambios.filter((c) => c.tipo === 'observacion_nueva')).toEqual([]);
    expect(res.cambios.filter((c) => c.tipo === 'evento_nuevo')).toEqual([]);
  });

  it('does NOT persist a snapshot under dryRun', async () => {
    const rt = makeRuntime({ obs: [{ codigo: 'F121', descripcion: SECRET_GLOSA }] });
    await seed(rt);

    await monitorSweep(rt, { anios: 1, meses: 1, dryRun: true });

    expect(await snapshotOf(rt)).toBeNull();
  });

  it('opens exactly ONE session for the whole sweep', async () => {
    const rt = makeRuntime();
    await seed(rt);

    await monitorSweep(rt, { anios: 2, meses: 3 });

    expect(driverOf(rt).restoreCalls).toBe(1);
  });

  it('rejects a representing operate pointer BEFORE opening a session (ADR-005)', async () => {
    const rt = makeRuntime();
    await seed(rt);
    await setOperatingRut(rt.store, EMPRESA);

    await expect(monitorSweep(rt, { anios: 1, meses: 1 })).rejects.toThrow(/session-keyed/i);
    expect(driverOf(rt).restoreCalls).toBe(0);
  });

  it('audits counts and the baseline flag — never a código or glosa', async () => {
    const rt = makeRuntime({ obs: [{ codigo: 'F121', descripcion: SECRET_GLOSA }] });
    await seed(rt);

    await monitorSweep(rt, { anios: 1, meses: 1 });

    const a = entries(rt).at(-1)!;
    expect(a).toMatchObject({ action: 'monitor_sweep', result: 'ok', rut: SELF, baseline: true });
    const dump = JSON.stringify(a);
    expect(dump).not.toContain('F121');
    expect(dump).not.toContain(SECRET_GLOSA);
  });

  it('raises NotAuthenticated with no session, and audits the failure', async () => {
    const rt = makeRuntime();

    await expect(monitorSweep(rt, { anios: 1, meses: 1 })).rejects.toThrow(NotAuthenticatedError);
    expect(entries(rt).at(-1)).toMatchObject({ action: 'monitor_sweep', result: 'failed' });
  });
});

// ── P1 (ADR-037 hallazgo abierto): el mes anterior no debe marcarse antes de vencer su plazo ────
// `autorizadoDeclararDia20` (`opc=112`, ADR-035) define si el plazo es el día 12 o el 20. Sin él
// (perfil no disponible) se mantiene el comportamiento previo — nunca se asume el plazo más
// permisivo (ADR-004).
describe('monitorSweep — P1: plazo del mes anterior', () => {
  it('NO marca en alta el mes anterior mientras su plazo (día 20, declarante electrónico) no vence', async () => {
    // Reloj 2026-08-04: mes actual 2026-08 (excluido); mes anterior 2026-07, plazo día 20 de agosto.
    const rt = makeRuntime({
      now: new Date('2026-08-04T12:00:00Z'),
      f29: { '202607': false },
      perfil: { contribuyente: { autorizadoDeclararDia20: 'S' } },
    });
    await seed(rt, '2026-08-04T12:00:00Z');

    const res = await monitorSweep(rt, { anios: 1, meses: 2 });

    const faltantes = res.cambios.filter((c) => c.tipo === 'f29_mes_sin_declaracion');
    expect(faltantes).toHaveLength(1);
    expect(faltantes[0]).toMatchObject({ ambito: 'F29 2026-07', severidad: 'info' });
    expect(res.resumen.mesesSinDeclaracion).toBe(0); // no cuenta como incumplimiento todavía
  });

  it('SÍ marca en alta el mes anterior una vez vencido su plazo (día 20)', async () => {
    const rt = makeRuntime({
      now: new Date('2026-08-25T12:00:00Z'), // ya pasó el 20
      f29: { '202607': false },
      // fechaInicioActividades lejana: ancla real (P2), evita que el mes ACTUAL (default "filed")
      // contamine la heurística de anclaje como "primer período con declaración".
      perfil: {
        contribuyente: { autorizadoDeclararDia20: 'S', fechaInicioActividades: '2000-01-01 00:00:00.0' },
      },
    });
    await seed(rt, '2026-08-25T12:00:00Z');

    const res = await monitorSweep(rt, { anios: 1, meses: 2 });

    const faltantes = res.cambios.filter((c) => c.tipo === 'f29_mes_sin_declaracion');
    expect(faltantes).toHaveLength(1);
    expect(faltantes[0]).toMatchObject({ ambito: 'F29 2026-07', severidad: 'alta' });
    expect(res.resumen.mesesSinDeclaracion).toBe(1);
  });

  it('usa el día 12 (no el 20) cuando el contribuyente NO está autorizado a declarar el día 20', async () => {
    const rt = makeRuntime({
      now: new Date('2026-08-15T12:00:00Z'), // pasó el 12, antes del 20
      f29: { '202607': false },
      perfil: {
        contribuyente: { autorizadoDeclararDia20: 'N', fechaInicioActividades: '2000-01-01 00:00:00.0' },
      },
    });
    await seed(rt, '2026-08-15T12:00:00Z');

    const res = await monitorSweep(rt, { anios: 1, meses: 2 });

    const faltantes = res.cambios.filter((c) => c.tipo === 'f29_mes_sin_declaracion');
    expect(faltantes[0]).toMatchObject({ ambito: 'F29 2026-07', severidad: 'alta' });
  });

  it('sin perfil disponible mantiene el comportamiento anterior (alta) — nunca asume el plazo', async () => {
    // Ya cubierto por el test histórico "flags a month with no F29 declaración…" (sin `perfil`),
    // pero se deja explícito aquí para P1: severidad `alta`, no `info`. `202606: true` ancla la
    // heurística de respaldo ANTES del mes en cuestión — sin eso, el mes ACTUAL (default "filed")
    // sería el único período con evidencia y contaminaría el ancla.
    const rt = makeRuntime({
      now: new Date('2026-08-04T12:00:00Z'),
      f29: { '202607': false, '202606': true },
      // sin `perfil`: cuerpo vacío, SituacionError capturado, autorizadoDeclararDia20 = null.
    });
    await seed(rt, '2026-08-04T12:00:00Z');

    const res = await monitorSweep(rt, { anios: 1, meses: 3 });

    const faltantes = res.cambios.filter((c) => c.tipo === 'f29_mes_sin_declaracion');
    expect(faltantes[0]).toMatchObject({ ambito: 'F29 2026-07', severidad: 'alta' });
  });
});

// ── P2 (ADR-035 §Consequences): fechaInicioActividades reemplaza la heurística de anclaje ───────
describe('monitorSweep — P2: anclaje por fechaInicioActividades', () => {
  it('ancla en el inicio de actividades real en vez de en el primer año/mes filed', async () => {
    // Ningún año/mes de la ventana tiene F22/F29 filed — la heurística antigua (ancla en la
    // evidencia más antigua) no tendría dónde anclar y marcaría TODO en alta. Con
    // fechaInicioActividades=2019-06-19: AT2019 (comercial 2018) es pre-inicio → info; AT2020
    // (comercial 2019) ya debe declarar → alta.
    const rt = makeRuntime({
      folioPorAnio: { '2019': null, '2020': null },
      perfil: { contribuyente: { fechaInicioActividades: '2019-06-19 00:00:00.0' } },
    });
    await seed(rt);

    // Clock 2026-07-25 → hay que abarcar hasta AT2019, ocho años atrás.
    const res = await monitorSweep(rt, { anios: 8, meses: 1 });

    const faltantes = res.cambios.filter((c) => c.tipo === 'f22_sin_declaracion');
    expect(faltantes.find((c) => c.ambito === 'F22 AT2019')).toMatchObject({ severidad: 'info' });
    expect(faltantes.find((c) => c.ambito === 'F22 AT2020')).toMatchObject({ severidad: 'alta' });
    expect(res.resumen.aniosSinF22).toBe(1); // solo AT2020 cuenta como incumplimiento real
  });

  it('el mensaje de un año pre-inicio anclado por fechaInicioActividades la menciona', async () => {
    const rt = makeRuntime({
      folioPorAnio: { '2019': null, '2020': null },
      perfil: { contribuyente: { fechaInicioActividades: '2019-06-19 00:00:00.0' } },
    });
    await seed(rt);

    const res = await monitorSweep(rt, { anios: 8, meses: 1 });

    const at2019 = res.cambios.find((c) => c.ambito === 'F22 AT2019');
    expect(at2019?.detalle).toContain('inicio de actividades');
  });
});

// ── Señales añadidas por el spike F (ADR-037) ────────────────────────────────────────────────
// El runtime de arriba deja que las cuatro señales nuevas degraden a `errores` (el fake no las
// contesta). Aquí se escriptan de verdad para verificar hallazgos, snapshot y postura de PII.

const DJ_OK = { data: [{ id: 1, dj: 1926, titulo: 'Balance', estados: { '2026': 'Aceptada' } }] };
const DJ_OBSERVADA = {
  data: [{ id: 1, dj: 1887, titulo: 'Sueldos', estados: { '2026': 'Observada' } }],
};
const COT_CUMPLE = {
  estado: 'Cumple sus obligaciones tributarias',
  atributos: [{ atrCodigo: 'NDIR', cumple: 'SI', titulo: 'Sin atrasos', descripcion: 'x' }],
};
const COT_INCUMPLE = {
  estado: 'No cumple',
  atributos: [{ atrCodigo: 'DQDT', cumple: 'NO', titulo: 'Denuncias', descripcion: 'x' }],
};
const NOTIF_VACIO = { estado: 1403, glosa: 'No existen registros', data: [], metaData: null };
const NOTIF_UNA = {
  estado: 0,
  glosa: 'OK',
  data: [
    {
      id: '5150',
      descripcion: 'CITACION ART 63 TEXTO LIBRE SECRETO',
      fecha: 1770000000000,
      tipo: '9',
      descTipo: 'CITACION',
      tipoNotificacion: 'Por Página Web',
    },
  ],
  metaData: null,
};

const GIROS_HEADERS = [
  'Período',
  'Folio Giro',
  'Formulario Giro',
  'Formulario Asociado',
  'Fecha de Emisión',
  'Fecha de Vencimiento',
  'Estado',
  'Moneda',
  'Saldo',
  'Ver',
  'Pagar en linea',
  'Imprimir Giro',
];
const girosPayload = (filas: string[][]): string =>
  JSON.stringify({
    tabla: true,
    conteo: String(filas.length),
    rows: [['Consulta Giros'], GIROS_HEADERS, ...filas],
  });
const giroFila = (folio: string, saldo: string): string[] => [
  'Abril 2026',
  folio,
  '21',
  '29',
  '25/06/2026',
  '20/05/2026',
  'Vigente',
  'CLP',
  saldo,
  '',
  '',
  '',
];

/** Perfil por defecto para este bloque: inicio de actividades lejano en el pasado, para que
 *  P1/P2 nunca interfieran con los tests de las otras señales (spike F). */
const PERFIL_OK = {
  contribuyente: {
    fechaInicioActividades: '2000-01-01 00:00:00.0',
    autorizadoDeclararDia20: 'S',
  },
};

interface ScriptF {
  dj?: unknown;
  cot?: unknown;
  notif?: unknown;
  giros?: string[][];
  perfil?: unknown;
}

function makeRuntimeF(s: ScriptF = {}): Runtime {
  const requestJson = (url: string): unknown => {
    if (url.includes('buscaDeclVgte')) return decls('900');
    if (url.includes('situacionObservacion')) return obs([]);
    if (url.includes('buscaEventos')) return eventos([]);
    if (url.includes('getDeclaracionConEstados')) return f29Mes(true);
    if (url.includes('getDjIntegralAnual')) {
      // A function script lets a test make the DJ signal FAIL (e.g. die with the session).
      if (typeof s.dj === 'function') return (s.dj as () => unknown)();
      return s.dj ?? DJ_OK;
    }
    throw new Error(`unexpected url: ${url}`);
  };
  const requestForm = (_url: string, options?: { form?: Record<string, string> }): string => {
    const opc = options?.form?.['opc'] ?? '';
    if (opc === '41') return JSON.stringify(s.notif ?? NOTIF_VACIO);
    if (opc === '118') return typeof s.cot === 'string' ? s.cot : JSON.stringify(s.cot ?? COT_CUMPLE);
    if (opc === '112') return JSON.stringify(s.perfil ?? PERFIL_OK);
    throw new Error(`unexpected opc: ${opc}`);
  };
  const evaluate = (expr: string): unknown => {
    if (/CONSULTAR_GIROS/.test(expr)) return 'ok';
    if (/LEER_GIROS/.test(expr)) return girosPayload(s.giros ?? []);
    return null;
  };
  return {
    clock: new FixedClock(new Date('2026-07-25T12:00:00Z')),
    audit: new RecordingAuditSink(),
    store: new InMemoryKeyValueStore(),
    portal: new FakePortalDriver({
      restoreSession: {
        requestJson,
        requestForm,
        evaluate,
        requestText: () => NO_PETICIONES,
        cookies: { TOKEN: 't' },
      },
    }),
  };
}

async function seedF(rt: Runtime): Promise<void> {
  await writeSession(rt.store, { rut: SELF, cookies: ['c'], savedAt: '2026-07-25T12:00:00Z' });
  await initOperateState(rt.store, {
    selfRut: SELF,
    accountType: 'persona',
    operable: [{ rut: SELF, razonSocial: 'Juan Pérez', isSelf: true }],
  });
}

describe('monitorSweep — señales del spike F (ADR-037)', () => {
  it('lee las cuatro señales nuevas sin errores', async () => {
    const rt = makeRuntimeF();
    await seed(rt);

    const res = await monitorSweep(rt, { anios: 1, meses: 1 });

    expect(res.errores).toEqual([]);
  });

  it('marca una DJ observada como hallazgo de estado en `alta`, aun en el primer barrido', async () => {
    const rt = makeRuntimeF({ dj: DJ_OBSERVADA });
    await seed(rt);

    const res = await monitorSweep(rt, { anios: 1, meses: 1 });

    expect(res.baseline).toBe(true); // primera corrida…
    const dj = res.cambios.filter((c) => c.tipo === 'dj_observada');
    expect(dj).toHaveLength(1); // …y aun así lo reporta: es estado vigente, no novedad
    expect(dj[0]).toMatchObject({ severidad: 'alta', ambito: 'DJ 1887 AT2026' });
    expect(res.resumen.djObservadas).toBe(1);
  });

  it('una DJ aceptada no genera hallazgo', async () => {
    const rt = makeRuntimeF({ dj: DJ_OK });
    await seed(rt);

    const res = await monitorSweep(rt, { anios: 1, meses: 1 });

    expect(res.cambios.filter((c) => c.tipo === 'dj_observada')).toEqual([]);
    expect(res.resumen.djObservadas).toBe(0);
  });

  it('marca un requisito de la Ley COT incumplido', async () => {
    const rt = makeRuntimeF({ cot: COT_INCUMPLE });
    await seed(rt);

    const res = await monitorSweep(rt, { anios: 1, meses: 1 });

    const cot = res.cambios.filter((c) => c.tipo === 'cot_incumplimiento');
    expect(cot).toHaveLength(1);
    expect(cot[0]).toMatchObject({ severidad: 'alta', ambito: 'Ley COT DQDT' });
    expect(res.resumen.cotIncumplidos).toBe(1);
  });

  it('marca una notificación formal vigente y NO persiste su texto libre (ADR-024)', async () => {
    const rt = makeRuntimeF({ notif: NOTIF_UNA });
    await seed(rt);

    const res = await monitorSweep(rt, { anios: 1, meses: 1 });

    const n = res.cambios.filter((c) => c.tipo === 'notificacion_vigente');
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({ severidad: 'alta', ambito: 'Notificación 5150' });
    expect(res.resumen.notificacionesVigentes).toBe(1);

    // El snapshot guarda id → tipo, NUNCA la descripción.
    const snap = JSON.stringify(await snapshotOf(rt));
    expect(snap).toContain('5150');
    expect(snap).not.toContain('TEXTO LIBRE SECRETO');
  });

  it('marca un giro CON SALDO — y NO uno con saldo 0 aunque esté "Vigente" (ADR-034)', async () => {
    const rt = makeRuntimeF({ giros: [giroFila('111', '$0'), giroFila('222', '$450.000')] });
    await seed(rt);

    const res = await monitorSweep(rt, { anios: 1, meses: 1 });

    const g = res.cambios.filter((c) => c.tipo === 'giro_con_saldo');
    expect(g).toHaveLength(1); // solo el de $450.000
    expect(g[0]?.ambito).toBe('Giro 222');
    expect(res.resumen.girosConSaldo).toBe(1);
  });

  it('el snapshot NO guarda el monto del giro (ADR-024: identificadores y estados)', async () => {
    const rt = makeRuntimeF({ giros: [giroFila('222', '$450.000')] });
    await seed(rt);

    await monitorSweep(rt, { anios: 1, meses: 1 });

    const snap = JSON.stringify(await snapshotOf(rt));
    expect(snap).toContain('222'); // el folio sí
    expect(snap).not.toContain('450000'); // el monto no
    expect(snap).not.toContain('450.000');
  });

  it('detecta un giro NUEVO contra el baseline, sin marcar los preexistentes', async () => {
    const rt = makeRuntimeF({ giros: [giroFila('111', '$0')] });
    await seed(rt);
    await monitorSweep(rt, { anios: 1, meses: 1 }); // baseline con el giro 111
    const baseline = await snapshotOf(rt);

    const rt2 = makeRuntimeF({ giros: [giroFila('111', '$0'), giroFila('222', '$0')] });
    await seedF(rt2);
    await rt2.store.write('monitor', baseline);

    const res = await monitorSweep(rt2, { anios: 1, meses: 1 });

    const nuevos = res.cambios.filter((c) => c.tipo === 'giro_nuevo');
    expect(nuevos).toHaveLength(1);
    expect(nuevos[0]?.ambito).toBe('Giro 222');
  });

  it('el PRIMER giro de la vida SÍ se reporta como nuevo aunque nazca con saldo $0 (baseline con mapa de giros vacío)', async () => {
    // Un mapa de giros VACÍO es un barrido real con cero giros — distinto de un snapshot legado
    // sin la clave. Antes se colapsaban ambos y un primer giro ya pagado era 100% silencioso.
    const rt = makeRuntimeF({ giros: [] });
    await seedF(rt);
    await monitorSweep(rt, { anios: 1, meses: 1 }); // baseline: mapa presente y vacío
    const baseline = await snapshotOf(rt);

    const rt2 = makeRuntimeF({ giros: [giroFila('333', '$0')] });
    await seedF(rt2);
    await rt2.store.write('monitor', baseline);

    const res = await monitorSweep(rt2, { anios: 1, meses: 1 });

    const nuevos = res.cambios.filter((c) => c.tipo === 'giro_nuevo');
    expect(nuevos).toHaveLength(1);
    expect(nuevos[0]?.ambito).toBe('Giro 333');
  });

  it('una sesión muerta a MITAD de barrido aborta el sweep y NO pisa el baseline (error de sesión ≠ fallo de señal)', async () => {
    const rt = makeRuntimeF({ giros: [giroFila('111', '$0')] });
    await seedF(rt);
    await monitorSweep(rt, { anios: 1, meses: 1 }); // baseline bueno
    const baseline = await snapshotOf(rt);

    // Las cookies mueren entre las señales F29 y DJ: la señal DJ levanta SessionExpiredError.
    const rt2 = makeRuntimeF({
      dj: () => {
        throw new SessionExpiredError('La sesión expiró. Ejecuta `sii auth login`.');
      },
    });
    await seedF(rt2);
    await rt2.store.write('monitor', baseline);

    await expect(monitorSweep(rt2, { anios: 1, meses: 1 })).rejects.toBeInstanceOf(
      SessionExpiredError,
    );
    // El baseline bueno sobrevive intacto — un snapshot mutilado habría tragado los diffs futuros.
    expect(await snapshotOf(rt2)).toEqual(baseline);
  });

  it('un bloqueo del SII (RateLimitError) a mitad de barrido aborta — nunca sigue disparando señales', async () => {
    const rt = makeRuntimeF({
      dj: () => {
        throw new RateLimitError('SII bloqueó temporalmente las consultas (HTTP 429). NO reintentes.');
      },
    });
    await seedF(rt);

    await expect(monitorSweep(rt, { anios: 1, meses: 1 })).rejects.toBeInstanceOf(RateLimitError);
    expect(await snapshotOf(rt)).toBeNull(); // nada persistido de un barrido abortado
  });

  it('un snapshot ANTERIOR al spike F no hace parecer nuevo todo el estado preexistente', async () => {
    const rt = makeRuntimeF({ dj: DJ_OK, giros: [giroFila('111', '$0')] });
    await seed(rt);
    // Snapshot legado: sin los mapas dj/giros/notificaciones/cot.
    await rt.store.write('monitor', {
      takenAt: '2026-07-01T00:00:00Z',
      observaciones: {},
      eventos: {},
      f22: {},
      f29: {},
      peticiones: {},
    });

    const res = await monitorSweep(rt, { anios: 1, meses: 1 });

    expect(res.cambios.filter((c) => c.tipo === 'giro_nuevo')).toEqual([]);
    expect(res.cambios.filter((c) => c.tipo === 'dj_cambio_estado')).toEqual([]);
  });

  it('un fallo de UNA señal no aborta el barrido (regla de fan-out, ADR-004)', async () => {
    const rt = makeRuntimeF({ cot: 'no-es-json' });
    await seed(rt);

    const res = await monitorSweep(rt, { anios: 1, meses: 1 });

    expect(res.errores.map((e) => e.ambito)).toContain('Ley COT');
    expect(res.resumen.anios).toBe(1); // el resto del barrido completó
  });
});
