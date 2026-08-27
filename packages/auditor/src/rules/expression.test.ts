// The evaluator's test suite (ADR-043 §I3).
//
// This is the component whose bugs are silently wrong ARITHMETIC on tax figures, so the cases below
// are chosen for exactly that: null-vs-zero, integer discipline, three-valued logic, and the
// boundary of `within`. A green suite here is what makes the evaluator safe to migrate rules onto.

import { describe, expect, it } from 'vitest';
import { EvaluationError } from '../errors.js';
import {
  MAX_EVAL_DEPTH,
  depth,
  evaluate,
  explain,
  referencedPaths,
  unknownPaths,
} from './expression.js';
import type { EvaluationContext, Expression, RuleValue } from './expression.js';

const ctx = (facts: Record<string, RuleValue> = {}): EvaluationContext => ({
  facts,
  asOf: '2023-09-30',
});

/**
 * Evaluate with every referenced path DECLARED, defaulting to `null`, then the given facts on top.
 *
 * The suite below tests null-propagation arithmetic, not the vocabulary contract — so it declares
 * the vocabulary for them and lets each case say only what it cares about. `{}` here therefore
 * means "declared and absent", which is what these cases always meant.
 *
 * Omission is NOT generally safe: see the `fact-path vocabulary (W2)` block, which builds its bags
 * literally so an undeclared path stays undeclared.
 */
const run = (expr: Expression, facts: Record<string, RuleValue> = {}): RuleValue => {
  const declared: Record<string, RuleValue> = {};
  for (const p of referencedPaths(expr)) declared[p] = null;
  return evaluate(expr, ctx({ ...declared, ...facts })).value;
};

const lit = (value: RuleValue): Expression => ({ op: 'lit', value });
const field = (path: string): Expression => ({ op: 'field', path });

describe('literals and fields', () => {
  it('returns a literal unchanged', () => {
    expect(run(lit(5))).toBe(5);
    expect(run(lit('x'))).toBe('x');
    expect(run(lit(null))).toBeNull();
  });

  it('reads a fact', () => {
    expect(run(field('f29.151'), { 'f29.151': 326825 })).toBe(326825);
  });

  it('treats an absent path as ABSENT, not an error', () => {
    // A rule may legitimately span surfaces a given month does not have.
    expect(run(field('nope'))).toBeNull();
  });

  it('records which paths were read', () => {
    const expr: Expression = { op: 'add', args: [field('a'), field('b')] };
    expect(evaluate(expr, ctx({ a: 1, b: 2 })).readPaths).toEqual(['a', 'b']);
  });
});

describe('null is ABSENCE and it propagates — never becomes 0', () => {
  it('add with an absent operand is null, not the partial sum', () => {
    // The oldest trap in this project: a missing monto silently becoming 0 turns "we do not know"
    // into "it is nothing", which reads as a reconciled month.
    expect(run({ op: 'add', args: [field('a'), lit(5)] })).toBeNull();
  });

  it('sub / mul / div / abs / neg all propagate', () => {
    expect(run({ op: 'sub', args: [field('a'), lit(5)] })).toBeNull();
    expect(run({ op: 'mul', args: [field('a'), lit(5)] })).toBeNull();
    expect(run({ op: 'div', args: [field('a'), lit(5)] })).toBeNull();
    expect(run({ op: 'abs', args: [field('a')] })).toBeNull();
    expect(run({ op: 'neg', args: [field('a')] })).toBeNull();
  });

  it('coalesce is the EXPLICIT opt-in to treating absence as zero', () => {
    const expr: Expression = {
      op: 'add',
      args: [{ op: 'coalesce', args: [field('a'), lit(0)] }, lit(5)],
    };
    expect(run(expr)).toBe(5);
  });

  it('coalesce keeps a real 0 rather than skipping to the next argument', () => {
    // `0` is a value, not an absence. Skipping it would silently substitute a fallback.
    expect(run({ op: 'coalesce', args: [field('a'), lit(99)] }, { a: 0 })).toBe(0);
  });

  it('coalesce of all-absent is null', () => {
    expect(run({ op: 'coalesce', args: [field('a'), field('b')] })).toBeNull();
  });
});

