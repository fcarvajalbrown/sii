// `rcv-resumen` — parses `getResumen` (RCV per-tipo aggregates), the first strategy for a surface
// the fetch plan sweeps beyond the F29 propuesta (6 artifacts per 3-month sweep: COMPRA + VENTA
// per período).
//
// Shape observed FIRST-HAND on the six live artifacts of run-2026-08-12T12-39-34-503Z
// (www4.sii.cl/consdcvinternetui/services/data/facadeService/getResumen): rows under `data[]` with
// `rsmn*`/`dcv*` keys, the período and side echoed in `dataCabecera` (`dcvPtributario`,
// `dcvOperacion`), and a top-level `totDocRes` cross-checkable against the row counts. The alias
// tuples mirror core's `portal/rcv.ts` RESUMEN_ALIASES (the projection template, CONVENTIONS) so a
// divergence between facade and strategy shows up as an accuracy drop rather than hiding.
//
// ROWS STAY RAW MAGNITUDES. The ADR-022 phantom-descuadre bug came from AGGREGATING resumen rows
// without netting Nota de Crédito (tipo 61). That netting is a RULE's judgment, not a parser's:
// this strategy surfaces each tipo verbatim and computes no aggregate a rule could mistake for a
// netted figure.
//
// PII: `dataCabecera` carries the taxpayer's own RUT (`dcvRutEmisor`/`dcvDvEmisor`) — ONLY
// `dcvPtributario` and `dcvOperacion` are read, nothing else. Rows are per-tipo totals with no
// counterparty data. No `raw` (ADR-028 made even the facade's raw opt-in).

import type { ConfidenceSignal } from '../record.js';
import type { ExtractionContext, ExtractionStrategy } from '../strategy.js';
import type { ExtractionOutcome } from '../record.js';
import { artifactProvenance, asInteger, failureOf, isObj, recordOf, refOf } from './common.js';

const REF = refOf('rcv-resumen', 1);

/** Mirrors core `portal/rcv.ts` RESUMEN_ALIASES — observed name FIRST (ADR-004/011). */
const ALIASES = {
  codigoTipoDoc: ['rsmnTipoDocInteger', 'codTipoDoc', 'codigoTipoDoc', 'tipoDoc'],
  descripcion: ['dcvNombreTipoDoc', 'descTipoDoc', 'glosaTipoDoc', 'descripcion'],
  totalDocumentos: ['rsmnTotDoc', 'totDoctos', 'totalDoctos', 'totalDocumentos'],
  montoExento: ['rsmnMntExe', 'mntExento', 'montoExento'],
  montoNeto: ['rsmnMntNeto', 'mntNeto', 'montoNeto'],
  montoIva: ['rsmnMntIVA', 'mntIVA', 'montoIVA', 'mntIva'],
  montoTotal: ['rsmnMntTotal', 'mntTotal', 'montoTotal'],
} as const;

/** Row keys observed live 2026-08-12 (plus the alias alternates above). Others → `unknown_keys`. */
const KNOWN_ROW_KEYS = new Set([
  ...Object.values(ALIASES).flat(),
  'dcvCodigo',
  'dcvOperacion',
  'dcvTipoIngresoDoc',
  'rsmnCodigo',
  'rsmnEstadoContab',
  'rsmnFechModificacion',
  'rsmnIVAUsoComun',
  'rsmnLink',
  'rsmnMntIVANoRec',
  'rsmnTotalRutEmisor',
]);

/** Sides observed live (`dcvOperacion`). Anything else is out of observed range, never trusted. */
const SIDES = new Set(['COMPRA', 'VENTA'] as const);

export interface RcvResumenTipo {
  readonly descripcion: string | null;
  readonly totalDocumentos: number | null;
  readonly montoExento: number | null;
  readonly montoNeto: number | null;
  readonly montoIva: number | null;
  readonly montoTotal: number | null;
}

export interface RcvResumenExtract {
  /** `YYYYMM` from `dataCabecera.dcvPtributario`; `null` when unreadable (signalled). */
  readonly periodo: string | null;
  /** From `dataCabecera.dcvOperacion`; `null` when absent or outside the observed set. */
  readonly side: 'COMPRA' | 'VENTA' | null;
  /** Per-tipo RAW magnitudes keyed by DTE type (`'33'`, `'61'`…) — stable ExpectedField paths. */
  readonly tipos: Readonly<Record<string, RcvResumenTipo>>;
  /** SII's own `totDocRes`, cross-checked against the row counts (`internal_total_mismatch`). */
  readonly totalDocumentos: number | null;
  readonly totalTipos: number;
}

