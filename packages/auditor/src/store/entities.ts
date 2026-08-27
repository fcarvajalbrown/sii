// The normalized domain model (ADR-043) — layer two of `store/`.
//
// SCOPE RULE, decided in ADR-043: these entities model ONLY what SII actually exposes. This
// project has no source for a client's own books, so there is no chart of accounts, no trial
// balance, and nothing that would let the system "generate" a balance sheet or P&L. `dj detalle`
// (ADR-031) READS the balance de 8 columnas SII already holds and deliberately does not interpret
// it semantically, because column meaning differs per DJ and one observation was not enough to be
// safe. `JournalEntry` below exists as the seam for real books IF a source ever appears — it is
// unpopulated today, and saying so is more useful than an empty table that looks authoritative.
//
// EVERY record carries `derivedFrom` — the extraction that produced it, which carries the artifact
// hash. A normalized row with no derivation is not representable, so "where did this number come
// from" always has an answer.
//
// MULTI-TAXPAYER from day one (ADR-043): engagements accumulate and the golden set is meaningless
// with one subject. Ingest stays one live session at a time — ADR-005 is untouched.

import type { ExtractionId } from '../extract/record.js';

/** Pseudonymous outside, real RUT inside — see `confidential.ts` for which side is which. */
export type TaxpayerRef = string;

/** `YYYYMM` for monthly surfaces (RCV, F29), `YYYY` for annual ones (F22, DJ). */
export type PeriodKey = string;

/** Common spine. Every normalized record is attributable and time-boxed. */
export interface Entity {
  readonly id: string;
  readonly taxpayer: TaxpayerRef;
  /** The extraction that produced this row — the join to provenance and confidence. */
  readonly derivedFrom: ExtractionId;
  /** When this row entered the store (from the `Clock` seam). */
  readonly recordedAt: string;
}

// ---------------------------------------------------------------------------
// Subject and time
// ---------------------------------------------------------------------------

export interface Taxpayer extends Entity {
  /** Full RUT with check digit, canonical (synthetic example `11111111-1`). INSIDE the boundary only. */
  readonly rut: string;
  readonly razonSocial: string | null;
  /** Observed at `situacion`/`profile` (`opc=112`, ADR-035/041). Anchors severity in `monitor`. */
  readonly fechaInicioActividades: string | null;
  /** Verbatim régimen code — `M14A`, `REGS`, `FAEL`, `SGGC` observed. Never a closed enum. */
  readonly regimen: string | null;
  /** True when authorised to declare F29 on day 20 rather than 12 (ADR-038). */
  readonly autorizadoDeclararDia20: boolean | null;
}

export interface Period extends Entity {
  readonly key: PeriodKey;
  readonly kind: 'mensual' | 'anual';
  /**
   * Whether the period is CLOSED — strictly in the past per the `Clock`. Mirrors ADR-027's rule:
   * an open period is live data and must never be cached, extracted-and-frozen, or reported as
   * settled.
   */
  readonly closed: boolean;
}

// ---------------------------------------------------------------------------
// Tax return forms
// ---------------------------------------------------------------------------

export interface TaxReturnForm extends Entity {
  readonly form: 'F22' | 'F29' | 'F50';
  readonly period: PeriodKey;
  readonly folio: string | null;
  /** SII's own estado string, VERBATIM. Never normalised to an enum — ADR-004. */
  readonly estado: string | null;
  readonly fechaPresentacion: string | null;
  /** True when this folio superseded an earlier one (rectificatoria). */
  readonly rectificatoria: boolean;
  /** Where the figures came from: SII's suggestion or the filed return (ADR-013). */
  readonly fuente: 'propuesta' | 'presentada';
}

/** One código/valor line of a return. Kept as rows, not columns — the código set is open. */
export interface FormLine extends Entity {
  readonly formId: string;
  readonly codigo: string;
  /** Integer pesos. `null` is a real absence and is NEVER coerced to 0 (a live gotcha). */
  readonly monto: number | null;
  /** SII's glosa when the taxonomy knows it; null when unmapped (surfaced, never dropped). */
  readonly glosa: string | null;
}

