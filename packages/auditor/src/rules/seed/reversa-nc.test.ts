// Rule #1 as data: it evaluates, it carries its evidence honestly, and it CANNOT reach production
// without the gate. That last property is the one worth a test — it is ADR-043 §I4's whole claim.

import { describe, expect, it } from 'vitest';
import { IntegrityError } from '../../errors.js';
import { evaluate, explain, unknownPaths } from '../expression.js';
import type { EvaluationContext, RuleValue } from '../expression.js';
import { promote } from '../promotion.js';
import type { GateApproval, VersionAuthor } from '../promotion.js';
import { appliesOn, ruleRef } from '../record.js';
import { rcvRowFacts, seedReversaRules } from './reversa-nc.js';

const author: VersionAuthor = {
  by: 'operator-local',
  at: '2026-08-06T00:00:00.000Z',
  rationale: 'seed',
};

const rules = () => seedReversaRules(author);
const byId = (id: string) => {
  const r = rules().find((x) => x.id === id);
  if (r === undefined) throw new Error(`missing rule ${id}`);
  return r;
};

const ctx = (facts: Record<string, RuleValue>): EvaluationContext => ({
  facts,
  asOf: '2023-09-30',
});

describe('the rules exist as data', () => {
  it('seeds exactly two rules — crédito and débito are separate claims', () => {
    expect(
      rules()
        .map((r) => r.id)
        .sort(),
    ).toEqual(['reversa-nc-credito', 'reversa-nc-debito']);
  });

  it('both start as CANDIDATE — there is no path that mints a validated rule', () => {
    for (const r of rules()) expect(r.current.status).toBe('candidate');
  });

  it('renders readable for a human reviewer', () => {
    expect(explain(byId('reversa-nc-credito').current.expression)).toBe('dte.tipo ∈ {"61"}');
  });

  it('is versioned and referenceable', () => {
    expect(ruleRef(byId('reversa-nc-credito'))).toBe('reversa-nc-credito@1');
  });
});

describe('evidence is encoded, not flattened', () => {
  it('gives the CONFIRMED crédito rule higher confidence than the INFERRED débito one', () => {
    // The source comment says the débito side is "inferred, not confirmed". A single Set could not
    // carry that; two rules with different confidences can.
    expect(byId('reversa-nc-credito').current.confidence).toBeGreaterThan(
      byId('reversa-nc-debito').current.confidence,
    );
  });

  it('says WHY in the débito rationale, not just that confidence is low', () => {
    expect(byId('reversa-nc-debito').current.rationale).toMatch(/538/);
    expect(byId('reversa-nc-debito').title).toMatch(/INFERIDO/);
  });

  it('claims NO normativa anchor, because no corpus is loaded', () => {
    // Fabricating an article number to look rigorous is exactly what ADR-043 §I2 forbids.
    for (const r of rules()) expect(r.provenance.anchors).toEqual([]);
  });

  it('carries its observation reference', () => {
    expect(byId('reversa-nc-credito').provenance.references).toContain('observed:2026-07-28');
  });
});

describe('evaluation', () => {
  it('classifies a Nota de Crédito as reversing', () => {
    const r = evaluate(byId('reversa-nc-credito').current.expression, ctx({ 'dte.tipo': '61' }));
    expect(r.value).toBe(true);
    expect(r.readPaths).toEqual(['dte.tipo']);
  });

  it('classifies an ordinary factura as NOT reversing', () => {
    expect(
      evaluate(byId('reversa-nc-credito').current.expression, ctx({ 'dte.tipo': '33' })).value,
    ).toBe(false);
  });

  it('is UNKNOWN when the DTE type is absent — never silently "not reversing"', () => {
    // Defaulting to false would net nothing and quietly restore the raw-sum bug this rule exists
    // to prevent. Absence is DECLARED (`null`), not omitted (W2): omitting it would now raise, and
    // a row with no type is a legitimate absence, not a broken rule.
    expect(
      evaluate(byId('reversa-nc-credito').current.expression, ctx({ 'dte.tipo': null })).value,
    ).toBeNull();
  });

  it('does not match a numeric 61 — SII sends the type as a string', () => {
    expect(
      evaluate(byId('reversa-nc-credito').current.expression, {
        facts: { 'dte.tipo': 61 as unknown as string },
        asOf: '2023-09-30',
      }).value,
    ).toBe(false);
  });
});

