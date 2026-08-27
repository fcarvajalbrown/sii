// `f29-propuesta` — the first extraction strategy (ADR-043).
//
// Parses the SDI-JSON response of `getDeclaracionConCondicionesYTipoPropuesta` (ADR-013 Fase 1)
// into the códigos of the IVA propuesta. This is the artifact carrying código 151 — the honorarios
// retención the 2026-07-29 audit reconciled — so it is the natural first parser to measure.
//
// WHY A SEPARATE PARSER RATHER THAN CALLING THE FACADE: `fetchF29Propuesta` takes a live
// `PortalSession` and issues the POST itself; a strategy is handed BYTES that were already fetched.
// The projection below deliberately mirrors the facade's (same alias tuples, same `data:null` =
// "sin propuesta" reading) so a divergence between them shows up as an accuracy drop rather than
// hiding. That mirroring is the thing the golden set actually tests.
//
// OUTPUT SHAPE IS A MAP, NOT AN ARRAY. `codigos` is `Record<código, valor>` so an `ExpectedField`
// path is `codigos.151` — stable — instead of `codigos[7].valor`, which would break the moment SII
// reorders its own list. Ordering is not something we want the golden set asserting.
//
// PII: `listCodBase` (identity: RUT, dirección, email) and the PP29 `traza` are refused, exactly
// as the facade refuses them (ADR-006) — with ONE deliberate exception since v2: código 15
// (período tributario) is read FROM `listCodBase`, because it is the period axis of the natural
// key `toEntities` projects on, and a período is not PII. Nothing else in the list is touched.

import { contentHash, instant } from '../../provenance.js';
import { scoreConfidence } from '../confidence.js';
import { entityId } from '../../store/normalized.js';
import type { ConfidenceSignal } from '../record.js';
import type { EntityProjectionContext, ExtractionContext, ExtractionStrategy } from '../strategy.js';
import type { ExtractionOutcome, ExtractionRecord } from '../record.js';
import type { AnyEntity, FormLine, TaxReturnForm } from '../../store/entities.js';

/** Mirrors `portal/f29.ts` CODIGO_ALIASES — observed name FIRST (ADR-004/011). */
const ALIASES = {
  codigo: ['codigo', 'cod'],
  valor: ['valor', 'monto'],
} as const;

/** Keys a propuesta row is known to carry. Anything else raises `unknown_keys`. */
const KNOWN_ROW_KEYS = new Set(['codigo', 'cod', 'valor', 'monto']);

/**
 * Códigos whose value is a RATE, fractionally-valued by nature — never an integer peso amount.
 * Observed live 2026-08-12 in a real propuesta (getDeclaracionConCondicionesYTipoPropuesta):
 * `{"codigo":"115","valor":"0.125"}` — tasa PPM. Under the integer-only rule this routed a whole
 * month to review over a value that was never a peso figure. Extend ONLY on a live observation
 * (ADR-004), never by assuming another código "looks like" a rate.
 */
const RATE_CODIGOS = new Set(['115']);

export interface F29PropuestaExtract {
  /** `Record<código, valor>` — integer PESOS only; `valor` is `null` when SII sent a non-numeric.
   *  Rate códigos never appear here — see `tasas`. */
  readonly codigos: Readonly<Record<string, number | null>>;
  /** Rate códigos (`RATE_CODIGOS`), decimal-parsed. A rate is a form parameter, not an amount. */
  readonly tasas: Readonly<Record<string, number | null>>;
  /** True only when at least one código has a non-zero value — the facade's own rule (the facade
   *  does not split rates out, so a non-zero rate counts here too). */
  readonly tienePropuesta: boolean;
  readonly tipoPropuesta: number | null;
  readonly estado: number | null;
  /** How many códigos were projected across `codigos` AND `tasas` — sealed ground truth counts
   *  raw `listCodPropuestos` rows, and every row lands in exactly one of the two maps. */
  readonly totalCodigos: number;
  /**
   * `YYYYMM`, from código 15 of `listCodBase` (the only header código read — see the PII note).
   * `null` when unreadable: a sin-propuesta (`data:null`, nothing to key) or a drifted header
   * (carries `structural_drift`, so the record routes to review instead of the store).
   */
  readonly periodo: string | null;
}

/** Version 3: rate códigos (115) split into `tasas` as decimals — the first review-queue finding
 *  from real data (2026-08-12). v2 added the período + entity projection; v1 is pinned by a
 *  persisted production eval result. Every behaviour change bumps, so metric shifts attribute. */
const REF = 'f29-propuesta@3';

