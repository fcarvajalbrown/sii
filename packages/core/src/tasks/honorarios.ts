// `honorarios` — the annual honorarios & retenciones reconciliation (ADR-023, extended by
// ADR-029). The third composite read, built on the ADR-022 shape (facade join inside ONE
// `withSession`, paced, session-keyed). Motivated by a live F22 observación:
//
//   B92 — CONTROL DE LOS HONORARIOS DECLARADOS EN EL COD. 1412 DEL F22 CONTRIBUYENTES
//         ACOGIDOS AL RÉGIMEN DEL N°3 DE LA LETRA D ART. 14.
//
// THREE TRAPS, all encoded here and asserted in tests:
//
// 1. ONLY ONE SIDE OF A BHE IS OURS TO DECLARE. On boletas RECIBIDAS we are the receptor:
//    `retencionReceptor` was withheld BY US and is ours to declare; `retencionEmisor` was
//    withheld by the contractor for themselves and is NOT. Summing both manufactures a false
//    mismatch — the split IS the reconciliation.
// 2. F29 código 151 is honorarios; 153 is NOT. 151 = "Retención … 10% sobre las rentas del
//    Art. 42 Nº 2, según Art. 74 Nº 2 LIR". Its neighbour 153 = "… Art. 48, según Art. 74 Nº 3"
//    is participaciones de directorio — adjacent, easily confused, and excluded here.
// 3. STANDARD BHE RECIBIDAS IS NOT THE ONLY RETENCIÓN SOURCE (ADR-029). A company that pays a
//    low-skilled/informal worker can EMIT the boleta on the worker's behalf (BPST — Boleta de
//    Prestación de Servicios de Terceros, `portal/bpst.ts`) — same tax substance as a BHE
//    recibida, different SII product. Omitting it produced a real, persistent, large false
//    "descuadre" (live finding 2026-07-29, a real taxpayer account): F29 código 151 always
//    exceeded BHE-recibidas-only by exactly the taxpayer's BPST EMITIDAS retenido. The
//    reconciled total is `retencionReceptor + bpstRetenido`, never `retencionReceptor` alone.
//
// THE F22 LEG SURFACES, IT DOES NOT ASSERT. Código 1412 is named by B92 but is absent from our
// taxonomy (`f22-codigos.ts` maps 110/461/467/492/545) and we have NO first-hand observation of
// its semantics. So we report it verbatim with `enTaxonomia:false` and compute NO delta against
// the F22 — adjudicating a rule we have not observed would be a confidently-wrong number
// (ADR-004). The user compares; the tool does not guess.
import { readSession, withSession } from '../auth/index.js';
import { recordAudit } from '../audit/index.js';
import { cachedRead, scopeIsClosed } from './cache.js';
import { DEFAULT_SETTINGS } from '../config/index.js';
// Only Bte/Bpst/F29 errors are per-MONTH recoverable; the F22 leg is a single read outside the
// loop, so an F22Error propagates and aborts — no need to import it here.
import { BpstError, BteError, F29Error } from '../errors/index.js';
import { readOperateState } from '../identity/index.js';
import { Anio, Periodo } from '../periodo/index.js';
import { Rut } from '../rut/index.js';
import { fetchBteMensual } from '../portal/bte.js';
import { fetchBpstMensual } from '../portal/bpst.js';
import { fetchF29Propuesta } from '../portal/f29.js';
import { fetchF22Declaraciones, fetchF22Grid, pickVigenteFolio } from '../portal/f22/index.js';
import type { AuditEntry, PortalSession, Runtime } from '../seams/index.js';

const MESES_DEL_ANIO = 12;

/** F29 retención of honorarios — Art. 42 Nº 2 via Art. 74 Nº 2 LIR (observed, f29-codigos.ts).
 *  NOT 153 (Art. 48, participaciones de directorio): different article, different withholding,
 *  and including it would silently inflate the declared side (ADR-023). */
const COD_F29_RETENCION_HONORARIOS = '151';

