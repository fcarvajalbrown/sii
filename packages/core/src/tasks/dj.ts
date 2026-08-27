// Public DJ task API the surfaces call (ADR-003 / ADR-030). Estado de Declaraciones Juradas,
// read-only. SESSION-KEYED (ADR-030: RUT-in-path reach for a represented empresa was NOT
// confirmed live — treat as self-only until a future spike proves otherwise, same caution as
// F22/F29/BTE/BPST). The período window is validated locally BEFORE any session.
import { withSession } from '../auth/index.js';
import { recordAudit } from '../audit/index.js';
import { DjError } from '../errors/index.js';
import { readOperateState } from '../identity/index.js';
import { Anio } from '../periodo/index.js';
import { Rut } from '../rut/index.js';
import { DEFAULT_SETTINGS } from '../config/index.js';
import { fetchDjDetalle, fetchDjEstadoAnual, fetchDjHistorialAnual } from '../portal/dj.js';
import type { DjDetalle as PortalDjDetalle, DjEstadoRow, DjHistorialAnual as PortalDjHistorialAnual } from '../portal/dj.js';
import type { AuditEntry, Runtime } from '../seams/index.js';

export type { DjEstadoAnual, DjEstadoRow } from '../portal/dj.js';
export type {
  DjHistorialAnual,
  DjHistorialItem,
  DjHistorialRow,
  DjDetalle,
  DjSeccion,
  DjTablaNombrada,
  DjFila,
  DjCelda,
} from '../portal/dj.js';

/** Each `getDjIntegralAnual` call covers a 3-year rolling window (ADR-030) — the sweep steps by
 *  3 to cover `years` distinct años with the fewest calls, with a 1-year overlap tolerated (the
 *  overlap is simply merged, not double-counted). */
const WINDOW_SIZE = 3;
const DEFAULT_YEARS = 6;
const MAX_YEARS = 15;

const pacingMs = (): number => Math.round(1000 / DEFAULT_SETTINGS.rateLimitRps);

function audit(runtime: Runtime, action: string, result: string, extra: Partial<AuditEntry>): void {
  recordAudit(runtime, { action, result, ...extra });
}

/** Reject a representing operate pointer BEFORE opening a session (ADR-005 / ADR-030): reach for
 *  a represented empresa via the RUT-in-path was never confirmed live, so this stays self-only
 *  until a future spike proves otherwise. */
async function assertSelfOperating(runtime: Runtime): Promise<void> {
  const op = await readOperateState(runtime.store);
  if (op && op.operatingRut !== op.selfRut) {
    throw new DjError(
      `El estado de declaraciones juradas es session-keyed: el SII autoriza por el titular de la ` +
        `sesión, no por el RUT operado (${Rut.parse(op.operatingRut).formatted}). Para las DJ de esa ` +
        'empresa, inicia sesión como ella (`sii auth logout` y luego `sii auth login`).',
    );
  }
}

export interface DjStatusResult {
  readonly rut: string;
  /** Every año tributario actually returned by SII, sorted ascending. */
  readonly aniosConsultados: readonly string[];
  /** One entry per DJ (form) number, merged across every window fetched. */
  readonly rows: readonly DjEstadoRow[];
  /** True when the sweep stopped BEFORE covering `years` años because SII's own "out of range"
   *  shape was hit on an OLDER periodo (ADR-030) — a soft stop, not a failure. `false` means the
   *  full requested window was read (or the requested `years` fit in a single call). */
  readonly historiaAgotada: boolean;
}

function mergeRow(existing: DjEstadoRow | undefined, incoming: DjEstadoRow): DjEstadoRow {
  if (!existing) return incoming;
  return { ...existing, estados: { ...existing.estados, ...incoming.estados } };
}

/** Estado de Declaraciones Juradas for the session principal, covering the last `years` años
 *  tributarios (default 6, max 15). Session-keyed, paced, never retried. An out-of-range
 *  `DjError` on any periodo AFTER the first (most recent) is a SOFT STOP — the sweep has simply
 *  run off the front of this taxpayer's DJ history, not hit a real error (ADR-030). The SAME
 *  error on the FIRST periodo is NOT assumed benign and propagates. */
