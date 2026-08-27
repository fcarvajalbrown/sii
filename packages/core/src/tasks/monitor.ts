// `monitor` — the compliance sweep (ADR-024). The first surface that is STATEFUL across runs:
// it reads the compliance-relevant signals, compares them against a stored baseline, and
// reports what CHANGED.
//
// WHY THIS EXISTS: every other module answers "what does SII say right now?" and forgets.
// Observación F121 on AT2019 was raised 20-05-2019 and went unnoticed for seven years — the data
// was reachable by `sii f22 observaciones 2019` that whole time. Nothing was watching.
//
// THE PRIVACY RULE IS LOAD-BEARING: the snapshot on disk stores ONLY identifiers and states —
// observación códigos, event fingerprints (`codigo|fecha|folio`), month booleans, petition
// numbers + estado. NEVER free text. SII's glosas and petition notes embed functionary names and
// taxpayer detail, and `~/.sii/` has no enforced permissions on Windows. Fingerprints detect
// change just as exactly. The RETURNED report may carry the glosa (same exposure as running the
// underlying command, and it is what makes the alert actionable) — output and storage are
// deliberately asymmetric.
import { withSession } from '../auth/index.js';
import { recordAudit } from '../audit/index.js';
import { DEFAULT_SETTINGS } from '../config/index.js';
import { NotAuthenticatedError, RateLimitError, SiiError } from '../errors/index.js';
import { F22Error, F29Error, PeticionesError } from '../errors/index.js';
import { readOperateState } from '../identity/index.js';
import { Anio, Periodo } from '../periodo/index.js';
import { Rut } from '../rut/index.js';
import {
  fetchF22Declaraciones,
  fetchF22Historial,
  fetchF22Observaciones,
  pickVigenteFolio,
} from '../portal/f22/index.js';
import { fetchF29Estado } from '../portal/f29.js';
import { fetchPeticiones } from '../portal/peticiones.js';
import { fetchDjEstadoAnual } from '../portal/dj.js';
import { fetchGirosAnual } from '../portal/giros.js';
import { fetchComunicacionesList } from '../portal/notificaciones.js';
import { fetchCumplimientoCot, fetchPerfilContribuyente } from '../portal/situacion.js';
import type { AuditEntry, KeyValueStore, PortalSession, Runtime } from '../seams/index.js';

/** Distinct KeyValueStore key (ADR-007) — never shares a file with `session` or `operate`. */
const MONITOR_KEY = 'monitor';

const DEFAULT_ANIOS = 3;
const DEFAULT_MESES = 12;

const pacingMs = (): number => Math.round(1000 / DEFAULT_SETTINGS.rateLimitRps);

function audit(runtime: Runtime, action: string, result: string, extra: Partial<AuditEntry>): void {
  recordAudit(runtime, { action, result, ...extra });
}

/** The persisted baseline. IDENTIFIERS AND STATES ONLY — no glosa, no descripción, no mensaje
 *  (ADR-024). Everything here is safe-ish if the file leaks: códigos, dates, booleans, numbers. */
export interface MonitorSnapshot {
  readonly takenAt: string;
  /** año tributario → observación códigos present (e.g. `{"2019": ["F121"]}`). */
  readonly observaciones: Record<string, readonly string[]>;
  /** año tributario → event fingerprints `codigo|fecha|folio`. */
  readonly eventos: Record<string, readonly string[]>;
  /** año tributario → whether an F22 declaración existed. A boolean, like the F29 map. */
  readonly f22: Record<string, boolean>;
  /** `YYYY-MM` → whether a declaración existed. */
  readonly f29: Record<string, boolean>;
  /** petition número → estado actual (already functionary-stripped by the facade). */
  readonly peticiones: Record<string, string>;
  /** `<añoTributario>|<nºDJ>` → estado verbatim (ADR-030). Estados are labels, not free text. */
  readonly dj: Record<string, string>;
  /** folio de giro → estado verbatim (ADR-034). El monto NO se persiste. */
  readonly giros: Record<string, string>;
  /** id de notificación formal → su código `tipo` (ADR-032). NUNCA la descripción. */
  readonly notificaciones: Record<string, string>;
  /** `atrCodigo` de la Ley COT → `cumpleTexto` (`"SI"`/`"NO"`, ADR-035). */
  readonly cot: Record<string, string>;
}

