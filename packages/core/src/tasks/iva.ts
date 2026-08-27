// `iva` — the monthly VAT reconciliation (ADR-022). The FIRST composite read: it joins two
// existing facades rather than wrapping a new SII endpoint.
//
// WHY THIS CALLS FACADES, NOT TASKS: `rcvSummary` and `f29Formulario` each open their own
// `withSession`, and the Node driver's `close()` tears down a whole Chromium. Composing them
// would launch THREE browsers for one `sii iva`. So the composite opens ONE session and calls
// the facades inside it — the same shape `rcvListAll` uses. Composites are the one place in
// `tasks/` that may call several facades; the ADR-003 surface boundary is untouched.
//
// SESSION-KEYED, self only (ADR-005). RCV is body-RUT but F29 is session-keyed, so a composite
// operating as a represented empresa would splice THAT empresa's ledger onto the SESSION
// principal's F29 and present the delta as a reconciliation — a confidently-wrong number. A
// composite is only as reachable as its most restrictive member, so this rejects a representing
// pointer up front and takes no `--rut`.
import { readSession, withSession } from '../auth/index.js';
import { recordAudit } from '../audit/index.js';
import { cachedRead, scopeIsClosed } from './cache.js';
import { DEFAULT_SETTINGS } from '../config/index.js';
import { F29Error } from '../errors/index.js';
import { readOperateState } from '../identity/index.js';
import { Periodo } from '../periodo/index.js';
import { Rut } from '../rut/index.js';
import { fetchRcvResumen } from '../portal/rcv.js';
import type { RcvResumen, RcvResumenRow } from '../portal/rcv.js';
import { fetchF29Propuesta } from '../portal/f29.js';
import type { CodigoF29 } from '../portal/f29.js';
import type { AuditEntry, Runtime } from '../seams/index.js';

/** SII's own total códigos on the F29 propuesta — both carry a `'='` sign in the observed form
 *  (`portal/f29-codigos.ts`), i.e. they ARE SII's totals. We read them rather than re-deriving
 *  a sum from member códigos: our sum could legitimately disagree (an unobserved código) and
 *  would then report a reconciliation failure that does not exist (ADR-004, ADR-022). */
const COD_TOTAL_DEBITOS = '538';
const COD_TOTAL_CREDITOS = '537';

/** LIVE-VALIDATION FINDING (2026-07-26, real propuesta): SII's **propuesta does not carry the
 *  computed totals** — the `totales` group came back EMPTY, with 538/537 absent, while the
 *  COMPONENT códigos were present and derived from the RCV by SII itself. Observed:
 *  `511` = 15.056-style IVA on received electronic documents, matching our RCV crédito exactly;
 *  `562` = the compras exento total; `519`/`584` = document counts.
 *
 *  So the crédito side falls back to **511** ("IVA por documentos electrónicos recibidos"),
 *  cited from that observation.
 *
 *  **P3 (2026-08-05, six real months WITH ventas, a real taxpayer account): 538 stays absent regardless of
 *  ventas activity** — it is not a zero-sales artifact, this propuesta type simply never sends
 *  it. A candidate componente WAS found (código `502`, matched código-33 ventas IVA EXACTLY in
 *  two independent months: 168.332.278 / 171.725.880) — but it is the RAW, un-netted figure
 *  (SII's own `511` on the crédito side is already netted; `502` is not). No código in the
 *  observed set reliably supplies "Notas de Crédito emitidas IVA" to net it against: código `510`
 *  looked plausible but was off by 199.507 / 6.883 in the same two months — NOT the same figure,
 *  just numerically close, and this taxpayer has real ventas-side NC every single month observed
 *  (so there is no clean period to isolate it further). Wiring `502` alone as the débito fallback
 *  would silently UNDER-net every month by exactly that NC IVA — reproducing, on the débito side,
 *  the identical raw-vs-netted bug `TIPOS_REVERSA` exists to prevent on crédito (ADR-022
 *  revision). Per ADR-004 / the project's "never a silently wrong figure over a legal/monetary
 *  one" rule (giros, ADR-034), the fallback stays EMPTY rather than ship an unsafe guess. Needs
 *  either a taxpayer/período where 538 IS observed, or an unambiguous NC-ventas-IVA componente —
 *  see `docs/BACKLOG.md` §3.1. */