export async function djStatus(
  runtime: Runtime,
  args: { years?: number } = {},
): Promise<DjStatusResult> {
  const years = Math.min(MAX_YEARS, Math.max(1, Math.trunc(args.years ?? DEFAULT_YEARS)));
  await assertSelfOperating(runtime);
  const start = runtime.clock.now().getTime();
  const currentYear = runtime.clock.now().getFullYear();
  const numWindows = Math.ceil(years / WINDOW_SIZE);
  const periodos = Array.from({ length: numWindows }, (_, i) => Anio.of(currentYear - i * WINDOW_SIZE));

  try {
    const result = await withSession(runtime, async (session, ctx) => {
      const rut = Rut.parse(ctx.sessionRut); // session-keyed: always the principal
      const merged = new Map<number, DjEstadoRow>();
      const aniosSet = new Set<string>();
      let historiaAgotada = false;

      const pace = (): Promise<void> => runtime.clock.sleep(pacingMs());
      for (let i = 0; i < periodos.length; i++) {
        if (i > 0) await pace();
        try {
          const res = await fetchDjEstadoAnual(session, { rut, periodo: periodos[i]! }, pace);
          for (const row of res.rows) {
            const key = row.dj ?? row.id ?? -(i + 1); // stable-enough fallback; dj is expected present
            merged.set(key, mergeRow(merged.get(key), row));
            for (const year of Object.keys(row.estados)) aniosSet.add(year);
          }
        } catch (e) {
          // Only a periodo AFTER the first is treated as "ran off the front of history" — the
          // current año tributario must always be queryable, so a failure there is a real
          // problem (ADR-030), not a soft stop.
          if (e instanceof DjError && i > 0) {
            historiaAgotada = true;
            break;
          }
          throw e;
        }
      }

      return {
        rut: rut.canonical,
        aniosConsultados: [...aniosSet].sort(),
        rows: [...merged.values()],
        historiaAgotada,
      } satisfies DjStatusResult;
    });

    // Receipt: rut, año count, result. NEVER a DJ estado value or título (ADR-006).
    audit(runtime, 'dj_status', 'ok', {
      rut: result.rut,
      period: `${years}y`,
      durationMs: runtime.clock.now().getTime() - start,
    });
    return result;
  } catch (e) {
    audit(runtime, 'dj_status', 'failed', { period: `${years}y` });
    throw e;
  }
}

/** `getDjIntegralAnualDetalle` (ADR-031): presentation history — folio/key/estado/
 *  tipoDeclaracion, including anuladas/rectificatorias — for every DJ in one año tributario.
 *  The `key` a row's `presentaciones[]` entry carries is what `djDetalle` needs. Session-keyed,
 *  same caution as `djStatus` (RUT-in-path reach for a represented empresa unconfirmed). */
export async function djHistorial(
  runtime: Runtime,
  args: { anio: string | number },
): Promise<PortalDjHistorialAnual> {
  const anio = Anio.parse(args.anio); // fail fast — no session opened
  await assertSelfOperating(runtime);
  const start = runtime.clock.now().getTime();
  try {
    const result = await withSession(runtime, async (session, ctx) => {
      const rut = Rut.parse(ctx.sessionRut); // session-keyed: always the principal
      const pace = (): Promise<void> => runtime.clock.sleep(pacingMs());
      return fetchDjHistorialAnual(session, { rut, periodo: anio }, pace);
    });
    // Receipt: rut + result only. NEVER a folio, estado or título (ADR-006).
    audit(runtime, 'dj_historial', 'ok', {
      rut: result.rut,
      period: anio.canonical,
      durationMs: runtime.clock.now().getTime() - start,
    });
    return result;
  } catch (e) {
    audit(runtime, 'dj_historial', 'failed', { period: anio.canonical });
    throw e;
  }
}

/** `detalle` (ADR-031): the actual form content for one DJ presentation — a render-oriented
 *  table, faithful to the wire (no semantic re-modeling; see the module header / ADR-031).
 *  `dj` and `key` come from a prior `djHistorial` call. Session-keyed. Only the ANUAL form is
 *  supported (`docs/sii-contract/dj-detalle.md`: monthly DJs are unconfirmed). */
export async function djDetalle(
  runtime: Runtime,
  args: {
    anio: string | number;
    dj: number;
    key: number;
    pagina?: number;
    seccion?: number;
    tipoConsulta?: number;
  },
): Promise<PortalDjDetalle> {
  const anio = Anio.parse(args.anio); // fail fast — no session opened
  await assertSelfOperating(runtime);
  const start = runtime.clock.now().getTime();
  try {
    const result = await withSession(runtime, async (session, ctx) => {
      const rut = Rut.parse(ctx.sessionRut); // session-keyed: always the principal
      const pace = (): Promise<void> => runtime.clock.sleep(pacingMs());
      return fetchDjDetalle(
        session,
        {
          rut,
          anio,
          dj: args.dj,
          key: args.key,
          ...(args.pagina !== undefined ? { pagina: args.pagina } : {}),
          ...(args.seccion !== undefined ? { seccion: args.seccion } : {}),
          ...(args.tipoConsulta !== undefined ? { tipoConsulta: args.tipoConsulta } : {}),
        },
        pace,
      );
    });
    // Receipt: rut, dj number, period. NEVER a cell value (ADR-006) — the whole point of this
    // task is to read financial figures, none of which belong in an audit receipt.
    audit(runtime, 'dj_detalle', 'ok', {
      rut: result.rut,
      period: result.periodo,
      dj: args.dj,
      durationMs: runtime.clock.now().getTime() - start,
    });
    return result;
  } catch (e) {
    audit(runtime, 'dj_detalle', 'failed', { period: anio.canonical, dj: args.dj });
    throw e;
  }
}