describe('arithmetic is integer pesos only', () => {
  it('adds and subtracts', () => {
    expect(run({ op: 'add', args: [lit(162457), lit(164368)] })).toBe(326825);
    expect(run({ op: 'sub', args: [lit(326825), lit(326825)] })).toBe(0);
  });

  it('rejects a fractional operand rather than rounding a peso figure', () => {
    expect(() => run({ op: 'add', args: [lit(1.5), lit(1)] })).toThrow(EvaluationError);
  });

  it('rejects a string where a number belongs', () => {
    expect(() => run({ op: 'add', args: [lit('5'), lit(1)] })).toThrow(/requires a number/);
  });

  it('truncates division toward zero', () => {
    expect(run({ op: 'div', args: [lit(7), lit(2)] })).toBe(3);
    expect(run({ op: 'div', args: [lit(-7), lit(2)] })).toBe(-3);
  });

  it('returns null on division by zero — an absence, never an exception', () => {
    expect(run({ op: 'div', args: [lit(1), lit(0)] })).toBeNull();
  });
});

describe('comparisons over absence yield absence', () => {
  it('eq with an absent side is null, NOT false', () => {
    // `false` would let a rule read "the figures differ" from data it never had.
    expect(run({ op: 'eq', args: [field('a'), lit(0)] })).toBeNull();
    expect(run({ op: 'ne', args: [field('a'), lit(0)] })).toBeNull();
  });

  it('compares present values', () => {
    expect(run({ op: 'eq', args: [lit(1), lit(1)] })).toBe(true);
    expect(run({ op: 'ne', args: [lit(1), lit(2)] })).toBe(true);
    expect(run({ op: 'lt', args: [lit(1), lit(2)] })).toBe(true);
    expect(run({ op: 'lte', args: [lit(2), lit(2)] })).toBe(true);
    expect(run({ op: 'gt', args: [lit(3), lit(2)] })).toBe(true);
    expect(run({ op: 'gte', args: [lit(2), lit(2)] })).toBe(true);
  });

  it('compares strings by equality without coercing them to numbers', () => {
    expect(run({ op: 'eq', args: [lit('61'), lit('61')] })).toBe(true);
    expect(run({ op: 'eq', args: [lit('61'), lit(61)] })).toBe(false);
  });
});

describe('and / or are three-valued, and a decided operand still decides', () => {
  it('false AND unknown is FALSE — one false operand settles it', () => {
    expect(run({ op: 'and', args: [lit(false), field('a')] })).toBe(false);
  });

  it('true AND unknown is unknown', () => {
    expect(run({ op: 'and', args: [lit(true), field('a')] })).toBeNull();
  });

  it('true OR unknown is TRUE', () => {
    expect(run({ op: 'or', args: [lit(true), field('a')] })).toBe(true);
  });

  it('false OR unknown is unknown', () => {
    expect(run({ op: 'or', args: [lit(false), field('a')] })).toBeNull();
  });

  it('resolves fully-known conjunctions and disjunctions', () => {
    expect(run({ op: 'and', args: [lit(true), lit(true)] })).toBe(true);
    expect(run({ op: 'and', args: [lit(true), lit(false)] })).toBe(false);
    expect(run({ op: 'or', args: [lit(false), lit(false)] })).toBe(false);
  });

  it('short-circuits past an ill-typed operand once the result is decided', () => {
    // `false AND <type error>` must not throw: the answer was settled by the first operand.
    expect(run({ op: 'and', args: [lit(false), { op: 'not', args: [lit(1)] }] })).toBe(false);
  });

  it('not propagates absence', () => {
    expect(run({ op: 'not', args: [field('a')] })).toBeNull();
    expect(run({ op: 'not', args: [lit(true)] })).toBe(false);
  });
});

