// `bpst-pagina` — ONE PAGE of the BPST monthly report (ADR-043, over ADR-029).
//
// Boleta de Prestación de Servicios de Terceros Electrónica: `zeus.sii.cl/cvc_cgi/bte/`, a
// form-POST answering plain HTML. A DIFFERENT SII product from `bte` despite SII's own UI calling
// both "BTE" (ADR-029's naming collision).
//
// THE NAME SAYS `pagina` FOR A REASON — this is the ADR-029 trap encoded in the type. The
// `(*)Totales` row is PER PAGE, not per month: reading page 1 of a real March alone under-counted
// the retención by 44.5%. So this strategy reports what ONE page says and nothing more; summing
// pages into a month is the task layer's job (`portal/bpst.ts` walks and sums). Keeping the
// aggregation out of the parser means extraction accuracy measures PARSING, and a pagination bug
// shows up where it belongs — in the reconciliation, not hidden inside a parser's total.
//
// SELF-ATTRIBUTING: the page carries hidden inputs `ANOM`, `MESM` and `PAGINA`.
//
// NO ROWS ARE EMITTED. A BPST row mixes the worker's identity with the taxpayer's own on both sides
// (ADR-029 inherits BTE's live BUG-1 posture: no `raw`, curated only). The page AGGREGATES are what
// reconcile against F29 código 151, so that is all this parser takes.

import { asInteger, asMonto, artifactProvenance, failureOf, recordOf, refOf } from './common.js';
import type { ConfidenceSignal, ExtractionOutcome } from '../record.js';
import type { ExtractionContext, ExtractionStrategy } from '../strategy.js';

const REF = refOf('bpst-pagina', 1);

export interface BpstPaginaExtract {
  /** `YYYY-MM`, from the page's own `ANOM`/`MESM` hidden inputs. */
  readonly periodo: string | null;
  /** 1-based page number. The month's total is the SUM across pages — never this page alone. */
  readonly pagina: number | null;
  /** Gross total of THIS PAGE's boletas. */
  readonly brutos: number | null;
  /** Retenido on THIS PAGE — one half of what must reach F29 código 151 (ADR-029). */
  readonly retenidos: number | null;
  /** Paid to the workers on THIS PAGE. */
  readonly pagado: number | null;
}

export const bpstPaginaStrategy: ExtractionStrategy<BpstPaginaExtract> = {
  id: 'bpst-pagina',
  version: 1,
  scope: { url: 'bte_indiv_cons2', transports: ['requestForm'] },
  describes: 'BPST — the (*)Totales row of ONE result page (zeus.sii.cl form-POST HTML)',

  async extract(ctx: ExtractionContext): Promise<ExtractionOutcome<BpstPaginaExtract>> {
    const provenance = artifactProvenance(ctx, REF, '(*)Totales');
    const html = ctx.bytes.toString('utf8');

    if (html.trim() === '') {
      return { records: [], failures: [failureOf(ctx, REF, provenance, 'respuesta vacía')] };
    }

    const signals: ConfidenceSignal[] = [];

    const anio = hiddenInput(html, 'ANOM');
    const mes = hiddenInput(html, 'MESM');
    const periodo = anio !== null && mes !== null ? `${anio}-${mes.padStart(2, '0')}` : null;
    if (periodo === null) {
      signals.push({
        code: 'missing_field',
        field: 'periodo',
        detail: 'faltan los inputs ocultos ANOM / MESM — la página no se puede atribuir',
      });
    }

    const totals = totalesRow(html);
    if (totals === null) {
      // The row is the whole point of this artifact; without it there is nothing to extract, and
      // saying so loudly is the ADR-034 posture (fail noisily rather than return a wrong figure).
      return {
        records: [],
        failures: [
          failureOf(ctx, REF, provenance, 'no se encontró la fila (*)Totales — scraper roto'),
        ],
      };
    }
    if (totals.length !== 3) {
      signals.push({
        code: 'structural_drift',
        field: '(*)Totales',
        detail: `la fila trae ${totals.length} celdas, se esperaban 3 (brutos/retenidos/pagado)`,
      });
    }

    const value: BpstPaginaExtract = {
      periodo,
      pagina: asInteger(hiddenInput(html, 'PAGINA')),
      brutos: asMonto(totals[0], 'brutos', signals),
      retenidos: asMonto(totals[1], 'retenidos', signals),
      pagado: asMonto(totals[2], 'pagado', signals),
    };

    return {
      records: [recordOf(ctx, REF, provenance, signals, value, 'bpst-pagina')],
      failures: [],
    };
  },
};

/** Value of a hidden input by name. The page repeats some names across its two forms; the first
 *  occurrence is the query form, which is the one describing the result being shown. */
function hiddenInput(html: string, name: string): string | null {
  const re = new RegExp(`name=["']?${name}["']?[^>]*?value=["']?([^"'>\\s]*)`, 'i');
  const m = re.exec(html);
  return m?.[1] !== undefined && m[1] !== '' ? m[1] : null;
}

/**
 * The three right-aligned cells following the `(*)Totales` label.
 *
 * Anchored on the LABEL, not on a row index — a positional read would silently shift if SII
 * inserted a column, which is the exact silent-failure mode ADR-034 rejected. Returns `null` when
 * the label is absent so the caller can fail loudly.
 */
function totalesRow(html: string): readonly string[] | null {
  const start = html.search(/\(\*\)\s*Totales/i);
  if (start === -1) return null;

  // Take the remainder of the enclosing row: up to the closing </tr>.
  const rest = html.slice(start);
  const end = rest.search(/<\/tr>/i);
  const row = end === -1 ? rest : rest.slice(0, end);

  const cells: string[] = [];
  for (const m of row.matchAll(/<font[^>]*>([^<]*)<\/font>/gi)) {
    const text = (m[1] ?? '').replace(/&nbsp;/g, ' ').trim();
    // The label itself is inside a <font> too; keep only the numeric cells.
    if (/^-?[\d.]+$/.test(text)) cells.push(text);
  }
  return cells;
}
