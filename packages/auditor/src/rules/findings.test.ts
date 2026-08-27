// Turning validated rules into findings (ADR-043 §I3/§I4).
//
// THE TWO WAYS THIS GOES WRONG, and both are silent:
//
//   * A finding raised from ABSENCE. `null` means "we do not know", and a reconciliation that
//     cannot be computed is not a discrepancy. Treating unknown as failure floods an auditor with
//     false positives from missing data — and the fastest way to make a real finding get ignored
//     is to bury it in twenty that were never real.
//   * A finding raised from a CANDIDATE rule. The gate is the only way into production
//     (ADR-043 §I4); a rule nobody validated must not reach a report no matter how confident it is.

import { describe, expect, it } from 'vitest';
import { EvaluationError } from '../errors.js';
import { produceFindings } from './findings.js';
import type { FindingContext } from './findings.js';
import type { Expression } from './expression.js';
import type { RuleKind, RuleRecord, RuleStatus } from './record.js';

const ctx = (facts: Record<string, number | string | boolean | null>): FindingContext => ({
  taxpayer: 'tp-alpha',
  period: '202309',
  asOf: '2023-09-30',
  facts,
});

/**
 * A reconciliation rule: the expression is the ASSERTION THAT MUST HOLD. It evaluates true when
 * the figures agree, so a finding is raised when it is FALSE — never when it is `null`.
 */
function rule(
  over: {
    id?: string;
    kind?: RuleKind;
    status?: RuleStatus;
    expression?: Expression;
    anchors?: readonly string[];
    effectiveFrom?: string;
    effectiveTo?: string | null;
  } = {},
): RuleRecord {
  const expression: Expression = over.expression ?? {
    op: 'within',
    args: [
      {
        op: 'add',
        args: [
          { op: 'field', path: 'bhe.retenido' },
          { op: 'field', path: 'bpst.retenido' },
        ],
      },
      { op: 'field', path: 'f29.codigo.151' },
    ],
    tolerance: 0,
  };
  return {
    id: over.id ?? 'honorarios-151',
    kind: over.kind ?? 'reconciliation',
    title: 'Retención de honorarios declarada debe igualar la retenida (Art. 74 Nº 2)',
    applicability: {
      forms: ['F29'],
      effectiveFrom: over.effectiveFrom ?? '2017-05-01',
      effectiveTo: over.effectiveTo ?? null,
    },
    provenance: {
      anchors: over.anchors ?? ['DL-824/1974#art-74-num-2'],
      references: ['ADR-023'],
      origin: 'authored',
    },
    current: {
      version: 1,
      expression,
      status: over.status ?? 'validated',
      confidence: 0.9,
      changedAt: '2026-08-06T00:00:00.000Z',
      changedBy: 'operator-local',
      rationale: 'seed',
    },
    history: [],
  };
}

describe('the reconciliation shape', () => {
  it('produces exactly ONE finding when the figures disagree', async () => {
    // The roadmap's named case: BHE + BPST != F29 151.
    const found = await produceFindings(
      [rule()],
      ctx({ 'bhe.retenido': 500_000, 'bpst.retenido': 100_000, 'f29.codigo.151': 450_000 }),
    );

    expect(found).toHaveLength(1);
    expect(found[0]?.ruleId).toBe('honorarios-151');
    expect(found[0]?.period).toBe('202309');
  });

  it('produces NONE when the figures agree', async () => {
    const found = await produceFindings(
      [rule()],
      ctx({ 'bhe.retenido': 500_000, 'bpst.retenido': 100_000, 'f29.codigo.151': 600_000 }),
    );
    expect(found).toEqual([]);
  });

  it('carries the rule’s citation', async () => {
    const found = await produceFindings(
      [rule()],
      ctx({ 'bhe.retenido': 1, 'bpst.retenido': 0, 'f29.codigo.151': 999 }),
    );
    expect(found[0]?.citedAnchors).toEqual(['DL-824/1974#art-74-num-2']);
  });

  it('quantifies materiality as the absolute gap, in pesos', async () => {
    const found = await produceFindings(
      [rule()],
      ctx({ 'bhe.retenido': 500_000, 'bpst.retenido': 100_000, 'f29.codigo.151': 450_000 }),
    );
    expect(found[0]?.materiality).toBe(150_000);
  });
});

describe('absence is not a discrepancy', () => {
  it('produces NO finding when the assertion evaluates to null', async () => {
    // The trap. A month with no F29 read cannot be reconciled; saying it disagrees would be
    // inventing a discrepancy out of missing data.
    const found = await produceFindings(
      [rule()],
      ctx({ 'bhe.retenido': 500_000, 'bpst.retenido': 100_000, 'f29.codigo.151': null }),
    );
    expect(found).toEqual([]);
  });

  it('produces no finding when EVERY input is absent', async () => {
    const found = await produceFindings(
      [rule()],
      ctx({ 'bhe.retenido': null, 'bpst.retenido': null, 'f29.codigo.151': null }),
    );
    expect(found).toEqual([]);
  });

  it('reports unknown separately from balanced, so the two are never conflated', async () => {
    // A caller that cannot tell "reconciled" from "could not be checked" will report the second
    // as the first — the confidently-wrong reading this package exists to prevent.
    const unknown = await produceFindings(
      [rule()],
      ctx({ 'bhe.retenido': 1, 'bpst.retenido': null, 'f29.codigo.151': 1 }),
      { collectUnknown: true },
    );
    expect(unknown.unknown.map((u) => u.ruleId)).toEqual(['honorarios-151']);
    expect(unknown.findings).toEqual([]);
  });
});

