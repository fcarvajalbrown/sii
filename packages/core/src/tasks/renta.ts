// `renta` — the annual pack (ADR-022). The second composite read: the F22 of an año tributario
// alongside the twelve monthly F29 positions of the commercial year it declares, so the year
// reads as ONE narrative instead of fourteen separate lookups.
//
// WHY THIS CALLS FACADES, NOT TASKS: `f22Status` and `f29Status` each open their own
// `withSession`, and the Node driver's `close()` tears down a whole Chromium — composing them
// would launch FOURTEEN browsers for one `sii renta`. So this opens ONE session and calls the
// facades inside it (the shape `rcvListAll` established; see ADR-022).
//
// THE YEAR OFFSET IS THE DOMAIN RULE: F22 for año tributario N declares the income of COMMERCIAL
// year N-1, so the pack pairs the F22 of AT N with the F29 months of N-1. Asserted in tests so
// a refactor cannot quietly shift the pack by a year.
//
// SESSION-KEYED (ADR-005): both halves authorize by the session principal, so this reads self
// and rejects a representing operate pointer up front. No `--rut`.
import { readSession, withSession } from '../auth/index.js';
import { recordAudit } from '../audit/index.js';
import { cachedRead, scopeIsClosed } from './cache.js';
import { DEFAULT_SETTINGS } from '../config/index.js';
import { F22Error } from '../errors/index.js';
import { readOperateState } from '../identity/index.js';
import { Anio, Periodo } from '../periodo/index.js';
import { Rut } from '../rut/index.js';
import { fetchF22Declaraciones, fetchF22Grid, pickVigenteFolio } from '../portal/f22/index.js';
import { groupCodigos } from '../portal/f22-codigos.js';
import type { F22Grupos } from '../portal/f22-codigos.js';
import { fetchF29Estado } from '../portal/f29.js';
import { declaracionVigente } from './f29.js';
import type { AuditEntry, Runtime } from '../seams/index.js';

const MESES_DEL_ANIO = 12;

/** Inter-request pace (ms) for the fan-out — never hammer SII (ADR-004). 14 POSTs, so this is
 *  not optional. */
const pacingMs = (): number => Math.round(1000 / DEFAULT_SETTINGS.rateLimitRps);

function audit(runtime: Runtime, action: string, result: string, extra: Partial<AuditEntry>): void {
  recordAudit(runtime, { action, result, ...extra });
}

/** One month's F29 position within the pack — the vigente declaración's identity + the declared
 *  total ("lo que pagué"). A month with nothing filed is a clean empty row, not an error. */
export interface RentaMes {
  readonly periodo: string; // YYYY-MM
  readonly tieneDeclaracion: boolean;
  readonly estado: string | null;
  readonly folio: number | null;
  readonly fecha: string | null;
  readonly total: number | null;
}

/** The annual-return half: the selected declaración plus the contador grouping of its código
 *  grid. `grupos` is null when the year has no declaración (nothing to group). NO `raw` and no
 *  identity/bank códigos — the grid is PII-filtered upstream (ADR-004 / ADR-006). */
export interface RentaF22 {
  readonly tieneDeclaracion: boolean;
  readonly folio: string | null;
  readonly estado: string | null;
  readonly grupos: F22Grupos | null;
}

/** The monthly-VAT half: the twelve F29 positions of the commercial year. */
export interface RentaIva {
  readonly meses: readonly RentaMes[];
  readonly mesesConDeclaracion: number;
  /** Sum of the declared monthly totals; null when no month was filed at all. */
  readonly totalDeclarado: number | null;
}

export interface RentaAnual {
  readonly rut: string;
  /** Año tributario (the F22's year), YYYY. */
  readonly anio: string;
  /** Commercial year the F22 declares and the F29 months belong to — always `anio - 1`. */
  readonly anioComercial: string;
  readonly f22: RentaF22;
  readonly iva: RentaIva;
  /** Served from the local cache rather than SII (ADR-027). The CURRENT año tributario is never
   *  cached — its F22 may not even be filed yet. */
  readonly cached: boolean;
}

/** Bump when the curated shape changes so cached entries self-invalidate (ADR-027). */
const RENTA_CACHE_VERSION = 1;

/** Reject a representing operate pointer BEFORE opening a session (ADR-005 / ADR-022). Both
 *  halves are session-keyed, so a representing pointer can only mislead. */
async function assertSelfOperating(runtime: Runtime): Promise<void> {
  const op = await readOperateState(runtime.store);
  if (op && op.operatingRut !== op.selfRut) {
    throw new F22Error(
      `La renta anual es session-keyed: el SII autoriza el F22 y el F29 por el titular de la ` +
        `sesión, no por el RUT operado (${Rut.parse(op.operatingRut).formatted}). Para la renta ` +
        'de esa empresa, inicia sesión como ella (`sii auth logout` y luego `sii auth login`).',
    );
  }
}