export const rcvResumenStrategy: ExtractionStrategy<RcvResumenExtract> = {
  id: 'rcv-resumen',
  version: 1,
  scope: { url: 'facadeService/getResumen', transports: ['requestJson'] },
  describes: 'RCV resumen — per-tipo aggregates for one período × side (COMPRA/VENTA), ADR-022',

  async extract(ctx: ExtractionContext): Promise<ExtractionOutcome<RcvResumenExtract>> {
    const provenance = artifactProvenance(ctx, REF, '/data');
    const fail = (message: string): ExtractionOutcome<RcvResumenExtract> => ({
      records: [],
      failures: [failureOf(ctx, REF, provenance, message)],
    });

    let envelope: unknown;
    try {
      envelope = JSON.parse(ctx.bytes.toString('utf8'));
    } catch (err) {
      return fail(`respuesta no es JSON: ${(err as Error).message}`);
    }
    if (!isObj(envelope)) return fail('la envoltura SDI no es un objeto');

    // The SDI error envelope: a non-OK codRespuesta is SII's own refusal, surfaced VERBATIM
    // (ADR-004) — a failure, not a low-confidence record. OK mirrors the facade's RCV_OK
    // (`portal/rcv.ts`, observed live 2026-06-28): código 3 = a VALID consulta with no
    // movimientos (`data` empty) — routine for a período without compras or ventas, never a
    // parser failure (a month registered as FAILURE here would poison the gate metrics and,
    // per ADR-046 "attempted", never be re-extracted).
    const RESP_OK = new Set<unknown>([0, '0', 3, '3']);
    const respEstado = envelope['respEstado'];
    if (isObj(respEstado)) {
      const cod = respEstado['codRespuesta'];
      if (cod !== null && cod !== undefined && !RESP_OK.has(cod)) {
        const msge = respEstado['msgeRespuesta'];
        return fail(`respEstado ${String(cod)}: ${typeof msge === 'string' ? msge : '(sin mensaje)'}`);
      }
    }

    const signals: ConfidenceSignal[] = [];
    const { periodo, side } = readCabecera(envelope, signals);

    const data = envelope['data'];
    // Empty `data:[]` is a legitimate "sin documentos" (CONVENTIONS); a NON-array is a shape this
    // parser has never seen and refuses loudly.
    if (!Array.isArray(data)) return fail('`data` no es un arreglo');

    const tipos: Record<string, RcvResumenTipo> = {};
    let sumDocs: number | null = 0;
    for (const row of data) {
      if (!isObj(row)) continue;

      const codigo = aliasGet(row, ALIASES.codigoTipoDoc, 'codigoTipoDoc', signals);
      if (codigo === null) {
        signals.push({ code: 'missing_field', field: 'codigoTipoDoc', detail: 'fila sin tipo' });
        continue;
      }
      const key = String(codigo);
      if (Object.hasOwn(tipos, key)) {
        signals.push({
          code: 'structural_drift',
          field: `tipos.${key}`,
          detail: 'tipo de documento repetido en el resumen',
        });
      }

      const int = (field: keyof typeof ALIASES): number | null => {
        const raw = aliasGet(row, ALIASES[field], field, signals);
        const v = asInteger(raw);
        if (raw !== null && raw !== undefined && v === null) {
          signals.push({
            code: 'unparseable_value',
            field: `tipos.${key}.${field}`,
            detail: `valor no numérico: ${JSON.stringify(raw)}`,
          });
        }
        return v;
      };

      const totalDocumentos = int('totalDocumentos');
      const desc = aliasGet(row, ALIASES.descripcion, 'descripcion', signals);
      tipos[key] = {
        descripcion: typeof desc === 'string' ? desc : null,
        totalDocumentos,
        montoExento: int('montoExento'),
        montoNeto: int('montoNeto'),
        montoIva: int('montoIva'),
        montoTotal: int('montoTotal'),
      };

      // The sum is only claimable when EVERY row count parsed — a null makes it unverifiable,
      // which the null's own signal already says.
      sumDocs = sumDocs === null || totalDocumentos === null ? null : sumDocs + totalDocumentos;

      for (const rowKey of Object.keys(row)) {
        if (!KNOWN_ROW_KEYS.has(rowKey)) {
          signals.push({
            code: 'unknown_keys',
            field: `tipos.${key}`,
            detail: `clave no observada: ${rowKey}`,
          });
        }
      }
    }

    // The BPST lesson (ADR-029): a total that disagrees with its own rows is not a rounding issue.
    const totalDocumentos = asInteger(envelope['totDocRes']);
    if (totalDocumentos !== null && sumDocs !== null && totalDocumentos !== sumDocs) {
      signals.push({
        code: 'internal_total_mismatch',
        field: 'totalDocumentos',
        detail: `totDocRes=${String(totalDocumentos)} pero la suma de filas es ${String(sumDocs)}`,
      });
    }

    return {
      records: [
        recordOf(
          ctx,
          REF,
          provenance,
          signals,
          { periodo, side, tipos, totalDocumentos, totalTipos: Object.keys(tipos).length },
          'rcv-resumen',
        ),
      ],
      failures: [],
    };
  },

  // NO `toEntities` yet, deliberately: resumen rows are per-tipo AGGREGATES and the entity model
  // has no aggregate kind (`LedgerEntry` is per DOCUMENT — that is the detalle surface). The stage
  // reports these records under `unprojected`, which is the honest state until either an aggregate
  // entity kind is decided or the detalle surface (with real per-document rows) is swept.
};