describe('only validated rules reach a report', () => {
  for (const status of ['candidate', 'retired'] as const) {
    it(`produces nothing from a ${status} rule, however confident`, async () => {
      // ADR-043 §I4: the gate is the only way into production.
      const found = await produceFindings(
        [rule({ status })],
        ctx({ 'bhe.retenido': 1, 'bpst.retenido': 0, 'f29.codigo.151': 999 }),
      );
      expect(found).toEqual([]);
    });
  }

  it('produces nothing from a rule not in force on the as-of date', async () => {
    const found = await produceFindings(
      [rule({ effectiveFrom: '2024-01-01' })],
      ctx({ 'bhe.retenido': 1, 'bpst.retenido': 0, 'f29.codigo.151': 999 }),
    );
    expect(found).toEqual([]);
  });
});

describe('rule kinds that never auto-issue a finding', () => {
  const alwaysFalse: Expression = { op: 'lit', value: false };

  it('an ANOMALY rule is worth attention but issues nothing by itself', async () => {
    // Stated on `RuleKind` itself: "Never auto-issues a finding."
    const found = await produceFindings(
      [rule({ kind: 'anomaly', expression: alwaysFalse })],
      ctx({}),
    );
    expect(found).toEqual([]);
  });

  it('a CLASSIFICATION rule labels records; it does not find anything', async () => {
    const found = await produceFindings(
      [rule({ kind: 'classification', expression: alwaysFalse })],
      ctx({}),
    );
    expect(found).toEqual([]);
  });

  it('an OBLIGATION rule DOES issue one when unmet', async () => {
    const found = await produceFindings(
      [rule({ kind: 'obligation', expression: alwaysFalse })],
      ctx({}),
    );
    expect(found).toHaveLength(1);
  });
});

// W2 built `unknownPaths` for exactly this moment: a rule pointing at a fact that does not exist
// must be REJECTED, not quietly evaluated to "unknown" and reported as nothing wrong.
describe('a rule whose paths the fact bag does not declare', () => {
  it('RAISES rather than silently finding nothing', async () => {
    const typo: Expression = {
      op: 'within',
      args: [
        { op: 'field', path: 'f29.151' },
        { op: 'lit', value: 0 },
      ],
      tolerance: 0,
    };
    await expect(
      produceFindings([rule({ expression: typo })], ctx({ 'f29.codigo.151': 1 })),
    ).rejects.toThrow(EvaluationError);
  });

  it('names the rule as well as the path, so the fix is obvious', async () => {
    const typo: Expression = {
      op: 'within',
      args: [
        { op: 'field', path: 'f29.151' },
        { op: 'lit', value: 0 },
      ],
      tolerance: 0,
    };
    await expect(
      produceFindings([rule({ id: 'my-rule', expression: typo })], ctx({ 'f29.codigo.151': 1 })),
    ).rejects.toThrow(/my-rule/);
  });

  it('checks the WHOLE tree, including branches evaluation would not take', async () => {
    const hidden: Expression = {
      op: 'if',
      args: [
        { op: 'lit', value: true },
        { op: 'lit', value: true },
        { op: 'field', path: 'f29.151' },
      ],
    };
    await expect(
      produceFindings([rule({ expression: hidden })], ctx({ 'f29.codigo.151': 1 })),
    ).rejects.toThrow(/f29\.151/);
  });
});

describe('determinism', () => {
  it('gives a finding the same id on a re-run', async () => {
    const facts = { 'bhe.retenido': 1, 'bpst.retenido': 0, 'f29.codigo.151': 999 };
    const a = await produceFindings([rule()], ctx(facts));
    const b = await produceFindings([rule()], ctx(facts));
    expect(a[0]?.id).toBe(b[0]?.id);
  });

  it('gives DIFFERENT periods different ids', async () => {
    const facts = { 'bhe.retenido': 1, 'bpst.retenido': 0, 'f29.codigo.151': 999 };
    const sep = await produceFindings([rule()], { ...ctx(facts), period: '202309' });
    const oct = await produceFindings([rule()], { ...ctx(facts), period: '202310' });
    expect(sep[0]?.id).not.toBe(oct[0]?.id);
  });

  it('orders findings by rule id, not by evaluation order', async () => {
    const found = await produceFindings(
      [rule({ id: 'z-rule' }), rule({ id: 'a-rule' })],
      ctx({ 'bhe.retenido': 1, 'bpst.retenido': 0, 'f29.codigo.151': 999 }),
    );
    expect(found.map((f) => f.ruleId)).toEqual(['a-rule', 'z-rule']);
  });
});