export interface Observacion extends Entity {
  readonly formId: string;
  /** `F121`, `B92`, `G37`… */
  readonly codigo: string;
  readonly descripcion: string | null;
  readonly ayudaUrl: string | null;
  readonly vigente: boolean;
}

// ---------------------------------------------------------------------------
// Ledgers and documents
// ---------------------------------------------------------------------------

export interface LedgerEntry extends Entity {
  readonly period: PeriodKey;
  readonly side: 'COMPRA' | 'VENTA';
  /** DTE type code as a string (`33`, `39`, `61`, `56`, `914`). Numeric-looking, not a number. */
  readonly tipoDoc: string;
  readonly folio: string;
  readonly fechaEmision: string | null;
  readonly montoNeto: number | null;
  readonly montoIva: number | null;
  readonly montoTotal: number | null;
  /**
   * Whether this DTE type REVERSES another (nota de crédito, `61`). Load-bearing: an aggregate
   * that sums resumen magnitudes without netting these disagrees with SII's own totals by exactly
   * the reversed amount and reads as a discrepancy that does not exist. That bug was live in
   * `iva` and cost 15 of 16 months to a phantom descuadre (CONVENTIONS, ADR-022 revisions).
   */
  readonly reversa: boolean;
  /** Acuse event code from `detEventoReceptor` — `A`/`C`/`P` observed (ADR-036). */
  readonly eventoReceptor: string | null;
}

export interface ElectronicInvoice extends Entity {
  readonly tipoDoc: string;
  readonly folio: string;
  readonly rutContraparte: string;
  readonly fechaEmision: string;
  readonly montoTotal: number | null;
  readonly direction: 'emitida' | 'recibida';
}

/**
 * A double-entry journal line. PRESENT AS A SEAM, UNPOPULATED TODAY — see the header note. Nothing
 * writes this until a real source of client books exists; the extractor for it does not exist and
 * inventing one would manufacture accounting records, which is the opposite of this project.
 */
export interface JournalEntry extends Entity {
  readonly date: string;
  readonly account: string;
  readonly debit: number | null;
  readonly credit: number | null;
  readonly description: string | null;
  /** The document this line books, when known. */
  readonly sourceDocument: string | null;
}

// ---------------------------------------------------------------------------
// Obligations and communications
// ---------------------------------------------------------------------------

export interface SwornStatement extends Entity {
  /** DJ number: `1835`, `1847`, `1879`, `1887`, `1926`, `1948` observed (ADR-030/031). */
  readonly numero: string;
  readonly anioTributario: string;
  readonly folio: string | null;
  /** Verbatim — the estado enum is NOT closed, so `monitor` matches `/observ/i` (ADR-037). */
  readonly estado: string;
  readonly anulada: boolean;
}

export interface Giro extends Entity {
  readonly folio: string;
  readonly formularioOrigen: string | null;
  readonly fechaEmision: string | null;
  readonly fechaVencimiento: string | null;
  /** Verbatim. WARNING: `"Vigente"` was observed alongside `Saldo: $0` — it describes the
   *  document, NOT non-payment. The debt signal is the SALDO (ADR-034/037). */
  readonly estado: string;
  readonly saldo: number | null;
  readonly moneda: string | null;
}

export interface Communication extends Entity {
  readonly externalId: string;
  readonly categoria: 'formal' | 'correspondencia';
  /** Type code only. The free-text description is NOT persisted here — ADR-024's rule. */
  readonly tipo: string;
  readonly fecha: string | null;
  readonly vigente: boolean;
  /** `codCarta` for the PDF, when SII exposed one (ADR-042). */
  readonly codCarta: string | null;
}

/** Discriminated union of everything the normalized store holds, for generic traversal. */
export type AnyEntity =
  | Taxpayer
  | Period
  | TaxReturnForm
  | FormLine
  | Observacion
  | LedgerEntry
  | ElectronicInvoice
  | JournalEntry
  | SwornStatement
  | Giro
  | Communication;

export type EntityKind =
  | 'taxpayer'
  | 'period'
  | 'taxReturnForm'
  | 'formLine'
  | 'observacion'
  | 'ledgerEntry'
  | 'electronicInvoice'
  | 'journalEntry'
  | 'swornStatement'
  | 'giro'
  | 'communication';
