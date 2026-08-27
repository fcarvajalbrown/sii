// Rule #1: reversing DTE types (ADR-043 §I3) — the first tax logic migrated out of code and into
// versioned, inspectable rule DATA.
//
// WHAT IT REPLACES: `TIPOS_REVERSA` in `packages/core/src/tasks/iva.ts` — a bare
// `new Set(['61'])` whose entire justification lives in a 17-line comment above it. As code it has
// no version, no confidence, no status, and no way for the loop to propose a change to it.
//
// WHY IT BECOMES **TWO** RULES AND NOT ONE. The source comment draws a distinction that a single
// `Set` cannot carry:
//
//   * CRÉDITO (compras): OBSERVED live 2026-07-28 across 16 real months. Summed straight, the
//     delta against SII's own código 511 was ALWAYS exactly 2× that month's NC IVA — including a
//     month with zero NC, where the delta was exactly zero. That is confirmation, not inference.
//   * DÉBITO (ventas): NOT independently observed. No F29 código 538 was ever seen for the
//     taxpayer in question, so the netting rests on the accounting fact that a nota de crédito
//     emitida reduces a prior sale — sound reasoning, but reasoning. The source says so in as many
//     words: *"treat it as inferred, not confirmed."*
//
// Encoding both at one confidence would erase that, and erasing it is how an inference quietly
// becomes a fact. Split, the difference is machine-readable: the crédito rule can be promoted on
// evidence; the débito one stays a `candidate` until a taxpayer with an observed 538 verifies it.
//
// NEITHER IS VALIDATED HERE. `propose()` can only mint a `candidate`, and `promote()` demands a
// `GateApproval` from a real golden-set evaluation. That is the invariant working, not an omission:
// this file is knowledge made inspectable, not knowledge made authoritative.
//
// NO NORMATIVA ANCHOR IS CLAIMED. The provenance carries ADR/observation references only. There is
// no corpus loaded (`kb/normativa.ts`), and fabricating an article number to look rigorous is the
// exact failure ADR-043 §I2 exists to prevent.

import { propose } from '../promotion.js';
import type { VersionAuthor } from '../promotion.js';
import type { Expression, RuleValue } from '../expression.js';
import type { RuleRecord } from '../record.js';

/** The observation that confirmed the crédito side, and the ADRs that record the reasoning. */
const REFERENCES = ['ADR-022', 'ADR-043', 'docs/BACKLOG.md#3.5', 'observed:2026-07-28'] as const;

/**
 * `dte.tipo ∈ {"61"}` — a Nota de Crédito Electrónica reverses a prior document.
 *
 * Deliberately a MEMBERSHIP test over a literal set rather than `eq`, so extending the set when a
 * new reversing type is observed is a one-element data edit with its own version — which is the
 * whole reason this stopped being a `Set` in TypeScript.
 */
const REVERSING_TYPES: Expression = {
  op: 'in',
  args: [{ op: 'field', path: 'dte.tipo' }, ['61']],
};

/**
 * Applicability window.
 *
 * `effectiveFrom` is bounded by the ELECTRONIC RCV era (período 201705 — SII rejects anything
 * earlier outright), not by the underlying accounting fact, which long predates it. Claiming a
 * wider window would assert applicability over periods this project has never been able to read.
 */
const APPLICABILITY = {
  forms: ['RCV'] as const,
  effectiveFrom: '2017-05-01',
  effectiveTo: null,
};

export function seedReversaRules(author: VersionAuthor): readonly RuleRecord[] {
  const credito = propose(
    'reversa-nc-credito',
    {
      kind: 'classification',
      title: 'Nota de Crédito recibida (tipo 61) revierte una compra previa — no se suma en bruto',
      applicability: { ...APPLICABILITY },
      provenance: { anchors: [], references: [...REFERENCES], origin: 'observed' },
    },
    REVERSING_TYPES,
    // High: 16 real months, exact-match arithmetic against SII's own netted código 511, including
    // a zero-NC month where the delta was exactly zero.
    0.9,
    {
      ...author,
      rationale:
        'Confirmado en vivo 2026-07-28 sobre 16 meses reales: sumar en bruto daba una diferencia ' +
        'contra el código 511 de SII igual a 2× el IVA de las NC del mes, y exactamente cero en el ' +
        'mes sin NC. Migrado desde TIPOS_REVERSA (tasks/iva.ts).',
    },
  );

  const debito = propose(
    'reversa-nc-debito',
    {
      kind: 'classification',
      title:
        'Nota de Crédito emitida (tipo 61) revierte una venta previa — INFERIDO, no confirmado',
      applicability: { ...APPLICABILITY },
      provenance: { anchors: [], references: [...REFERENCES], origin: 'observed' },
    },
    REVERSING_TYPES,
    // Low: the accounting fact is sound, but no F29 código 538 was ever observed to check it
    // against. The confidence is the honest encoding of "we reasoned this, we did not see it".
    0.3,
    {
      ...author,
      rationale:
        'NO verificado contra un código 538 real — este contribuyente nunca lo trajo en ninguna ' +
        'propuesta leída (BACKLOG §3.1). Descansa en el hecho contable (una NC emitida reduce una ' +
        'venta previa), no en una observación. Necesita un contribuyente con 538 observado antes ' +
        'de poder promoverse.',
    },
  );

  return [credito, debito];
}

/**
 * Facts an RCV resumen row contributes to the rule context.
 *
 * A thin, explicit mapping rather than handing the whole row to the evaluator: a rule should read
 * named facts, not whatever shape the extractor happened to produce, so a change in the row's shape
 * surfaces here instead of silently changing what a rule means.
 *
 * `dte.tipo` is ALWAYS DECLARED, `null` when the row has no type. It used to be omitted, which the
 * evaluator could not tell apart from a rule pointing at a path that does not exist — so a renamed
 * fact would have degraded to "unknown", produced no finding, and read as a clean month. Declaring
 * the absence keeps the `null` (an unknown type must never classify as "not reversing") while
 * leaving a genuine typo loud.
 */
export function rcvRowFacts(row: {
  readonly codigoTipoDoc: string | null;
}): Record<string, RuleValue> {
  return { 'dte.tipo': row.codigoTipoDoc };
}