const COD_CREDITO_FALLBACK = ['511'] as const;
const COD_DEBITO_FALLBACK: readonly string[] = []; // deliberately empty — see above (P3)

/** Inter-request pace (ms) for the fan-out — never hammer SII (ADR-004). */
const pacingMs = (): number => Math.round(1000 / DEFAULT_SETTINGS.rateLimitRps);

function audit(runtime: Runtime, action: string, result: string, extra: Partial<AuditEntry>): void {
  recordAudit(runtime, { action, result, ...extra });
}

/** One DTE type's contribution to a side, carried so a mismatch can be LOCATED rather than
 *  just detected — one aggregate number would hide the actionable part (ADR-022). */
export interface IvaTipoDoc {
  readonly codigoTipoDoc: string | null;
  readonly descripcion: string | null;
  readonly totalDocumentos: number | null;
  readonly montoNeto: number | null;
  readonly montoExento: number | null;
  readonly montoIva: number | null;
  readonly montoTotal: number | null;
}

/** One side of the ledger (compras or ventas) for the período, aggregated from the RCV resumen. */
export interface IvaLado {
  readonly documentos: number | null;
  readonly neto: number | null;
  readonly exento: number | null;
  readonly iva: number | null;
  readonly total: number | null;
  readonly porTipo: readonly IvaTipoDoc[];
}

/** The F29 half: SII's own propuesta totals. `null` when there is no propuesta for the month. */
export interface IvaF29 {
  readonly tienePropuesta: boolean;
  /** Código 538 TOTAL DÉBITOS. */
  readonly debito: number | null;
  /** Código 537 TOTAL CRÉDITOS. */
  readonly credito: number | null;
}

/** Ledger vs propuesta, per side. Deltas are RCV MINUS F29, so a positive delta means the
 *  ledger shows more than the propuesta. A `null` on either side yields a `null` delta — never
 *  0: "SII returned nothing" and "SII returned zero" are different facts to a contador. */
export interface IvaReconciliacion {
  readonly debitoRcv: number | null;
  readonly debitoF29: number | null;
  /** Which F29 código supplied `debitoF29` (`538`, or a component fallback), null when none did.
   *  Surfaced so the user can see WHAT was compared, not just the delta. */
  readonly debitoCodigo: string | null;
  readonly deltaDebito: number | null;
  readonly creditoRcv: number | null;
  readonly creditoF29: number | null;
  readonly creditoCodigo: string | null;
  readonly deltaCredito: number | null;
  /** Per-side verdict. `true` agree · `false` genuine discrepancy · **`null` indeterminable**
   *  (SII's propuesta carried no comparable figure). The null state exists because reporting
   *  `false` for an absent figure reads as "your books disagree" when the truth is "SII gave no
   *  such number" — live-validation finding, 2026-07-26. */
  readonly cuadraDebito: boolean | null;
  readonly cuadraCredito: boolean | null;
  /** Overall: `false` if either side genuinely disagrees (a real discrepancy outranks an
   *  indeterminable one), else `null` if either side is indeterminable, else `true`. */
  readonly cuadra: boolean | null;
}

export interface IvaMensual {
  readonly rut: string;
  readonly periodo: string; // YYYY-MM
  /** Fase 1 reconciles against SII's SUGGESTION, not the filed form (ADR-013 defers Fase 2). */
  readonly fuente: 'propuesta';
  readonly compras: IvaLado;
  readonly ventas: IvaLado;
  readonly f29: IvaF29;
  readonly reconciliacion: IvaReconciliacion;
  /** True when this result came from the local cache instead of SII (ADR-027). An open period is
   *  never cached, so this is always false for the current month. */
  readonly cached: boolean;
}