describe('isNull is the one operator that ANSWERS rather than propagates', () => {
  it('is true for an absent value and false for a present one', () => {
    expect(run({ op: 'isNull', args: [field('a')] })).toBe(true);
    expect(run({ op: 'isNull', args: [field('a')] }, { a: 0 })).toBe(false);
  });
});

describe('if', () => {
  it('selects a branch on a known condition', () => {
    expect(run({ op: 'if', args: [lit(true), lit(1), lit(2)] })).toBe(1);
    expect(run({ op: 'if', args: [lit(false), lit(1), lit(2)] })).toBe(2);
  });

  it('yields null on an UNKNOWN condition rather than falling into the else branch', () => {
    // Falling through would turn "we could not tell" into a definite answer.
    expect(run({ op: 'if', args: [field('a'), lit(1), lit(2)] })).toBeNull();
  });

  it('does not evaluate the untaken branch', () => {
    const boom: Expression = { op: 'not', args: [lit(1)] }; // would throw if evaluated
    expect(run({ op: 'if', args: [lit(true), lit(1), boom] })).toBe(1);
  });
});

describe('in', () => {
  it('tests membership against literals', () => {
    expect(run({ op: 'in', args: [field('t'), ['61']] }, { t: '61' })).toBe(true);
    expect(run({ op: 'in', args: [field('t'), ['61']] }, { t: '33' })).toBe(false);
  });

  it('is unknown for an absent value', () => {
    expect(run({ op: 'in', args: [field('t'), ['61']] })).toBeNull();
  });
});

describe('within — the tolerance operator', () => {
  it('is true exactly AT the boundary', () => {
    expect(run({ op: 'within', args: [lit(100), lit(105)], tolerance: 5 })).toBe(true);
  });

  it('is false one peso past it', () => {
    expect(run({ op: 'within', args: [lit(100), lit(106)], tolerance: 5 })).toBe(false);
  });

  it('is symmetric', () => {
    expect(run({ op: 'within', args: [lit(105), lit(100)], tolerance: 5 })).toBe(true);
  });

  it('with tolerance 0 is exact equality', () => {
    expect(run({ op: 'within', args: [lit(326825), lit(326825)], tolerance: 0 })).toBe(true);
    expect(run({ op: 'within', args: [lit(326825), lit(326826)], tolerance: 0 })).toBe(false);
  });

  it('propagates absence', () => {
    expect(run({ op: 'within', args: [field('a'), lit(1)], tolerance: 5 })).toBeNull();
  });
});

describe('totality', () => {
  it('refuses an expression nested past the depth guard', () => {
    let expr: Expression = lit(1);
    for (let i = 0; i <= MAX_EVAL_DEPTH + 2; i += 1) expr = { op: 'abs', args: [expr] };
    expect(() => run(expr)).toThrow(/nests deeper/);
  });

  it('is deterministic', () => {
    const expr: Expression = { op: 'add', args: [field('a'), field('b')] };
    const facts = { a: 1, b: 2 };
    expect(evaluate(expr, ctx(facts))).toEqual(evaluate(expr, ctx(facts)));
  });
});

describe('inspection helpers', () => {
  it('lists referenced paths without evaluating', () => {
    const expr: Expression = {
      op: 'and',
      args: [
        { op: 'eq', args: [field('b'), lit(1)] },
        { op: 'in', args: [field('a'), ['61']] },
      ],
    };
    expect(referencedPaths(expr)).toEqual(['a', 'b']);
  });

  it('measures depth', () => {
    expect(depth(lit(1))).toBe(1);
    expect(depth({ op: 'abs', args: [lit(1)] })).toBe(2);
  });

  it('renders a readable explanation for a human reviewer', () => {
    const expr: Expression = { op: 'in', args: [field('dte.tipo'), ['61']] };
    expect(explain(expr)).toBe('dte.tipo ∈ {"61"}');
  });
});