export const f29PropuestaStrategy: ExtractionStrategy<F29PropuestaExtract> = {
  id: 'f29-propuesta',
  version: 3,
  scope: {
    url: 'getDeclaracionConCondicionesYTipoPropuesta',
    transports: ['requestJson'],
  },
  describes: 'F29 IVA propuesta — the proposed códigos for one período (ADR-013 Fase 1)',

  async extract(ctx: ExtractionContext): Promise<ExtractionOutcome<F29PropuestaExtract>> {
    const provenance = provenanceOf(ctx);

    let envelope: unknown;
    try {
      envelope = JSON.parse(ctx.bytes.toString('utf8'));
    } catch (err) {
      return fail(provenance, ctx, `respuesta no es JSON: ${(err as Error).message}`);
    }

    if (!isObj(envelope)) {
      return fail(provenance, ctx, 'la envoltura SDI no es un objeto');
    }

    const signals: ConfidenceSignal[] = [];
    const data = envelope['data'];

    // `data:null` is a LEGITIMATE "sin propuesta" for the período, not a parse failure (the facade
    // reads it the same way). No signal — an honest absence is not a doubt. There is no header to
    // read a período from either, so `periodo` is a true absence, never a drift.
    if (data === null || data === undefined) {
      return ok(provenance, ctx, signals, {
        codigos: {},
        tasas: {},
        tienePropuesta: false,
        tipoPropuesta: null,
        estado: null,
        totalCodigos: 0,
        periodo: null,
      });
    }

    if (!isObj(data)) {
      return fail(provenance, ctx, '`data` no es objeto ni null — forma inesperada');
    }

    const list = data['listCodPropuestos'];
    if (list === undefined) {
      signals.push({
        code: 'structural_drift',
        field: 'listCodPropuestos',
        detail: 'la clave no está en `data` — la app pudo renombrarla',
      });
    } else if (!Array.isArray(list)) {
      return fail(provenance, ctx, '`listCodPropuestos` no es un arreglo');
    }

    const codigos: Record<string, number | null> = {};
    const tasas: Record<string, number | null> = {};
    for (const row of Array.isArray(list) ? list : []) {
      if (!isObj(row)) continue;

      const codigo = aliasGet(row, ALIASES.codigo, 'codigo', signals);
      if (codigo === null) {
        signals.push({ code: 'missing_field', field: 'codigo', detail: 'fila sin código' });
        continue;
      }
      const key = String(codigo);
      const rawValor = aliasGet(row, ALIASES.valor, 'valor', signals);
      // A rate código parses as a DECIMAL into `tasas`; everything else stays integer pesos. The
      // split is what keeps 0.125 from reading as either a doubt or a rounded peso.
      const bucket = RATE_CODIGOS.has(key) ? tasas : codigos;
      const field = RATE_CODIGOS.has(key) ? `tasas.${key}` : `codigos.${key}`;
      const valor = RATE_CODIGOS.has(key) ? toDecimal(rawValor) : toInteger(rawValor);
      if (rawValor !== null && valor === null) {
        signals.push({
          code: 'unparseable_value',
          field,
          detail: `valor no numérico: ${JSON.stringify(rawValor)}`,
        });
      }
      // A repeated código would silently overwrite — SII has not been observed doing it, so say so.
      if (Object.hasOwn(bucket, key)) {
        signals.push({
          code: 'structural_drift',
          field,
          detail: 'código repetido en listCodPropuestos',
        });
      }
      bucket[key] = valor;

      for (const rowKey of Object.keys(row)) {
        if (!KNOWN_ROW_KEYS.has(rowKey)) {
          signals.push({
            code: 'unknown_keys',
            field,
            detail: `clave no observada: ${rowKey}`,
          });
        }
      }
    }

    const nonZero = (v: number | null): boolean => v !== null && v !== 0;
    return ok(provenance, ctx, signals, {
      codigos,
      tasas,
      // Mirrors the facade, which does not split rates out — a non-zero rate counts.
      tienePropuesta:
        Object.values(codigos).some(nonZero) || Object.values(tasas).some(nonZero),
      tipoPropuesta: toInteger(data['tipopropuesta']),
      estado: toInteger(data['estado']),
      totalCodigos: Object.keys(codigos).length + Object.keys(tasas).length,
      periodo: readPeriodo(data, signals),
    });
  },

  toEntities(
    record: ExtractionRecord<F29PropuestaExtract>,
    ctx: EntityProjectionContext,
  ): readonly AnyEntity[] {
    const { periodo, codigos, estado } = record.value;

    // No período ⇒ no natural key ⇒ no rows. Two ways here: a sin-propuesta (`data:null` — there
    // is no form to record) or a drifted header — and the drift case carries `structural_drift`,
    // which routes the record to review before projection is ever attempted. This is the backstop
    // for the path a confident record cannot reach: an unkeyable row is worse than none.
    if (periodo === null) return [];

    // `entityId(kind, …natural key)` — the `<kind>:` prefix is what the stage's `kindOf` routes
    // the upsert on; a bare hand-built string would land rows under a bucket nothing selects.
    const formId = entityId('taxReturnForm', ctx.taxpayer, 'F29', periodo, 'propuesta');
    const spine = {
      taxpayer: ctx.taxpayer,
      derivedFrom: record.id,
      recordedAt: ctx.recordedAt,
    };
    const form: TaxReturnForm = {
      id: formId,
      ...spine,
      form: 'F29',
      period: periodo,
      // A propuesta is SII's draft: never presented, so no folio and no fecha de presentación.
      folio: null,
      // The propuesta's numeric estado, verbatim as a string — never normalised (ADR-004).
      estado: estado === null ? null : String(estado),
      fechaPresentacion: null,
      rectificatoria: false,
      fuente: 'propuesta',
    };
    // Only PESO códigos become FormLines — `FormLine.monto` is integer pesos, and a rate there
    // would lie about units. The rate stays on the extraction record (`value.tasas`), reachable
    // from any entity via `derivedFrom`. Sorted by código so the row order is a property of the
    // key set, not of SII's list order — a run-to-run diff must be signal.
    const lines: FormLine[] = Object.entries(codigos)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([codigo, monto]) => ({
        id: entityId('formLine', formId, codigo),
        ...spine,
        formId,
        codigo,
        monto,
        glosa: null,
      }));
    return [form, ...lines];
  },
};