/** Bump when the curated shape OR its computation changes so cached entries self-invalidate
 *  (ADR-027). v2 (2026-07-28): `ladoFrom` now nets Notas de Crédito (see `TIPOS_REVERSA`) — a
 *  v1 cache entry holds figures computed with the old straight-sum bug and must not be served
 *  as if it were re-read. */
const IVA_CACHE_VERSION = 2;

/** Reject a representing operate pointer BEFORE opening a session (ADR-005 / ADR-022). Mirrors
 *  `f29Formulario` / `bteList`: the empresa RUT is already user-visible via `operate --list` so
 *  it is safe to echo; the razón social is PII and is NOT included. */
async function assertSelfOperating(runtime: Runtime): Promise<void> {
  const op = await readOperateState(runtime.store);
  if (op && op.operatingRut !== op.selfRut) {
    throw new F29Error(
      `El cuadre de IVA es session-keyed: combina el RCV con el F29, y el SII autoriza el F29 ` +
        `por el titular de la sesión, no por el RUT operado (${Rut.parse(op.operatingRut).formatted}). ` +
        'Para el IVA de esa empresa, inicia sesión como ella (`sii auth logout` y luego `sii auth login`).',
    );
  }
}

/** DTE type codes whose monto REVERSES a prior document instead of adding a new one.
 *
 *  CRÉDITO (compras) side — OBSERVED live (2026-07-28, a second real taxpayer account): a Nota
 *  de Crédito Electrónica (61) recibida reduces a prior purchase, and SII's own F29 propuesta
 *  componente (código 511) already nets it out. Summed straight (the pre-fix bug) against 16
 *  real months, the delta against 511 was ALWAYS exactly 2× that month's NC IVA — including one
 *  month with zero NC, where the delta was exactly zero.
 *
 *  DÉBITO (ventas) side — NOT independently observed against a real código 538: this taxpayer's
 *  propuesta never carried 538 in any period read (§3.1 in `docs/BACKLOG.md` — the débito
 *  fallback is still unobserved). Netting 61 on ventas here rests on the same accounting fact
 *  (a Nota de Crédito emitida reduces a prior sale) rather than a live 538 comparison; treat it
 *  as inferred, not confirmed, until a taxpayer with an observed 538 verifies it.
 *
 *  Extend this set only with a citation when a NEW reversing DTE type is observed (ADR-004); do
 *  not guess at the official SII type table. See `docs/BACKLOG.md` §3.5 and ADR-022's revision
 *  note. */
const TIPOS_REVERSA: ReadonlySet<string> = new Set(['61']);

/** Sum a monetary column across the resumen rows, NETTING OUT reversing DTE types (see
 *  `TIPOS_REVERSA`) so the total matches what SII's own propuesta componentes report — not a
 *  straight sum, which double-counts a Nota de Crédito's effect (added here, already
 *  subtracted by SII). All-null (or no rows) sums to 0 — an empty month is a real zero, unlike
 *  an ABSENT propuesta, which stays null. */
const sumMonto = (
  rows: readonly RcvResumenRow[],
  pick: (r: RcvResumenRow) => number | null,
): number =>
  rows.reduce((acc, r) => {
    const sign = TIPOS_REVERSA.has(r.codigoTipoDoc ?? '') ? -1 : 1;
    return acc + sign * (pick(r) ?? 0);
  }, 0);

/** Sum a column that counts real documents (never netted — a Nota de Crédito is still one
 *  document received, even though its monto reverses another). */
const sumCount = (
  rows: readonly RcvResumenRow[],
  pick: (r: RcvResumenRow) => number | null,
): number => rows.reduce((acc, r) => acc + (pick(r) ?? 0), 0);