/** F22 códigos reported alongside the reconciliation. The first five are mapped in
 *  `f22-codigos.ts`; `1412` is NOT — it is included because SII's own B92 glosa names it, and is
 *  flagged `enTaxonomia:false` so no caller mistakes it for something we understand. */
const F22_CODIGOS_HONORARIOS: readonly string[] = ['110', '461', '467', '492', '545', '1412'];
/** Which of the above our taxonomy actually maps (everything except 1412). */
const F22_CODIGOS_EN_TAXONOMIA: ReadonlySet<string> = new Set(['110', '461', '467', '492', '545']);

const pacingMs = (): number => Math.round(1000 / DEFAULT_SETTINGS.rateLimitRps);

function audit(runtime: Runtime, action: string, result: string, extra: Partial<AuditEntry>): void {
  recordAudit(runtime, { action, result, ...extra });
}

/** One month: what we received and withheld (BHE recibidas + BPST emitidas, ADR-029) vs what
 *  the F29 declares. */
export interface HonorariosMes {
  readonly periodo: string; // YYYY-MM
  readonly boletas: number | null;
  readonly totalHonorarios: number | null;
  /** Withheld BY US as receptor on standard BHE — part of the figure that must reach F29 código
   *  151 (the other part is `bpstRetenido`, ADR-029). */
  readonly retencionReceptor: number | null;
  /** Withheld by the contractor for themselves — reported, never reconciled. */
  readonly retencionEmisor: number | null;
  /** Gross total of BPST (Boleta de Prestación de Servicios de Terceros) boletas EMITIDAS on
   *  behalf of workers this month — ADR-029. `null` only when BOTH this and `retencionReceptor`
   *  are absent (mirrors `sumOrNull`); a taxpayer with no BPST activity sees `0`, not `null`. */
  readonly bpstBrutos: number | null;
  /** Retenido on those BPST boletas — the SECOND half of what must reach F29 código 151. */
  readonly bpstRetenido: number | null;
  /** F29 código 151 for the month; null when SII has no propuesta. */
  readonly f29Retencion: number | null;
  /** `(retencionReceptor + bpstRetenido) - f29Retencion`; null when either side is absent
   *  (ADR-029: the reconciled BHE-side figure is the COMBINED total, not `retencionReceptor`
   *  alone — see the module header, trap 3). */
  readonly delta: number | null;
}

/** One F22 código surfaced for comparison. `enTaxonomia:false` means our código map does not
 *  cover it (e.g. 1412) — the value and SII's inline glosa are passed through verbatim. */
export interface HonorariosF22Codigo {
  readonly codigo: string;
  readonly glosa: string | null;
  readonly valor: number | null;
  readonly enTaxonomia: boolean;
}

export interface HonorariosF22 {
  readonly anio: string; // año tributario
  readonly tieneDeclaracion: boolean;
  readonly folio: string | null;
  readonly codigos: readonly HonorariosF22Codigo[];
}

export interface HonorariosTotales {
  readonly boletas: number | null;
  readonly totalHonorarios: number | null;
  readonly retencionReceptor: number | null;
  readonly retencionEmisor: number | null;
  /** Annual sum of `bpstBrutos` (ADR-029). */
  readonly bpstBrutos: number | null;
  /** Annual sum of `bpstRetenido` (ADR-029) — combines with `retencionReceptor` in the
   *  reconciliation below. */
  readonly bpstRetenido: number | null;
  readonly f29Retencion: number | null;
}

/** Combined "what we withheld" (BHE recibidas `retencionReceptor` + BPST emitidas `bpstRetenido`,
 *  ADR-029) vs F29 (what we declared). Deltas are that COMBINED total MINUS F29, so a positive
 *  delta means we withheld more than we declared. NO F22 delta by design — see the header. */
export interface HonorariosReconciliacion {
  /** `retencionReceptor + bpstRetenido` (ADR-029) — despite the name, this is NOT BHE-only since
   *  ADR-029; kept for backward-compatible shape, its meaning is now the combined reconciled
   *  total. See `retencionBpst` for the BPST-only component. */
  readonly retencionBhe: number | null;
  /** The BPST-only component already folded into `retencionBhe` above — surfaced separately so a
   *  caller can see how much of the reconciled total came from which SII product. */
  readonly retencionBpst: number | null;
  readonly retencionF29: number | null;
  readonly delta: number | null;
  readonly cuadra: boolean;
  /** Months whose delta is non-zero or indeterminable — the actionable part. */
  readonly mesesDescuadrados: readonly string[];
}