describe('behavioural equivalence with the TIPOS_REVERSA Set it replaces', () => {
  // Mirrors `packages/core/src/tasks/iva.ts`: `new Set(['61'])`. If that set ever gains a member,
  // this table must change WITH it — which is the point of pinning the migration rather than
  // assuming the two stay in step.
  const CORE_TIPOS_REVERSA = new Set(['61']);

  const OBSERVED_DTE_TYPES = [
    '33', // factura electrónica
    '34', // factura exenta
    '39', // boleta electrónica
    '46', // factura de compra
    '52', // guía de despacho
    '56', // NOTA DE DÉBITO — see the dedicated case below
    '61', // nota de crédito electrónica
    '110', // factura de exportación
    '111', // nota de débito de exportación
    '112', // nota de crédito de exportación
    '914', // DIN (importación)
  ] as const;

  it('agrees with the Set on every observed DTE type', () => {
    const expr = byId('reversa-nc-credito').current.expression;
    for (const tipo of OBSERVED_DTE_TYPES) {
      expect(evaluate(expr, ctx({ 'dte.tipo': tipo })).value).toBe(CORE_TIPOS_REVERSA.has(tipo));
    }
  });

  it('does NOT treat a Nota de Débito (56) as reversing — that question is still open', () => {
    // BACKLOG §3.5: the NC (61) netting was validated against código 511; the DÉBITO-note side was
    // never isolated. Silently including 56 would assert an unobserved rule (ADR-004).
    expect(
      evaluate(byId('reversa-nc-credito').current.expression, ctx({ 'dte.tipo': '56' })).value,
    ).toBe(false);
  });

  it('does not treat the export credit note (112) as reversing either — unobserved', () => {
    expect(
      evaluate(byId('reversa-nc-credito').current.expression, ctx({ 'dte.tipo': '112' })).value,
    ).toBe(false);
  });
});

describe('applicability', () => {
  it('applies inside the electronic-RCV era', () => {
    expect(appliesOn(byId('reversa-nc-credito'), '2023-09-30')).toBe(true);
  });

  it('does NOT apply before período 201705, which this project cannot read at all', () => {
    expect(appliesOn(byId('reversa-nc-credito'), '2016-01-01')).toBe(false);
  });
});

describe('the gate is the only way into production', () => {
  const approval = (subject: string, over: Partial<GateApproval> = {}): GateApproval => ({
    verdict: 'promote',
    subject,
    goldenSetVersion: 'fb1f12bd2e67f3fb',
    evaluatedAt: '2026-08-06T00:00:00.000Z',
    evalRunId: 'run-1',
    deltas: { 'extraction.accuracy': 0.01 },
    ...over,
  });

  it('refuses promotion without a golden-set version', () => {
    expect(() =>
      promote(
        byId('reversa-nc-credito'),
        approval('reversa-nc-credito@1', { goldenSetVersion: '' }),
      ),
    ).toThrow(IntegrityError);
  });

  it('refuses an approval issued for the OTHER rule', () => {
    // The two rules are separate claims; evidence for one is not evidence for the other.
    expect(() => promote(byId('reversa-nc-debito'), approval('reversa-nc-credito@1'))).toThrow(
      /approvals are per-version/,
    );
  });

  it('promotes only with a well-formed approval for that exact version', () => {
    const promoted = promote(byId('reversa-nc-credito'), approval('reversa-nc-credito@1'));
    expect(promoted.current.status).toBe('validated');
    // History keeps the candidate lineage — nothing is edited in place.
    expect(promoted.history).toHaveLength(1);
  });
});

describe('rcvRowFacts', () => {
  it('maps a row to the named fact the rule reads', () => {
    expect(rcvRowFacts({ codigoTipoDoc: '61' })).toEqual({ 'dte.tipo': '61' });
  });

  it('DECLARES the fact as null when the row has no type — absence, not an empty string', () => {
    // An empty string would test as "not 61" and quietly classify the row as non-reversing.
    //
    // It used to OMIT the key instead (W2). That was the real instance of the silent
    // under-reporting gap: an omitted path and a path that does not exist at all looked identical
    // to the evaluator, so renaming `dte.tipo` would have degraded every row to "unknown" and
    // reported nothing wrong. Declaring the absence keeps the `null` and makes a typo loud.
    expect(rcvRowFacts({ codigoTipoDoc: null })).toEqual({ 'dte.tipo': null });
    expect(Object.hasOwn(rcvRowFacts({ codigoTipoDoc: null }), 'dte.tipo')).toBe(true);
  });

  it('always satisfies the vocabulary of the rule it feeds', () => {
    // The two halves must agree: whatever the rule references, the mapper must declare. This is
    // the check that fails the day someone renames one side and not the other.
    const expr = byId('reversa-nc-credito').current.expression;
    expect(unknownPaths(expr, rcvRowFacts({ codigoTipoDoc: null }))).toEqual([]);
    expect(unknownPaths(expr, rcvRowFacts({ codigoTipoDoc: '33' }))).toEqual([]);
  });
});