function ladoFrom(resumen: RcvResumen): IvaLado {
  const rows = resumen.rows;
  return {
    // The envelope's own `totDocRes` when SII sent one, else the row sum. Document COUNTS are
    // never netted (a reversing NC is still one real document).
    documentos: resumen.totalDocumentos ?? sumCount(rows, (r) => r.totalDocumentos),
    neto: sumMonto(rows, (r) => r.montoNeto),
    exento: sumMonto(rows, (r) => r.montoExento),
    iva: sumMonto(rows, (r) => r.montoIva),
    total: sumMonto(rows, (r) => r.montoTotal),
    // porTipo keeps each type's RAW magnitude (not netted) — a contador needs to SEE the
    // reversing document to understand why the side total is lower than its face-value sum.
    porTipo: rows.map((r) => ({
      codigoTipoDoc: r.codigoTipoDoc,
      descripcion: r.descripcion,
      totalDocumentos: r.totalDocumentos,
      montoNeto: r.montoNeto,
      montoExento: r.montoExento,
      montoIva: r.montoIva,
      montoTotal: r.montoTotal,
    })),
  };
}

/** Read one código's value off the propuesta; absent ⇒ null (never 0). */
const codigoValor = (codigos: readonly CodigoF29[], codigo: string): number | null =>
  codigos.find((c) => c.codigo === codigo)?.valor ?? null;

/** Resolve one side's F29 figure: the TOTAL código when SII sent it, else the first observed
 *  component fallback. Returns which código answered, so the result can say what was compared. */
function resolveLado(
  codigos: readonly CodigoF29[],
  total: string,
  fallbacks: readonly string[],
): { valor: number | null; codigo: string | null } {
  for (const codigo of [total, ...fallbacks]) {
    const valor = codigoValor(codigos, codigo);
    if (valor !== null) return { valor, codigo };
  }
  return { valor: null, codigo: null };
}

/** RCV minus F29, or null when either side is absent. */
const delta = (rcv: number | null, f29: number | null): number | null =>
  rcv === null || f29 === null ? null : rcv - f29;

/** Per-side verdict. Mirrors the empty-month rule established for `honorarios`: absent-vs-zero
 *  AGREES (nothing against nothing is not a discrepancy), absent-vs-nonzero is INDETERMINABLE
 *  (we cannot substantiate a mismatch against a figure SII never gave), both present compares. */
function cuadraLado(rcv: number | null, f29: number | null): boolean | null {
  if (f29 === null) {
    if (rcv === null || rcv === 0) return true; // nothing vs nothing
    return null; // ledger shows movement, SII gave no comparable figure ⇒ unknown
  }
  if (rcv === null) return f29 === 0;
  return rcv === f29;
}

/** Combine the two sides. A real discrepancy outranks an indeterminable one — the user must see
 *  `false` when something genuinely disagrees, even if the other side is unknown. */
function cuadraGlobal(a: boolean | null, b: boolean | null): boolean | null {
  if (a === false || b === false) return false;
  if (a === null || b === null) return null;
  return true;
}

/** Monthly VAT reconciliation for the session principal: the RCV ledger's IVA on both sides
 *  against SII's own F29 propuesta totals (códigos 538 / 537), with the per-DTE-type breakdown
 *  kept so a mismatch can be located. ONE session, paced, never retried (ADR-022).
 *
 *  Débito = IVA on VENTAS; crédito = IVA on COMPRAS. A missing propuesta or an empty ledger
 *  month is DATA (null / zero respectively), not an error — only a session-level failure aborts. */