export interface HonorariosAnual {
  readonly rut: string;
  /** Commercial year the boletas belong to (the argument). */
  readonly anioComercial: string;
  /** Año tributario of the paired F22 — always `anioComercial + 1`. */
  readonly anioTributario: string;
  /** Fase 1 compares against SII's F29 SUGGESTION, not the filed form (ADR-013). */
  readonly fuente: 'propuesta';
  readonly meses: readonly HonorariosMes[];
  readonly totales: HonorariosTotales;
  readonly f22: HonorariosF22;
  readonly reconciliacion: HonorariosReconciliacion;
  /** Per-month SII errors, verbatim; the rest of the year still returns (ADR-004). */
  readonly mesesConError: readonly { readonly periodo: string; readonly mensaje: string }[];
  /** Served from the local cache rather than SII (ADR-027). The heaviest read in the repo
   *  (~26 POSTs plus BHE pagination), so a hit is the largest single saving available. */
  readonly cached: boolean;
}

/** Bump when the curated shape changes so cached entries self-invalidate (ADR-027).
 *  v2 (ADR-029): added the BPST leg (`bpstBrutos`/`bpstRetenido`) and changed what the
 *  reconciliation combines — a v1 cache entry would silently under-report the reconciled total,
 *  so it MUST NOT be served after this change. */
const HONORARIOS_CACHE_VERSION = 2;

/** Reject a representing operate pointer BEFORE opening a session (ADR-005 / ADR-023). All three
 *  legs (BHE, F29, F22) are session-keyed, so a representing pointer can only mislead. */