/**
 * Read the período (código 15) from `listCodBase` — the ONLY header código this parser touches.
 *
 * Observed on every golden 2023 artifact (e.g. `{"codigo":"15","valor":"202312"}`, alongside the
 * identity códigos 01/03/06/08 which stay unread — 03 is the RUT). Its absence means the header
 * shape changed: `structural_drift`, which puts the record below `REVIEW_THRESHOLD`, so a
 * propuesta whose period cannot be keyed reaches a human instead of the store.
 */
function readPeriodo(data: Record<string, unknown>, signals: ConfidenceSignal[]): string | null {
  const base = data['listCodBase'];
  if (!Array.isArray(base)) {
    signals.push({
      code: 'structural_drift',
      field: 'listCodBase',
      detail: 'la lista del encabezado no está — el período (código 15) es inderivable',
    });
    return null;
  }
  const row = base.find((r) => isObj(r) && String(r['codigo']) === '15');
  if (!isObj(row)) {
    signals.push({
      code: 'structural_drift',
      field: 'periodo',
      detail: 'código 15 (período tributario) no está en listCodBase',
    });
    return null;
  }
  const valor = typeof row['valor'] === 'string' ? row['valor'].trim() : String(row['valor']);
  if (!/^(?:19|20)\d{2}(?:0[1-9]|1[0-2])$/.test(valor)) {
    signals.push({
      code: 'unparseable_value',
      field: 'periodo',
      detail: `código 15 no es un período YYYYMM: ${JSON.stringify(row['valor'])}`,
    });
    return null;
  }
  return valor;
}

// --- helpers -----------------------------------------------------------------------------------

type Provenance = ReturnType<typeof provenanceOf>;
const provenanceOf = (ctx: ExtractionContext) => ({
  kind: 'artifact' as const,
  artifact: contentHash(ctx.manifest.contentHash),
  url: ctx.manifest.url,
  retrievedAt: instant(ctx.manifest.retrievedAt),
  strategy: REF,
  locator: '/data/listCodPropuestos',
});

function ok(
  provenance: Provenance,
  ctx: ExtractionContext,
  signals: readonly ConfidenceSignal[],
  value: F29PropuestaExtract,
): ExtractionOutcome<F29PropuestaExtract> {
  return {
    records: [
      {
        id: `${ctx.manifest.contentHash}:f29-propuesta`,
        strategy: REF,
        provenance,
        value,
        confidence: scoreConfidence(signals),
        signals,
        extractedAt: instant(ctx.now),
        taxpayer: ctx.taxpayer,
        runId: ctx.runId,
      },
    ],
    failures: [],
  };
}

function fail(
  provenance: Provenance,
  ctx: ExtractionContext,
  message: string,
): ExtractionOutcome<F29PropuestaExtract> {
  return {
    records: [],
    failures: [
      {
        strategy: REF,
        provenance,
        message,
        failedAt: instant(ctx.now),
        taxpayer: ctx.taxpayer,
        runId: ctx.runId,
      },
    ],
  };
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

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

/** Integer pesos. Accepts SII's numeric-as-string; rejects anything with a fractional part. */
function toInteger(v: unknown): number | null {
  if (typeof v === 'number') return Number.isInteger(v) ? v : null;
  if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) return Number(v.trim());
  return null;
}

/** A rate: any finite decimal. Observed as a dot-decimal string (`"0.125"`), never es-CL comma. */
function toDecimal(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && /^-?\d+(?:\.\d+)?$/.test(v.trim())) return Number(v.trim());
  return null;
}