export async function ivaMensual(
  runtime: Runtime,
  args: { periodo: string; refresh?: boolean },
): Promise<IvaMensual> {
  const periodo = Periodo.parse(args.periodo); // fail fast on a bad período — no session opened
  await assertSelfOperating(runtime);
  const start = runtime.clock.now().getTime();
  // Cache key needs the principal RUT, read from LOCAL state — `readSession` costs no browser, so
  // a warm read never launches Chromium, which is the entire point of ADR-027.
  const stored = await readSession(runtime.store);
  const cacheKey = {
    task: 'iva',
    rut: stored?.rut ?? 'anon',
    scope: periodo.canonical,
  };
  const cacheOpts = {
    closed: scopeIsClosed(periodo.canonical, runtime.clock),
    version: IVA_CACHE_VERSION,
    ...(args.refresh !== undefined ? { refresh: args.refresh } : {}),
  };
  try {
    const { value: res, fromCache } = await cachedRead(runtime, cacheKey, cacheOpts, () =>
      withSession(runtime, async (session, ctx) => {
        // Session-keyed: every leg reads the PRINCIPAL, including the (body-RUT) RCV one.
        const rut = Rut.parse(ctx.sessionRut);

        const compras = await fetchRcvResumen(session, { rut, periodo, side: 'COMPRA' });
        await runtime.clock.sleep(pacingMs());
        const ventas = await fetchRcvResumen(session, { rut, periodo, side: 'VENTA' });
        await runtime.clock.sleep(pacingMs());
        const propuesta = await fetchF29Propuesta(session, { rut, periodo });

        const ladoCompras = ladoFrom(compras);
        const ladoVentas = ladoFrom(ventas);
        // Resolve each side: the TOTAL código when SII sent it, else an OBSERVED component
        // fallback. No propuesta at all ⇒ both unresolved (ADR-022 revision, live 2026-07-26).
        const debito = propuesta.tienePropuesta
          ? resolveLado(propuesta.codigos, COD_TOTAL_DEBITOS, COD_DEBITO_FALLBACK)
          : { valor: null, codigo: null };
        const credito = propuesta.tienePropuesta
          ? resolveLado(propuesta.codigos, COD_TOTAL_CREDITOS, COD_CREDITO_FALLBACK)
          : { valor: null, codigo: null };
        const debitoF29 = debito.valor;
        const creditoF29 = credito.valor;
        const deltaDebito = delta(ladoVentas.iva, debitoF29);
        const deltaCredito = delta(ladoCompras.iva, creditoF29);
        const cuadraDebito = cuadraLado(ladoVentas.iva, debitoF29);
        const cuadraCredito = cuadraLado(ladoCompras.iva, creditoF29);

        return {
          rut: rut.canonical,
          periodo: periodo.formatted,
          fuente: 'propuesta',
          compras: ladoCompras,
          ventas: ladoVentas,
          f29: {
            tienePropuesta: propuesta.tienePropuesta,
            debito: debitoF29,
            credito: creditoF29,
          },
          reconciliacion: {
            debitoRcv: ladoVentas.iva,
            debitoF29,
            debitoCodigo: debito.codigo,
            deltaDebito,
            creditoRcv: ladoCompras.iva,
            creditoF29,
            creditoCodigo: credito.codigo,
            deltaCredito,
            cuadraDebito,
            cuadraCredito,
            cuadra: cuadraGlobal(cuadraDebito, cuadraCredito),
          },
          cached: false, // overwritten below when served from disk
        } satisfies IvaMensual;
      }),
    );

    // Receipt: the period, whether it balanced, and whether SII was actually consulted. NEVER a
    // monto (ADR-006) — the whole point of this task is amounts, and none belong on the receipt.
    // `cached` matters: a receipt must not imply a portal read that did not happen (ADR-027).
    audit(runtime, 'iva_mensual', 'ok', {
      rut: res.rut,
      period: periodo.canonical,
      cuadra: res.reconciliacion.cuadra,
      cached: fromCache,
      durationMs: runtime.clock.now().getTime() - start,
    });
    return { ...res, cached: fromCache };
  } catch (e) {
    audit(runtime, 'iva_mensual', 'failed', { period: periodo.canonical });
    throw e;
  }
}