/** Read ONLY the período and side from `dataCabecera` — the own-RUT fields are never touched. */
function readCabecera(
  envelope: Record<string, unknown>,
  signals: ConfidenceSignal[],
): { periodo: string | null; side: 'COMPRA' | 'VENTA' | null } {
  const cab = envelope['dataCabecera'];
  if (!isObj(cab)) {
    signals.push({
      code: 'structural_drift',
      field: 'dataCabecera',
      detail: 'la cabecera no está — período y operación son inderivables',
    });
    return { periodo: null, side: null };
  }

  let periodo: string | null = null;
  const rawPeriodo = cab['dcvPtributario'];
  if (rawPeriodo === null || rawPeriodo === undefined) {
    signals.push({
      code: 'structural_drift',
      field: 'periodo',
      detail: 'dcvPtributario no está en dataCabecera',
    });
  } else if (/^(?:19|20)\d{2}(?:0[1-9]|1[0-2])$/.test(String(rawPeriodo))) {
    periodo = String(rawPeriodo);
  } else {
    signals.push({
      code: 'unparseable_value',
      field: 'periodo',
      detail: `dcvPtributario no es un período YYYYMM: ${JSON.stringify(rawPeriodo)}`,
    });
  }

  let side: 'COMPRA' | 'VENTA' | null = null;
  const rawSide = cab['dcvOperacion'];
  if (rawSide === null || rawSide === undefined) {
    signals.push({
      code: 'structural_drift',
      field: 'side',
      detail: 'dcvOperacion no está en dataCabecera',
    });
  } else if (typeof rawSide === 'string' && SIDES.has(rawSide as 'COMPRA' | 'VENTA')) {
    side = rawSide as 'COMPRA' | 'VENTA';
  } else {
    // An unobserved operación must not be trusted as a ledger side — COMPRA vs VENTA decides
    // whether a monto is crédito or débito, the one direction that must never be guessed.
    signals.push({
      code: 'out_of_observed_range',
      field: 'side',
      detail: `dcvOperacion fuera de lo observado: ${JSON.stringify(rawSide)}`,
    });
  }

  return { periodo, side };
}

/**
 * Alias-tolerant lookup. Matching a NON-primary alias means SII renamed a key and the code's
 * primary is now stale — a real, reportable doubt (ADR-011), not a silent success.
 */
function aliasGet(
  row: Record<string, unknown>,
  aliases: readonly string[],
  field: string,
  signals: ConfidenceSignal[],
): unknown {
  for (let i = 0; i < aliases.length; i += 1) {
    const key = aliases[i];
    if (key !== undefined && row[key] !== undefined) {
      if (i > 0) {
        signals.push({
          code: 'alias_fallback',
          field,
          detail: `usó el alias '${key}' en vez de '${aliases[0]}'`,
        });
      }
      return row[key];
    }
  }
  return null;
}