async function assertSelfOperating(runtime: Runtime): Promise<void> {
  const op = await readOperateState(runtime.store);
  if (op && op.operatingRut !== op.selfRut) {
    throw new F29Error(
      `El cuadre de honorarios es session-keyed: cruza BHE, F29 y F22, y el SII autoriza los ` +
        `tres por el titular de la sesión, no por el RUT operado ` +
        `(${Rut.parse(op.operatingRut).formatted}). Para los honorarios de esa empresa, inicia ` +
        'sesión como ella (`sii auth logout` y luego `sii auth login`).',
    );
  }
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Sum, treating null as absent. Returns null only when EVERY input was null — so a year with
 *  no data at all stays null instead of collapsing to a misleading 0. */
function sumOrNull(values: readonly (number | null)[]): number | null {
  const present = values.filter((v): v is number => v !== null);
  return present.length === 0 ? null : present.reduce((a, b) => a + b, 0);
}

/** BHE minus F29, or null when either side is absent (never coerce null to 0 — ADR-023). */
const delta = (bhe: number | null, f29: number | null): number | null =>
  bhe === null || f29 === null ? null : bhe - f29;

/** The reconciled "what we withheld" figure for one month — standard BHE recibidas PLUS BPST
 *  emitidas (ADR-029, trap 3). `sumOrNull` semantics: null only when BOTH sides are absent. */
const combinedRetencion = (m: {
  readonly retencionReceptor: number | null;
  readonly bpstRetenido: number | null;
}): number | null => sumOrNull([m.retencionReceptor, m.bpstRetenido]);

/** Does a month reconcile? A `null` delta is NOT automatically a discrepancy: a month with no
 *  boletas and nothing declared is simply empty, and flagging every quiet month would bury the
 *  real ones. So the VERDICT treats absent as "nothing" while `delta` itself stays honestly
 *  null (we cannot compute a real difference from a missing side):
 *    both absent            → balances (empty month)
 *    one absent, other 0    → balances
 *    one absent, other ≠ 0  → DISCREPANCY (declared without boletas, or withheld without a
 *                             propuesta) — indeterminable, but exactly what the user must see
 *    both present           → balances iff equal                                    (ADR-023)
 *  "Both sides" as of ADR-029 means the COMBINED BHE+BPST figure, not BHE alone. */
function mesCuadra(m: HonorariosMes): boolean {
  const combinada = combinedRetencion(m);
  if (combinada === null && m.f29Retencion === null) return true;
  return (combinada ?? 0) === (m.f29Retencion ?? 0);
}

/** Read one month: BHE recibidas + BPST emitidas (ADR-029) + the F29 propuesta's código 151.
 *  A per-month SII error (either leg) is captured by the caller and does not abort the year. */
async function readMes(
  session: PortalSession,
  rut: Rut,
  periodo: Periodo,
  pace: () => Promise<void>,
): Promise<HonorariosMes> {
  // RECIBIDAS: boletas issued TO us — we are the receptor, so `retencionReceptor` is ours.
  const bte = await fetchBteMensual(session, { rut, periodo, side: 'RECIBIDAS' }, pace);
  await pace();
  // EMITIDAS: boletas WE issued on behalf of a worker (BPST, ADR-029) — the second half of what
  // we owe SII. A DIFFERENT SII product from `bte` above (see the module header, trap 3).
  const bpst = await fetchBpstMensual(session, { rut, periodo, side: 'EMITIDAS' }, pace);
  await pace();
  const prop = await fetchF29Propuesta(session, { rut, periodo });
  const f29Retencion = prop.tienePropuesta
    ? (prop.codigos.find((c) => c.codigo === COD_F29_RETENCION_HONORARIOS)?.valor ?? null)
    : null;
  const combinada = sumOrNull([bte.totales.retencionReceptor, bpst.totales.retenidos]);
  return {
    periodo: periodo.formatted,
    boletas: bte.totalBoletas,
    totalHonorarios: bte.totales.honorarios,
    retencionReceptor: bte.totales.retencionReceptor,
    retencionEmisor: bte.totales.retencionEmisor,
    bpstBrutos: bpst.totales.brutos,
    bpstRetenido: bpst.totales.retenidos,
    f29Retencion,
    delta: delta(combinada, f29Retencion),
  };
}

/** Annual honorarios reconciliation for the session principal: what we withheld on boletas de
 *  honorarios RECIBIDAS versus what the F29 declares (código 151), month by month, with the
 *  F22's honorarios códigos surfaced alongside for comparison. ONE session, paced, never
 *  retried. `anio` is the COMMERCIAL year; the F22 read is año tributario `anio + 1`. */
export async function honorariosAnual(
  runtime: Runtime,
  args: { anio: string | number; refresh?: boolean },
): Promise<HonorariosAnual> {
  const comercial = Anio.parse(args.anio); // fail fast — no session opened
  await assertSelfOperating(runtime);
  const tributario = Anio.of(comercial.value + 1);
  const start = runtime.clock.now().getTime();
  // Local read — no browser (ADR-027). The scope is the COMMERCIAL year, but the paired F22 is
  // AT+1, so the entry is only cacheable once the año TRIBUTARIO has also closed; otherwise the
  // F22 half is still live. Hence `scopeIsClosed(tributario)`, not `comercial`.
  const stored = await readSession(runtime.store);
  const cacheKey = { task: 'honorarios', rut: stored?.rut ?? 'anon', scope: comercial.canonical };
  const cacheOpts = {
    closed: scopeIsClosed(tributario.canonical, runtime.clock),
    version: HONORARIOS_CACHE_VERSION,
    ...(args.refresh !== undefined ? { refresh: args.refresh } : {}),
  };
  try {
    const { value: res, fromCache } = await cachedRead(runtime, cacheKey, cacheOpts, () =>
      withSession(runtime, async (session, ctx) => {
        const rut = Rut.parse(ctx.sessionRut); // session-keyed: always the principal
        const pace = (): Promise<void> => runtime.clock.sleep(pacingMs());

        const meses: HonorariosMes[] = [];
        const mesesConError: { periodo: string; mensaje: string }[] = [];
        for (let mes = 1; mes <= MESES_DEL_ANIO; mes++) {
          const periodo = Periodo.of(comercial.value, mes);
          try {
            meses.push(await readMes(session, rut, periodo, pace));
          } catch (e) {
            // A per-month business error stops the MONTH, not the year (ADR-004). A session-level
            // failure is not one of these and propagates.
            if (e instanceof BteError || e instanceof BpstError || e instanceof F29Error) {
              mesesConError.push({ periodo: periodo.formatted, mensaje: messageOf(e) });
              meses.push({
                periodo: periodo.formatted,
                boletas: null,
                totalHonorarios: null,
                retencionReceptor: null,
                retencionEmisor: null,
                bpstBrutos: null,
                bpstRetenido: null,
                f29Retencion: null,
                delta: null,
              });
              continue;
            }
            throw e;
          }
          await pace();
        }

        // --- F22 leg: surface the honorarios códigos of año tributario `comercial + 1` ---
        const decls = await fetchF22Declaraciones(session, { rut, anio: tributario });
        const folio = pickVigenteFolio(decls.declaraciones);
        let codigos: HonorariosF22Codigo[] = [];
        if (folio !== null) {
          await pace();
          const grid = await fetchF22Grid(session, { rut, anio: tributario, folio });
          codigos = grid
            .filter((c) => F22_CODIGOS_HONORARIOS.includes(c.codigo))
            .map((c) => ({
              codigo: c.codigo,
              glosa: c.glosa,
              valor: c.valor,
              enTaxonomia: F22_CODIGOS_EN_TAXONOMIA.has(c.codigo),
            }));
        }

        const totales: HonorariosTotales = {
          boletas: sumOrNull(meses.map((m) => m.boletas)),
          totalHonorarios: sumOrNull(meses.map((m) => m.totalHonorarios)),
          retencionReceptor: sumOrNull(meses.map((m) => m.retencionReceptor)),
          retencionEmisor: sumOrNull(meses.map((m) => m.retencionEmisor)),
          bpstBrutos: sumOrNull(meses.map((m) => m.bpstBrutos)),
          bpstRetenido: sumOrNull(meses.map((m) => m.bpstRetenido)),
          f29Retencion: sumOrNull(meses.map((m) => m.f29Retencion)),
        };
        // ADR-029: the reconciled total is the COMBINED annual BHE+BPST figure, not BHE alone.
        const retencionCombinada = sumOrNull([totales.retencionReceptor, totales.bpstRetenido]);
        const anualDelta = delta(retencionCombinada, totales.f29Retencion);
        const mesesDescuadrados = meses.filter((m) => !mesCuadra(m)).map((m) => m.periodo);

        return {
          rut: rut.canonical,
          anioComercial: comercial.canonical,
          anioTributario: tributario.canonical,
          fuente: 'propuesta',
          meses,
          totales,
          f22: {
            anio: tributario.canonical,
            tieneDeclaracion: decls.tieneDeclaracion,
            folio,
            codigos,
          },
          reconciliacion: {
            retencionBhe: retencionCombinada, // ADR-029: combined BHE + BPST, not BHE alone
            retencionBpst: totales.bpstRetenido,
            retencionF29: totales.f29Retencion,
            delta: anualDelta,
            // The year balances iff every month does. Derived from the months, not from the annual
            // delta, which is null whenever any side was absent even though the months reconcile.
            cuadra: mesesDescuadrados.length === 0,
            mesesDescuadrados,
          },
          mesesConError,
          cached: false, // overwritten below when served from disk
        } satisfies HonorariosAnual;
      }),
    );

    // Receipt: year, whether it balanced, and whether SII was actually consulted (ADR-027).
    // NEVER a monto or a counterparty (ADR-006).
    audit(runtime, 'honorarios_anual', 'ok', {
      rut: res.rut,
      period: res.anioComercial,
      cuadra: res.reconciliacion.cuadra,
      cached: fromCache,
      mesesConError: res.mesesConError.length,
      durationMs: runtime.clock.now().getTime() - start,
    });
    return { ...res, cached: fromCache };
  } catch (e) {
    audit(runtime, 'honorarios_anual', 'failed', { period: comercial.canonical });
    throw e;
  }
}