export type MonitorTipo =
  | 'observacion_nueva'
  | 'observacion_resuelta'
  | 'evento_nuevo'
  | 'f22_sin_declaracion'
  | 'f29_mes_sin_declaracion'
  | 'peticion_cambio_estado'
  | 'dj_observada'
  | 'dj_cambio_estado'
  | 'giro_con_saldo'
  | 'giro_nuevo'
  | 'notificacion_vigente'
  | 'cot_incumplimiento';

export type MonitorSeveridad = 'alta' | 'media' | 'info';

export interface MonitorCambio {
  readonly tipo: MonitorTipo;
  readonly severidad: MonitorSeveridad;
  /** Where it happened, e.g. `F22 AT2019` / `F29 2026-06` / `Petición 12345`. */
  readonly ambito: string;
  /** Short human line. MAY carry SII's glosa — this is output, not storage (ADR-024). */
  readonly detalle: string;
}

export interface MonitorResumen {
  readonly anios: number;
  readonly meses: number;
  readonly observaciones: number;
  readonly eventos: number;
  readonly mesesSinDeclaracion: number;
  /** Past años tributarios with no F22 filed. */
  readonly aniosSinF22: number;
  readonly peticiones: number;
  /** DJ cuyo estado indica observación (ADR-030). */
  readonly djObservadas: number;
  /** Giros con saldo > 0 en el año en curso (ADR-034). */
  readonly girosConSaldo: number;
  /** Notificaciones FORMALES vigentes (citaciones, liquidaciones… ADR-032). */
  readonly notificacionesVigentes: number;
  /** Requisitos de la Ley COT marcados como NO cumplidos (ADR-035). */
  readonly cotIncumplidos: number;
}

export interface MonitorResult {
  readonly rut: string;
  /** True when there was no prior snapshot: a baseline was established, `cambios` is empty. */
  readonly baseline: boolean;
  readonly cambios: readonly MonitorCambio[];
  readonly resumen: MonitorResumen;
  /** Per-signal SII errors, verbatim; the sweep continued past them (ADR-004). */
  readonly errores: readonly { readonly ambito: string; readonly mensaje: string }[];
  /** True when `dryRun` kept the baseline unchanged. */
  readonly dryRun: boolean;
}

export async function readMonitorSnapshot(store: KeyValueStore): Promise<MonitorSnapshot | null> {
  return store.read<MonitorSnapshot>(MONITOR_KEY);
}

/** Reject a representing operate pointer BEFORE opening a session (ADR-005 / ADR-024). Every
 *  signal here is session-keyed, so a representing pointer can only mislead. */