/** The annual pack for one año tributario: the F22 declaración + grouped código grid, alongside
 *  the twelve F29 monthly positions of the commercial year it declares. ONE session, paced,
 *  never retried (ADR-022). Session-keyed — always the principal.
 *
 *  A year with no F22, or a month with nothing filed, is DATA rather than an error; only a
 *  session-level failure aborts the pack. */
export async function rentaAnual(
  runtime: Runtime,
  args: { anio: string | number; refresh?: boolean },
): Promise<RentaAnual> {
  const anio = Anio.parse(args.anio); // fail fast on a bad año — no session opened
  await assertSelfOperating(runtime);
  // F22 of AT N declares commercial year N-1 — the rule that makes the two halves comparable.
  const anioComercial = anio.value - 1;
  const start = runtime.clock.now().getTime();
  // Local read — no browser, so a warm result costs nothing (ADR-027). 14 POSTs saved per hit.
  const stored = await readSession(runtime.store);
  const cacheKey = { task: 'renta', rut: stored?.rut ?? 'anon', scope: anio.canonical };
  const cacheOpts = {
    closed: scopeIsClosed(anio.canonical, runtime.clock),
    version: RENTA_CACHE_VERSION,
    ...(args.refresh !== undefined ? { refresh: args.refresh } : {}),
  };
  try {
    const { value: res, fromCache } = await cachedRead(runtime, cacheKey, cacheOpts, () =>
      withSession(runtime, async (session, ctx) => {
        const rut = Rut.parse(ctx.sessionRut); // session-keyed: ALWAYS the principal

        // --- F22 half: declaraciones, then the grid of the vigente folio (skipped if none) ---
        const decls = await fetchF22Declaraciones(session, { rut, anio });
        const folio = pickVigenteFolio(decls.declaraciones);
        let grupos: F22Grupos | null = null;
        let estado: string | null = null;
        if (folio !== null) {
          await runtime.clock.sleep(pacingMs());
          const codigos = await fetchF22Grid(session, { rut, anio, folio });
          grupos = groupCodigos(codigos);
          estado = decls.declaraciones.find((d) => d.folio === folio)?.estado ?? null;
        }

        // --- F29 half: the twelve months of the commercial year ---
        const meses: RentaMes[] = [];
        for (let mes = 1; mes <= MESES_DEL_ANIO; mes++) {
          await runtime.clock.sleep(pacingMs()); // every POST after the first is paced
          const periodo = Periodo.of(anioComercial, mes);
          const est = await fetchF29Estado(session, { rut, periodo });
          // The SAME selector `f29Overview` uses (estadoId 1 / "Vigente", else first record) — a
          // `folio !== null` pick would match a saved-only draft (folio 0) or a superseded
          // rectificada and report a total that was never (or no longer is) the filed one.
          const decl = declaracionVigente(est.declaraciones);
          meses.push({
            periodo: periodo.formatted,
            tieneDeclaracion: est.tieneDeclaracion,
            estado: decl?.estado ?? null,
            folio: decl?.folio ?? null,
            fecha: decl?.fecha ?? null,
            total: decl?.total ?? null,
          });
        }

        const conDeclaracion = meses.filter((m) => m.tieneDeclaracion);
        const totalDeclarado = conDeclaracion.length
          ? conDeclaracion.reduce((acc, m) => acc + (m.total ?? 0), 0)
          : null; // no month filed ⇒ null, not 0 (nothing was declared, vs declaring zero)

        return {
          rut: rut.canonical,
          anio: anio.canonical,
          anioComercial: String(anioComercial),
          f22: {
            tieneDeclaracion: decls.tieneDeclaracion,
            folio,
            estado,
            grupos,
          },
          iva: { meses, mesesConDeclaracion: conDeclaracion.length, totalDeclarado },
          cached: false, // overwritten below when served from disk
        } satisfies RentaAnual;
      }),
    );

    // Receipt: the año, months filed, and whether SII was actually consulted (ADR-027).
    // NEVER a monto (ADR-006).
    audit(runtime, 'renta_anual', 'ok', {
      rut: res.rut,
      period: anio.canonical,
      meses: res.iva.mesesConDeclaracion,
      cached: fromCache,
      durationMs: runtime.clock.now().getTime() - start,
    });
    return { ...res, cached: fromCache };
  } catch (e) {
    audit(runtime, 'renta_anual', 'failed', { period: anio.canonical });
    throw e;
  }
}
