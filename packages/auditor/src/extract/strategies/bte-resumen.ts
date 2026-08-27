// `bte-resumen` — the BHE monthly totals (ADR-043).
//
// Parses the `xml_values` inline map of the legacy `loa.sii.cl/cgi_IMT/` report (ADR-020's
// inline-JS-map family). The recorder captured it as the RESULT of the facade's `evaluate` call,
// which is why a DOM-driven surface is measurable at all: the rendered DOM was never captured, but
// the map the page fills its cells from was.
//
// SELF-ATTRIBUTING: the map carries `anio_consulta` + `mes_consulta`, so an artifact identifies its
// own período without the request. (F29 does NOT — hence `FetchManifest.requestFingerprint`.)
//
// PII — THE LOAD-BEARING PART. `xml_values` also carries `nombre_contribuyente` and
// `rut_arrastre`/`dv_arrastre`: the taxpayer's OWN identity. The facade never reads them (live
// BUG-1, 2026-06-30 — the reason BTE exposes no `raw` at all), and neither does this. Only the
// `suma_*` aggregates, the counts and the page cursor leave here; a test pins that.
//
// `suma_retencion_receptor` IS the reconciled figure: it plus BPST's retenido equals F29 código 151.
// `suma_retencion_emisor` is the contractor's OWN withholding — reported, never reconciled
// (ADR-023 trap 1). Both are surfaced separately; summing them manufactures a false mismatch.

import {
  asInteger,
  asMonto,
  artifactProvenance,
  failureOf,
  isObj,
  recordOf,
  refOf,
} from './common.js';
import type { ConfidenceSignal, ExtractionOutcome } from '../record.js';
import type { ExtractionContext, ExtractionStrategy } from '../strategy.js';

const REF = refOf('bte-resumen', 1);

/** Own-identity keys that must NEVER reach the extract. Exported so a test asserts the denylist. */
export const BTE_RESUMEN_PII_KEYS: ReadonlySet<string> = new Set([
  'nombre_contribuyente',
  'rut_arrastre',
  'dv_arrastre',
]);

export interface BteResumenExtract {
  /** `YYYY-MM`, from the map's own `anio_consulta`/`mes_consulta`. */
  readonly periodo: string | null;
  readonly pagina: number | null;
  /** Boletas on THIS page; `totalBoletas` is the month's declared total. */
  readonly cantBoletas: number | null;
  readonly totalBoletas: number | null;
  readonly honorarios: number | null;
  /** Withheld BY the taxpayer as receptor — the half that reconciles to F29 151. */
  readonly retencionReceptor: number | null;
  /** Withheld by the contractor for themselves — reported, NOT reconciled (ADR-023). */
  readonly retencionEmisor: number | null;
  readonly liquido: number | null;
}

export const bteResumenStrategy: ExtractionStrategy<BteResumenExtract> = {
  id: 'bte-resumen',
  version: 1,
  // The recorder names an `evaluate` artifact `evaluate:<fingerprint of the expression>`, so the
  // two maps the facade reads land under two different pseudo-URLs.
  scope: { url: /^evaluate:/, transports: ['goto'] },
  describes: 'BHE monthly aggregates from the report `xml_values` map (loa.sii.cl CGI)',

  async extract(ctx: ExtractionContext): Promise<ExtractionOutcome<BteResumenExtract>> {
    const provenance = artifactProvenance(ctx, REF, 'xml_values');

    let map: unknown;
    try {
      map = JSON.parse(ctx.bytes.toString('utf8'));
    } catch {
      // An `evaluate` result is always JSON-serialised by the recorder; non-JSON is a real fault.
      return {
        records: [],
        failures: [failureOf(ctx, REF, provenance, 'el resultado no es JSON')],
      };
    }

    // Every `evaluate:` artifact matches the scope, but only the `xml_values` one is ours. A map
    // without the aggregate keys is the OTHER map (`arr_informe_mensual`) — not an error, just not
    // this strategy's artifact. Emitting nothing is the correct answer, and it must NOT be a
    // failure: counting it as one would make extraction accuracy look worse every month.
    if (!isObj(map) || map['suma_honorarios'] === undefined) {
      return { records: [], failures: [] };
    }

    const signals: ConfidenceSignal[] = [];
    const anio = asText(map['anio_consulta']);
    const mes = asText(map['mes_consulta']);
    const periodo = anio !== null && mes !== null ? `${anio}-${mes.padStart(2, '0')}` : null;
    if (periodo === null) {
      signals.push({
        code: 'missing_field',
        field: 'periodo',
        detail: 'faltan anio_consulta / mes_consulta — el artefacto no se puede atribuir',
      });
    }

    const value: BteResumenExtract = {
      periodo,
      pagina: asInteger(map['pagina_actual']),
      cantBoletas: asInteger(map['cant_boletas']),
      totalBoletas: asInteger(map['total_boletas']),
      honorarios: asMonto(map['suma_honorarios'], 'honorarios', signals),
      retencionReceptor: asMonto(map['suma_retencion_receptor'], 'retencionReceptor', signals),
      // Absent on a RECIBIDAS report; `null` there is a real absence, not a doubt.
      retencionEmisor: asMonto(map['suma_retencion_emisor'], 'retencionEmisor', signals),
      liquido: asMonto(map['suma_liquido'], 'liquido', signals),
    };

    return {
      records: [recordOf(ctx, REF, provenance, signals, value, 'bte-resumen')],
      failures: [],
    };
  },
};

const asText = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : typeof v === 'number' ? String(v) : null;