async function assertSelfOperating(runtime: Runtime): Promise<void> {
  const op = await readOperateState(runtime.store);
  if (op && op.operatingRut !== op.selfRut) {
    throw new F22Error(
      `El monitor de cumplimiento es session-keyed: el SII autoriza F22, F29 y peticiones por el ` +
        `titular de la sesión, no por el RUT operado (${Rut.parse(op.operatingRut).formatted}). ` +
        'Para monitorear esa empresa, inicia sesión como ella (`sii auth logout` y luego `sii auth login`).',
    );
  }
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** A stable identity for one historial event. Deliberately excludes `glosa` — the free text we
 *  refuse to persist — while still distinguishing every real event (ADR-024). */
const eventoFingerprint = (e: {
  codigo: string;
  fecha: string | null;
  folio: string | null;
}): string => `${e.codigo}|${e.fecha ?? ''}|${e.folio ?? ''}`;

/** Parses SII's `fechaInicioActividades` (`"YYYY-MM-DD HH:MM:SS.s"`, ADR-035) into the two
 *  anchors `estadoFindings` needs. Returns `null` on anything that doesn't match this exact
 *  observed shape — never guesses at an unobserved format (ADR-004). */
function parseInicioActividades(v: string | null): { anioComercial: number; periodo: string } | null {
  if (v === null) return null;
  const m = /^(\d{4})-(\d{2})-\d{2}/.exec(v);
  if (!m) return null;
  return { anioComercial: Number(m[1]), periodo: `${m[1]}-${m[2]}` };
}

/** Read every watched signal in ONE session. A per-signal SII error is captured and the sweep
 *  continues; a session-level failure propagates. */
async function sweep(
  session: PortalSession,
  rut: Rut,
  anios: readonly Anio[],
  meses: readonly Periodo[],
  pace: () => Promise<void>,
): Promise<{
  snapshot: MonitorSnapshot;
  /** año → código → SII's glosa, for the OUTPUT only (never persisted). */
  glosas: Record<string, Record<string, string>>;
  errores: { ambito: string; mensaje: string }[];
  /** Giros con saldo > 0 — para la SALIDA. El monto nunca entra al snapshot (ADR-024). */
  girosConSaldo: { folio: string; saldo: number; vence: string | null }[];
  /** Del perfil del contribuyente (`opc=112`, ADR-035) — usados para juzgar severidad en
   *  `estadoFindings` (P1/P2), NUNCA persistidos en el snapshot (no son estados a diffear). */
  autorizadoDeclararDia20: boolean | null;
  fechaInicioActividades: string | null;
  takenAtIso: string;
}> {
  const observaciones: Record<string, string[]> = {};
  const eventos: Record<string, string[]> = {};
  const f22: Record<string, boolean> = {};
  const f29: Record<string, boolean> = {};
  const peticiones: Record<string, string> = {};
  const dj: Record<string, string> = {};
  const giros: Record<string, string> = {};
  const notificaciones: Record<string, string> = {};
  const cot: Record<string, string> = {};
  const glosas: Record<string, Record<string, string>> = {};
  const errores: { ambito: string; mensaje: string }[] = [];
  /** Montos y leyendas que la SALIDA puede llevar pero el snapshot NUNCA (ADR-024). */
  const girosConSaldo: { folio: string; saldo: number; vence: string | null }[] = [];

  for (const anio of anios) {
    const ambito = `F22 AT${anio.canonical}`;
    try {
      const decls = await fetchF22Declaraciones(session, { rut, anio });
      const folio = pickVigenteFolio(decls.declaraciones);
      f22[anio.canonical] = folio !== null;
      observaciones[anio.canonical] = [];
      eventos[anio.canonical] = [];
      glosas[anio.canonical] = {};
      if (folio === null) continue;

      await pace();
      const obs = await fetchF22Observaciones(session, { rut, anio, folio });
      observaciones[anio.canonical] = obs.map((o) => o.codigo);
      for (const o of obs) glosas[anio.canonical]![o.codigo] = o.descripcion ?? '';

      await pace();
      const evs = await fetchF22Historial(session, { rut, anio, folio });
      eventos[anio.canonical] = evs.map(eventoFingerprint);
      for (const e of evs) {
        glosas[anio.canonical]![eventoFingerprint(e)] = e.glosa ?? '';
      }
    } catch (e) {
      if (e instanceof F22Error) {
        errores.push({ ambito, mensaje: messageOf(e) });
        continue;
      }
      throw e;
    }
    await pace();
  }

  for (const periodo of meses) {
    try {
      const est = await fetchF29Estado(session, { rut, periodo });
      f29[periodo.formatted] = est.tieneDeclaracion;
    } catch (e) {
      if (e instanceof F29Error) {
        errores.push({ ambito: `F29 ${periodo.formatted}`, mensaje: messageOf(e) });
      } else {
        throw e;
      }
    }
    await pace();
  }

  try {
    const pet = await fetchPeticiones(session, { rut });
    for (const p of pet.peticiones) peticiones[String(p.numero)] = p.estadoActual;
  } catch (e) {
    if (e instanceof PeticionesError) {
      errores.push({ ambito: 'Peticiones', mensaje: messageOf(e) });
    } else {
      throw e;
    }
  }

  // --- Señales añadidas por el spike F (ADR-037) --------------------------------------------
  // Cada una es una superficie ya construida y validada en vivo; aquí solo se vigilan. Un fallo
  // de UNA señal se captura y el barrido sigue — la regla de fan-out de ADR-004 aplicada a un
  // sweep de señales heterogéneas.

  await pace();
  try {
    // Una sola llamada cubre una ventana de 3 años tributarios (ADR-030), suficiente para el
    // horizonte que vigila el monitor sin encarecer el barrido.
    const res = await fetchDjEstadoAnual(session, { rut, periodo: anios[0]! }, pace);
    for (const row of res.rows) {
      for (const [anio, estado] of Object.entries(row.estados)) {
        dj[`${anio}|${row.dj ?? row.id ?? '?'}`] = estado;
      }
    }
  } catch (e) {
    // Una sesión muerta o un bloqueo del SII NO es "el fallo de una señal": aborta el barrido
    // entero (CONVENTIONS: nunca continuar tras un bloqueo; un error de sesión aborta el fan-out).
    // Sin esto, el snapshot se persistiría con mapas vacíos, pisando el baseline bueno.
    if (e instanceof NotAuthenticatedError || e instanceof RateLimitError) throw e;
    if (e instanceof SiiError) errores.push({ ambito: 'DJ', mensaje: messageOf(e) });
    else throw e;
  }

  await pace();
  try {
    const res = await fetchComunicacionesList(session, { rut, categoria: 'FORMAL' });
    // Solo id → tipo. La `descripcion` es texto libre y NO se persiste (ADR-024).
    for (const n of res.items) if (n.id !== null) notificaciones[String(n.id)] = n.tipo ?? '';
  } catch (e) {
    if (e instanceof NotAuthenticatedError || e instanceof RateLimitError) throw e;
    if (e instanceof SiiError) errores.push({ ambito: 'Notificaciones', mensaje: messageOf(e) });
    else throw e;
  }

  await pace();
  try {
    const res = await fetchGirosAnual(session, { rut, anio: anios[0]! }, pace);
    for (const g of res.giros) {
      if (g.folio === null) continue;
      giros[g.folio] = g.estado ?? '';
      if (g.saldo !== null && g.saldo > 0) {
        girosConSaldo.push({ folio: g.folio, saldo: g.saldo, vence: g.fechaVencimiento });
      }
    }
  } catch (e) {
    if (e instanceof NotAuthenticatedError || e instanceof RateLimitError) throw e;
    if (e instanceof SiiError) errores.push({ ambito: 'Giros', mensaje: messageOf(e) });
    else throw e;
  }

  await pace();
  try {
    const res = await fetchCumplimientoCot(session);
    for (const q of res.requisitos) {
      if (q.codigo !== null) cot[q.codigo] = q.cumpleTexto ?? '';
    }
  } catch (e) {
    if (e instanceof NotAuthenticatedError || e instanceof RateLimitError) throw e;
    if (e instanceof SiiError) errores.push({ ambito: 'Ley COT', mensaje: messageOf(e) });
    else throw e;
  }

  // El perfil del contribuyente (P1/P2): `autorizadoDeclararDia20` fija el plazo del F29 del mes
  // anterior (día 12 o 20); `fechaInicioActividades` reemplaza la heurística de anclaje de
  // severidad. Ninguno de los dos se persiste — son insumos de juicio, no estado a diffear.
  await pace();
  let autorizadoDeclararDia20: boolean | null = null;
  let fechaInicioActividades: string | null = null;
  try {
    const perfil = await fetchPerfilContribuyente(session);
    autorizadoDeclararDia20 = perfil.autorizadoDeclararDia20;
    fechaInicioActividades = perfil.fechaInicioActividades;
  } catch (e) {
    if (e instanceof NotAuthenticatedError || e instanceof RateLimitError) throw e;
    if (e instanceof SiiError) errores.push({ ambito: 'Perfil contribuyente', mensaje: messageOf(e) });
    else throw e;
  }

  const takenAtIso = new Date().toISOString(); // replaced by the caller's clock below
  return {
    snapshot: {
      takenAt: takenAtIso,
      observaciones,
      eventos,
      f22,
      f29,
      peticiones,
      dj,
      giros,
      notificaciones,
      cot,
    },
    glosas,
    errores,
    girosConSaldo,
    autorizadoDeclararDia20,
    fechaInicioActividades,
    takenAtIso,
  };
}

/** STATE findings — true right now, independent of any baseline, so they are reported even on
 *  the FIRST run. A month with no F29 is a standing deficiency, not news that something changed;
 *  staying silent about it on run one would repeat the exact failure this feature exists to
 *  prevent (ADR-024). Contrast `diffCambios`, which needs a baseline to mean anything. */
function estadoFindings(
  next: MonitorSnapshot,
  currentPeriodo: string,
  currentYear: number,
  girosConSaldo: readonly { folio: string; saldo: number; vence: string | null }[] = [],
  ctx: {
    /** El período inmediatamente anterior a `currentPeriodo` (P1, ADR-037). */
    mesAnteriorPeriodo?: string | null;
    /** `contribuyente.autorizadoDeclararDia20` (ADR-035): `true` ⇒ plazo día 20, `false` ⇒ día 12,
     *  `null` ⇒ no disponible este barrido (perfil falló o no observado) — nunca se asume. */
    autorizadoDeclararDia20?: boolean | null;
    /** Día del mes de `now` (reloj inyectado), para comparar contra el plazo. */
    diaHoy?: number | null;
    /** `contribuyente.fechaInicioActividades` (ADR-035, P2). Reemplaza la heurística de anclaje
     *  cuando está disponible. */
    fechaInicioActividades?: string | null;
  } = {},
): MonitorCambio[] {
  const cambios: MonitorCambio[] = [];

  // --- Señales del spike F (ADR-037): estado actual, independiente de cualquier baseline ------

  // Una DJ observada es una deficiencia vigente, no una novedad: se reporta siempre. El estado
  // pasa verbatim (ADR-030 no cierra el enum), así que se detecta por contenido, no por igualdad.
  for (const [clave, estado] of Object.entries(next.dj)) {
    if (!/observ/i.test(estado)) continue;
    const [anio, num] = clave.split('|');
    cambios.push({
      tipo: 'dj_observada',
      severidad: 'alta',
      ambito: `DJ ${num ?? '?'} AT${anio ?? '?'}`,
      detalle: `Declaración jurada ${num ?? '?'} del año tributario ${anio ?? '?'}: ${estado}.`,
    });
  }

  // Un requisito de la Ley COT incumplido bloquea beneficios y es estado vigente.
  for (const [codigo, cumple] of Object.entries(next.cot)) {
    if (cumple.toUpperCase() !== 'NO') continue;
    cambios.push({
      tipo: 'cot_incumplimiento',
      severidad: 'alta',
      ambito: `Ley COT ${codigo}`,
      detalle: `Requisito ${codigo} de la Ley COT figura como NO cumplido.`,
    });
  }

  // Una notificación FORMAL vigente (citación, liquidación, resolución) es exactamente la señal
  // que motivó ADR-032: se reporta esté o no en el baseline.
  for (const [id, tipo] of Object.entries(next.notificaciones)) {
    cambios.push({
      tipo: 'notificacion_vigente',
      severidad: 'alta',
      ambito: `Notificación ${id}`,
      detalle: `Notificación formal vigente (id ${id}, tipo ${tipo || '—'}). Revísala con \`sii notificaciones detalle ${id} ${tipo || '<tipo>'}\`.`,
    });
  }

  // Un giro con saldo es deuda vigente. OJO: el estado "Vigente" NO significa impago (ADR-034),
  // por eso el criterio es el SALDO, nunca el estado.
  for (const g of girosConSaldo) {
    cambios.push({
      tipo: 'giro_con_saldo',
      severidad: 'alta',
      ambito: `Giro ${g.folio}`,
      detalle: `Giro ${g.folio} con saldo ${g.saldo}${g.vence ? `, vence ${g.vence}` : ''}.`,
    });
  }

  // The earliest año/período this sweep actually found a declaración for — the anchor for "has
  // the taxpayer's tax life started yet". A gap strictly BEFORE it is presumptively pre-inception,
  // not an omission. Kept as the FALLBACK anchor for whenever the perfil (below) is unavailable.
  const aniosConF22 = Object.entries(next.f22)
    .filter(([, tiene]) => tiene)
    .map(([anio]) => Number(anio));
  const primerAnioConF22Heuristico = aniosConF22.length > 0 ? Math.min(...aniosConF22) : null;
  const periodosConF29 = Object.entries(next.f29)
    .filter(([, tiene]) => tiene)
    .map(([periodo]) => periodo);
  // 'YYYY-MM' sorts lexicographically = chronologically.
  const primerPeriodoConF29Heuristico = periodosConF29.length > 0 ? periodosConF29.sort()[0]! : null;

  // P2 (ADR-035 §Consequences): `fechaInicioActividades` ES el anclaje real — anterior a la
  // heurística de "primer año/mes con declaración detectado", que solo aproximaba el inicio real
  // por el primer registro que el barrido alcanzó a ver. AT N reporta el año comercial N-1, así
  // que el primer año tributario que debe declarar es el siguiente al de inicio de actividades.
  const inicio = parseInicioActividades(ctx.fechaInicioActividades ?? null);
  const primerAnioConF22 = inicio ? inicio.anioComercial + 1 : primerAnioConF22Heuristico;
  const primerPeriodoConF29 = inicio ? inicio.periodo : primerPeriodoConF29Heuristico;

  // A missing ANNUAL return is the most consequential deficiency there is, and the sweep used to
  // miss it entirely (live finding 2026-07-26: "sin hallazgos" for a taxpayer with three unfiled
  // years). Only años STRICTLY BEFORE the current one are flagged: the current AT's deadline
  // varies by year and taxpayer, and ADR-004 forbids asserting a date we have not observed — so
  // the current año is deliberately left alone even though it may already be late.
  for (const [anio, tiene] of Object.entries(next.f22)) {
    if (tiene || Number(anio) >= currentYear) continue;
    // LIVE FINDING (2026-07-29, a real taxpayer account): AT2019 was reported as a missing
    // annual return at `alta` when every LATER año had one — the taxpayer simply did not exist
    // yet in the commercial year AT2019 covers (año tributario N reports on commercial year
    // N-1). Never silently drop it (a real early gap in an established taxpayer is still worth
    // knowing about), but downgrade to `info` when it precedes the earliest año we have positive
    // evidence for.
    if (primerAnioConF22 !== null && Number(anio) < primerAnioConF22) {
      cambios.push({
        tipo: 'f22_sin_declaracion',
        severidad: 'info',
        ambito: `F22 AT${anio}`,
        detalle: inicio
          ? `Sin declaración de renta (F22) para el año tributario ${anio} — anterior al inicio ` +
            `de actividades del contribuyente (${ctx.fechaInicioActividades}); no se confirma ` +
            'como incumplimiento.'
          : `Sin declaración de renta (F22) para el año tributario ${anio} — anterior al primer ` +
            `año tributario con declaración detectado (AT${primerAnioConF22}). Probablemente ` +
            'anterior al inicio de actividades del contribuyente; no se confirma como incumplimiento.',
      });
      continue;
    }
    cambios.push({
      tipo: 'f22_sin_declaracion',
      severidad: 'alta',
      ambito: `F22 AT${anio}`,
      detalle: `Sin declaración de renta (F22) presentada para el año tributario ${anio}.`,
    });
  }
  for (const [periodo, tiene] of Object.entries(next.f29)) {
    // The current period is still open — not declaring it yet is not a finding.
    if (tiene || periodo === currentPeriodo) continue;

    // P1 (ADR-037 hallazgo abierto): el mes INMEDIATAMENTE anterior comparte con el actual una
    // ventana de declaración todavía abierta — su plazo es el día 12, o el 20 para un declarante
    // electrónico (`autorizadoDeclararDia20`). Sin ese dato (perfil no disponible este barrido) se
    // mantiene el comportamiento anterior — nunca se asume el plazo más permisivo (ADR-004).
    if (
      periodo === ctx.mesAnteriorPeriodo &&
      ctx.autorizadoDeclararDia20 != null &&
      ctx.diaHoy != null
    ) {
      const plazoDia = ctx.autorizadoDeclararDia20 ? 20 : 12;
      if (ctx.diaHoy <= plazoDia) {
        cambios.push({
          tipo: 'f29_mes_sin_declaracion',
          severidad: 'info',
          ambito: `F29 ${periodo}`,
          detalle: `Sin declaración de F29 para ${periodo} — el plazo (día ${plazoDia}) todavía no vence.`,
        });
        continue;
      }
    }

    // Same pre-inception guard as F22, applied to the monthly IVA obligation.
    if (primerPeriodoConF29 !== null && periodo < primerPeriodoConF29) {
      cambios.push({
        tipo: 'f29_mes_sin_declaracion',
        severidad: 'info',
        ambito: `F29 ${periodo}`,
        detalle: inicio
          ? `Sin declaración de F29 para ${periodo} — anterior al inicio de actividades del ` +
            `contribuyente (${ctx.fechaInicioActividades}); no se confirma como incumplimiento.`
          : `Sin declaración de F29 para ${periodo} — anterior al primer período con declaración ` +
            `detectado (${primerPeriodoConF29}). Probablemente anterior al inicio de actividades ` +
            'del contribuyente; no se confirma como incumplimiento.',
      });
      continue;
    }
    cambios.push({
      tipo: 'f29_mes_sin_declaracion',
      severidad: 'alta',
      ambito: `F29 ${periodo}`,
      detalle: `Sin declaración de F29 para ${periodo}.`,
    });
  }
  return cambios;
}

/** CHANGE findings — meaningful only against a stored baseline. Pure; tested through the task. */
function diffCambios(
  prev: MonitorSnapshot,
  next: MonitorSnapshot,
  glosas: Record<string, Record<string, string>>,
): MonitorCambio[] {
  const cambios: MonitorCambio[] = [];

  for (const [anio, codigos] of Object.entries(next.observaciones)) {
    // A year that was never swept has NO baseline of its own — widening the window must not
    // report its pre-existing state as change (live finding 2026-07-26). Same rule as the
    // first-run case, applied per year.
    if (prev.observaciones[anio] === undefined) continue;
    const before = new Set(prev.observaciones[anio] ?? []);
    for (const codigo of codigos) {
      if (before.has(codigo)) continue;
      const glosa = glosas[anio]?.[codigo] ?? '';
      cambios.push({
        tipo: 'observacion_nueva',
        severidad: 'alta',
        ambito: `F22 AT${anio}`,
        detalle: `Nueva observación ${codigo}${glosa ? `: ${glosa}` : ''}`,
      });
    }
    const now = new Set(codigos);
    for (const codigo of prev.observaciones[anio] ?? []) {
      if (now.has(codigo)) continue;
      cambios.push({
        tipo: 'observacion_resuelta',
        severidad: 'info',
        ambito: `F22 AT${anio}`,
        detalle: `La observación ${codigo} ya no aparece (resuelta o reemplazada).`,
      });
    }
  }

  for (const [anio, fps] of Object.entries(next.eventos)) {
    if (prev.eventos[anio] === undefined) continue; // no per-year baseline ⇒ not change
    const before = new Set(prev.eventos[anio] ?? []);
    for (const fp of fps) {
      if (before.has(fp)) continue;
      const glosa = glosas[anio]?.[fp] ?? '';
      const [codigo, fecha] = fp.split('|');
      cambios.push({
        tipo: 'evento_nuevo',
        severidad: 'alta', // a new event means SII ACTED on the declaración
        ambito: `F22 AT${anio}`,
        detalle: `Nuevo evento ${codigo} (${fecha || 's/f'})${glosa ? `: ${glosa}` : ''}`,
      });
    }
  }

  for (const [numero, estado] of Object.entries(next.peticiones)) {
    const before = prev.peticiones[numero];
    if (before === undefined || before === estado) continue;
    cambios.push({
      tipo: 'peticion_cambio_estado',
      severidad: 'media',
      ambito: `Petición ${numero}`,
      detalle: `Cambió de "${before}" a "${estado}".`,
    });
  }

  // --- Cambios de las señales del spike F (ADR-037) -------------------------------------------
  // Un snapshot ANTERIOR a este spike no tiene estos mapas: `?? {}` evita reportar todo el estado
  // preexistente como novedad la primera vez que corre el monitor extendido (mismo cuidado que la
  // guarda por-año de las observaciones).
  const prevDj = prev.dj ?? {};
  for (const [clave, estado] of Object.entries(next.dj)) {
    const before = prevDj[clave];
    if (before === undefined || before === estado) continue;
    const [anio, num] = clave.split('|');
    cambios.push({
      tipo: 'dj_cambio_estado',
      severidad: 'media',
      ambito: `DJ ${num ?? '?'} AT${anio ?? '?'}`,
      detalle: `Cambió de "${before}" a "${estado}".`,
    });
  }

  const prevGiros = prev.giros ?? {};
  // Solo si YA había mapa de giros (snapshot post-ADR-037, aunque venga vacío): un snapshot
  // pre-ADR-037 no trae la clave y ahí todos los giros existentes parecerían nuevos. Un mapa
  // VACÍO es un barrido real con cero giros — el primer giro de la vida del contribuyente SÍ
  // debe reportarse como nuevo (antes se silenciaba si nacía pagado, saldo 0).
  if (prev.giros !== undefined) {
    for (const folio of Object.keys(next.giros)) {
      if (prevGiros[folio] !== undefined) continue;
      cambios.push({
        tipo: 'giro_nuevo',
        severidad: 'alta',
        ambito: `Giro ${folio}`,
        detalle: `Giro ${folio} emitido desde el último barrido.`,
      });
    }
  }

  return cambios;
}

/** Run the compliance sweep: read every watched signal in one session, diff against the stored
 *  baseline, and report what changed. The FIRST run establishes the baseline and reports no
 *  changes (pre-existing state is not news). Session-keyed, paced, never retried.
 *
 *  `dryRun` reports without moving the baseline — useful to preview before committing. */
export async function monitorSweep(
  runtime: Runtime,
  args: { anios?: number; meses?: number; dryRun?: boolean } = {},
): Promise<MonitorResult> {
  await assertSelfOperating(runtime);
  const nAnios = Math.max(1, Math.trunc(args.anios ?? DEFAULT_ANIOS));
  const nMeses = Math.max(1, Math.trunc(args.meses ?? DEFAULT_MESES));
  const dryRun = args.dryRun === true;
  const now = runtime.clock.now();
  const start = now.getTime();

  // Windows: the last `nAnios` años tributarios and the last `nMeses` months, ending today.
  const anios = Array.from({ length: nAnios }, (_, i) => Anio.of(now.getFullYear() - i));
  const meses = Array.from({ length: nMeses }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    return Periodo.of(d.getFullYear(), d.getMonth() + 1);
  });
  const currentPeriodo = Periodo.of(now.getFullYear(), now.getMonth() + 1).formatted;
  // El mes INMEDIATAMENTE anterior (P1) — independiente de `nMeses`, que puede ser 1.
  const mesAnteriorDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const mesAnteriorPeriodo = Periodo.of(
    mesAnteriorDate.getFullYear(),
    mesAnteriorDate.getMonth() + 1,
  ).formatted;

  try {
    const prev = await readMonitorSnapshot(runtime.store);
    const result = await withSession(runtime, async (session, ctx) => {
      const rut = Rut.parse(ctx.sessionRut); // session-keyed: always the principal
      const swept = await sweep(session, rut, anios, meses, () => runtime.clock.sleep(pacingMs()));
      // Stamp from the injected clock, not wall time, so tests are deterministic.
      const snapshot: MonitorSnapshot = { ...swept.snapshot, takenAt: now.toISOString() };
      // State findings always; change findings only once a baseline exists.
      const cambios = [
        ...estadoFindings(snapshot, currentPeriodo, now.getFullYear(), swept.girosConSaldo, {
          mesAnteriorPeriodo,
          autorizadoDeclararDia20: swept.autorizadoDeclararDia20,
          diaHoy: now.getDate(),
          fechaInicioActividades: swept.fechaInicioActividades,
        }),
        ...(prev ? diffCambios(prev, snapshot, swept.glosas) : []),
      ];
      return { rut: rut.canonical, snapshot, cambios, errores: swept.errores };
    });

    // Persist ONLY a completed sweep, and never under dryRun — a partial baseline would make the
    // next run report phantom "resolved" items for signals it never read (ADR-024).
    if (!dryRun) await runtime.store.write(MONITOR_KEY, result.snapshot);

    const resumen: MonitorResumen = {
      anios: nAnios,
      meses: nMeses,
      observaciones: Object.values(result.snapshot.observaciones).reduce((a, v) => a + v.length, 0),
      eventos: Object.values(result.snapshot.eventos).reduce((a, v) => a + v.length, 0),
      // Derived from `cambios`, not recomputed independently, so the count matches what is
      // actually flagged at `alta` — a pre-inception gap (severidad `info`) is real state that IS
      // still surfaced in `cambios`, but must not inflate this "deficiencies" count.
      mesesSinDeclaracion: result.cambios.filter(
        (c) => c.tipo === 'f29_mes_sin_declaracion' && c.severidad === 'alta',
      ).length,
      aniosSinF22: result.cambios.filter(
        (c) => c.tipo === 'f22_sin_declaracion' && c.severidad === 'alta',
      ).length,
      peticiones: Object.keys(result.snapshot.peticiones).length,
      // Derivados de `cambios`, como los dos de arriba, para que el conteo coincida siempre con
      // lo que realmente se marcó (ADR-024).
      djObservadas: result.cambios.filter((c) => c.tipo === 'dj_observada').length,
      girosConSaldo: result.cambios.filter((c) => c.tipo === 'giro_con_saldo').length,
      notificacionesVigentes: result.cambios.filter((c) => c.tipo === 'notificacion_vigente').length,
      cotIncumplidos: result.cambios.filter((c) => c.tipo === 'cot_incumplimiento').length,
    };

    const res: MonitorResult = {
      rut: result.rut,
      baseline: prev === null,
      cambios: result.cambios,
      resumen,
      errores: result.errores,
      dryRun,
    };

    // Receipt: counts and flags only. NEVER a código, glosa or monto (ADR-006 / ADR-024).
    audit(runtime, 'monitor_sweep', 'ok', {
      rut: res.rut,
      baseline: res.baseline,
      cambios: res.cambios.length,
      errores: res.errores.length,
      durationMs: runtime.clock.now().getTime() - start,
    });
    return res;
  } catch (e) {
    audit(runtime, 'monitor_sweep', 'failed', {});
    throw e;
  }
}