// ── W2: the fact-path vocabulary contract ─────────────────────────────────────────────────────
//
// THE GAP THIS CLOSES. Before this, `ctx.facts[path] ?? null` gave a typo'd path and a genuinely
// absent one the SAME answer: `null`. A rule referencing `f29.151` when the bag carries
// `f29.codigo.151` evaluated to "unknown", produced no finding, and reported nothing wrong — the
// silent under-reporting mode, which is strictly worse than a crash because it looks like a clean
// month.
//
// THE FIX IS A VOCABULARY, NOT A GUESS. The fact bag DECLARES which paths exist here. A key present
// with value `null` means "this fact belongs in this context and has no value" — legitimate
// absence, still `null`, still propagating. A key that is ABSENT means the rule asked for something
// that is not a fact at all, and that raises.
describe('fact-path vocabulary (W2)', () => {
  // Deliberately NOT the auto-declaring `run` helper: these tests are about the vocabulary itself,
  // so the bag must be exactly what the test writes.
  const strict = (expr: Expression, facts: Record<string, RuleValue>): RuleValue =>
    evaluate(expr, { facts, asOf: '2023-09-30' }).value;

  it('RAISES on a path the fact bag does not declare, instead of evaluating to null', () => {
    // The exact case from the roadmap: the rule says `f29.151`, the bag says `f29.codigo.151`.
    expect(() => strict(field('f29.151'), { 'f29.codigo.151': 326825 })).toThrow(EvaluationError);
  });

  it('names the offending path and suggests the near-miss', () => {
    // A bare "unknown path" would leave a human diffing two long dotted strings by eye.
    expect(() => strict(field('f29.151'), { 'f29.codigo.151': 326825 })).toThrow(/f29\.151/);
    expect(() => strict(field('f29.151'), { 'f29.codigo.151': 326825 })).toThrow(
      /f29\.codigo\.151/,
    );
  });

  it('treats a DECLARED null as legitimate absence — still null, still propagating', () => {
    // The case the old comment was protecting: a rule may span a surface a given month lacks.
    // That must keep working, or this change trades a silent miss for a false alarm.
    expect(strict(field('bhe.retencion'), { 'bhe.retencion': null })).toBeNull();
    expect(
      strict({ op: 'add', args: [field('bhe.retencion'), lit(5)] }, { 'bhe.retencion': null }),
    ).toBeNull();
  });

  it('does not raise for a declared path that holds a real value', () => {
    expect(strict(field('f29.codigo.151'), { 'f29.codigo.151': 0 })).toBe(0);
  });

  it('unknownPaths reports the typo WITHOUT evaluating', () => {
    const expr: Expression = {
      op: 'add',
      args: [field('f29.151'), field('f29.codigo.537')],
    };
    expect(unknownPaths(expr, { 'f29.codigo.151': 1, 'f29.codigo.537': 2 })).toEqual(['f29.151']);
  });

  it('unknownPaths is empty when every referenced path is declared, null included', () => {
    const expr: Expression = { op: 'add', args: [field('a'), field('b')] };
    expect(unknownPaths(expr, { a: 1, b: null })).toEqual([]);
  });

  it('catches a typo hiding in a branch evaluation never takes', () => {
    // THE REASON THE PRE-FLIGHT CHECK EXISTS. `if` is lazy, so a bad path in the untaken branch is
    // never read and never raises at evaluation time — the rule looks fine until the day the
    // condition flips. `unknownPaths` walks the whole tree, so the loop can reject the rule up
    // front rather than shipping a latent silent miss.
    const expr: Expression = {
      op: 'if',
      args: [lit(true), lit(1), field('f29.151')],
    };
    expect(strict(expr, { 'f29.codigo.151': 1 })).toBe(1);
    expect(unknownPaths(expr, { 'f29.codigo.151': 1 })).toEqual(['f29.151']);
  });
});
