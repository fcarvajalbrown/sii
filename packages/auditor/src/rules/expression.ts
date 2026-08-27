// Rule expressions as DATA (ADR-043 §I3) — a closed, total operator set.
//
// The constraint is "tax logic lives in versioned, inspectable rule records — not buried in Python
// conditionals". So an expression must be a value that can be stored, diffed, versioned and READ
// by a human who is not a programmer. That rules out three tempting shortcuts:
//
//   * A JS string + `eval` / `new Function` — arbitrary code from the rule store, non-inspectable,
//     non-terminating, and a remote-code-execution hole if a rule ever arrives from outside.
//   * An embedded scripting language — same non-termination problem, plus a dependency whose
//     expression surface is larger than anyone will audit (ADR-043 alt. 2).
//   * A hand-rolled parser for an infix DSL — a grammar to maintain and a new class of bug, for
//     ergonomics a small JSON AST does not actually need.
//
// TOTALITY IS THE POINT. There is no loop, no recursion, no function definition, no user-defined
// name binding. Every expression terminates, in time linear in its own size. A rule cannot hang
// the nightly run, and "same inputs ⇒ same output" (ADR-043 §I5) is structural rather than hoped
// for.
//
// MONEY IS INTEGER PESOS. Chilean tax amounts are whole pesos; the arithmetic operators reject
// non-integers rather than silently introducing float drift into a figure destined for a return.

import { EvaluationError } from '../errors.js';

/** A value an expression can produce. Deliberately narrow — no objects, no functions. */
export type RuleValue = number | string | boolean | null;

export type Expression =
  | { readonly op: 'lit'; readonly value: RuleValue }
  /** Read a field from the evaluation context, e.g. `f29.codigo.537`. Missing ⇒ `null`. */
  | { readonly op: 'field'; readonly path: string }
  | { readonly op: 'add' | 'sub' | 'mul'; readonly args: readonly Expression[] }
  /** Integer division, truncated toward zero. Division by zero ⇒ `null`, never an exception. */
  | { readonly op: 'div'; readonly args: readonly [Expression, Expression] }
  | { readonly op: 'abs' | 'neg'; readonly args: readonly [Expression] }
  | {
      readonly op: 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte';
      readonly args: readonly [Expression, Expression];
    }
  | { readonly op: 'and' | 'or'; readonly args: readonly Expression[] }
  | { readonly op: 'not'; readonly args: readonly [Expression] }
  /** `null`-safe: true when the value is `null` or absent. The domain's commonest branch. */
  | { readonly op: 'isNull'; readonly args: readonly [Expression] }
  /** First non-null argument, or `null`. NEVER coerces `null` to `0` — a standing project trap. */
  | { readonly op: 'coalesce'; readonly args: readonly Expression[] }
  | { readonly op: 'if'; readonly args: readonly [Expression, Expression, Expression] }
  /** Membership against literals, e.g. DTE type in the reversing set. */
  | { readonly op: 'in'; readonly args: readonly [Expression, readonly RuleValue[]] }
  /**
   * Absolute tolerance comparison: `|a - b| <= tolerance`. Its own operator rather than a
   * composition, because an exact-equality reconciliation is a recurring false-positive source and
   * the tolerance should be visible in the rule text, not buried in an arithmetic tree.
   */
  | {
      readonly op: 'within';
      readonly args: readonly [Expression, Expression];
      readonly tolerance: number;
    };

/**
 * Facts an expression reads. Flat dotted paths; values already extracted and provenanced.
 *
 * THE BAG IS A VOCABULARY, NOT JUST A LOOKUP. Which keys are PRESENT declares which facts exist in
 * this context, independently of whether they hold a value:
 *
 *   * present, non-null  → the value.
 *   * present, `null`    → the fact belongs here and has no value. Legitimate absence; propagates
 *                          as `null`, exactly as before.
 *   * ABSENT             → the rule referenced something that is not a fact at all. Raises.
 *
 * The third case is the whole point. Before this distinction existed, a typo'd path and a genuinely
 * missing figure both evaluated to `null`, so a rule pointing at `f29.151` when the bag carried
 * `f29.codigo.151` quietly produced no finding and reported a clean month. A builder must therefore
 * declare a fact it knows about but lacks — `{'bhe.retencion': null}` — rather than omitting it.
 */
export interface EvaluationContext {
  readonly facts: Readonly<Record<string, RuleValue>>;
  /** The date the rule is being applied AS OF — drives normativa lookup, never `now`. */
  readonly asOf: string;
}

export interface EvaluationResult {
  readonly value: RuleValue;
  /** Field paths actually read. The provenance chain of a derived value is built from these. */
  readonly readPaths: readonly string[];
}

/** Every field path an expression can read, without evaluating it. Used to check applicability. */
export function referencedPaths(expr: Expression): readonly string[] {
  const out = new Set<string>();
  const walk = (e: Expression): void => {
    if (e.op === 'field') {
      out.add(e.path);
      return;
    }
    if (e.op === 'lit') return;
    if (e.op === 'in') {
      walk(e.args[0]);
      return;
    }
    for (const a of e.args) walk(a);
  };
  walk(expr);
  return [...out].sort();
}

/**
 * Referenced paths the fact bag does not DECLARE — a rule's typos, found without running it.
 *
 * WHY A PRE-FLIGHT CHECK AND NOT JUST THE EVALUATOR'S THROW. Evaluation is lazy: `if`, `and` and
 * `or` short-circuit, so a bad path sitting in a branch that is not taken is never read and never
 * raises. The rule looks healthy until the day the condition flips — and on that day it fails in a
 * nightly run instead of at review time. This walks the WHOLE tree, so the loop can refuse a rule
 * up front rather than shipping a latent silent miss.
 *
 * Sorted, so a caller's error message is stable.
 */
export function unknownPaths(
  expr: Expression,
  facts: Readonly<Record<string, RuleValue>>,
): readonly string[] {
  return referencedPaths(expr).filter((p) => !Object.hasOwn(facts, p));
}

/**
 * Build the "unknown path" message, pointing at the likeliest intended path.
 *
 * A bare "unknown fact path" would leave a human eye-diffing two long dotted strings. The near-miss
 * is picked structurally rather than by edit distance: sharing the FIRST segment means the same
 * surface (`f29.…`), and sharing the LAST means the same código (`….151`) — between them they cover
 * the two ways these paths actually get mistyped.
 */
function unknownPathMessage(path: string, known: readonly string[]): string {
  const head = path.slice(0, path.indexOf('.') === -1 ? path.length : path.indexOf('.'));
  const tail = path.slice(path.lastIndexOf('.') + 1);
  const near = known
    .filter((k) => k !== path && (k.startsWith(`${head}.`) || k.endsWith(`.${tail}`)))
    .sort()
    .slice(0, 3);
  const hint =
    near.length > 0
      ? ` Did you mean ${near.map((n) => `'${n}'`).join(' or ')}?`
      : known.length === 0
        ? ' The fact bag is empty.'
        : '';
  // The rule is broken, not the data — say so, so nobody reads this as a missing figure.
  return (
    `rule references '${path}', which the fact bag does not declare.${hint} ` +
    `A fact that belongs here but has no value must be declared as null, not omitted — ` +
    `otherwise a typo is indistinguishable from an absent figure and the rule silently ` +
    `produces no finding.`
  );
}

/** Structural depth — the loop's `propose` stage caps this so a generated rule stays readable. */
export function depth(expr: Expression): number {
  if (expr.op === 'lit' || expr.op === 'field') return 1;
  if (expr.op === 'in') return 1 + depth(expr.args[0]);
  return 1 + Math.max(...expr.args.map(depth));
}

/**
 * Render an expression as readable text for a human reviewer and for the nightly report.
 *
 * Inspectability is half the reason rules are data; a rule nobody can read is as opaque as the
 * conditional it replaced. Pure and total, like the evaluator.
 */
export function explain(expr: Expression): string {
  switch (expr.op) {
    case 'lit':
      return expr.value === null ? 'null' : JSON.stringify(expr.value);
    case 'field':
      return expr.path;
    case 'in':
      return `${explain(expr.args[0])} ∈ {${expr.args[1].map((v) => JSON.stringify(v)).join(', ')}}`;
    case 'within':
      return `|${explain(expr.args[0])} − ${explain(expr.args[1])}| ≤ ${expr.tolerance}`;
    case 'if':
      return `if ${explain(expr.args[0])} then ${explain(expr.args[1])} else ${explain(expr.args[2])}`;
    case 'not':
    case 'abs':
    case 'neg':
    case 'isNull':
      return `${expr.op}(${explain(expr.args[0])})`;
    default:
      return `(${expr.args.map(explain).join(` ${SYMBOL[expr.op] ?? expr.op} `)})`;
  }
}

const SYMBOL: Readonly<Record<string, string>> = {
  add: '+',
  sub: '−',
  mul: '×',
  div: '÷',
  eq: '=',
  ne: '≠',
  lt: '<',
  lte: '≤',
  gt: '>',
  gte: '≥',
  and: 'and',
  or: 'or',
  coalesce: '??',
};

/**
 * Maximum nesting depth. The AST cannot recurse, so this is a stack guard against a pathological
 * generated expression, not a termination guarantee — totality already comes from the grammar.
 */
export const MAX_EVAL_DEPTH = 64;

/**
 * Evaluate an expression. Pure, total, deterministic.
 *
 * ── THE SEMANTICS, which matter more than the code ────────────────────────────────────────────
 *
 * **`null` is ABSENCE and it PROPAGATES.** `add(null, 5)` is `null`, never `5` and never `0`.
 * Coercing an absent figure to zero is this project's oldest trap — a missing monto silently
 * becoming 0 turns "we do not know" into "it is nothing", which reads as a reconciled month.
 * `coalesce` is the explicit opt-in when zero really is the right reading.
 *
 * **Comparisons over absence yield absence.** `eq(null, 0)` is `null`, not `false`. Returning
 * `false` would let a rule read "the figures differ" from data it never had.
 *
 * **`and`/`or` are three-valued (Kleene), so a decided operand still decides.** `and(false, null)`
 * is `false` — one false operand settles it regardless of what is unknown. `and(true, null)` is
 * `null`. Same, dually, for `or`. This is what keeps a partially-absent month from being either
 * silently cleared or silently flagged.
 *
 * **Type errors THROW; absence does not.** A string where a number belongs, or a fractional peso,
 * is a bug in the rule or in the extraction feeding it — raised as `EvaluationError` rather than
 * folded into `null`, because a rule that quietly evaluates to "unknown" suppresses findings.
 *
 * **Integer pesos only.** Chilean tax amounts are whole pesos; `div` truncates toward zero and
 * division by zero is `null` (an absence, not a crash — the AST promises this).
 */
export function evaluate(expr: Expression, ctx: EvaluationContext): EvaluationResult {
  const readPaths = new Set<string>();
  const value = evalNode(expr, ctx, readPaths, 0);
  return { value, readPaths: [...readPaths].sort() };
}

function evalNode(
  expr: Expression,
  ctx: EvaluationContext,
  readPaths: Set<string>,
  depth: number,
): RuleValue {
  if (depth > MAX_EVAL_DEPTH) {
    throw new EvaluationError(`expression nests deeper than ${MAX_EVAL_DEPTH} levels`);
  }
  const go = (e: Expression): RuleValue => evalNode(e, ctx, readPaths, depth + 1);

  switch (expr.op) {
    case 'lit':
      return expr.value;

    case 'field': {
      readPaths.add(expr.path);
      // A path the bag does not DECLARE is a broken rule, not an absent figure. Legitimate absence
      // is `{path: null}` and still returns `null` below; only an undeclared path reaches here.
      if (!Object.hasOwn(ctx.facts, expr.path)) {
        throw new EvaluationError(unknownPathMessage(expr.path, Object.keys(ctx.facts)));
      }
      return ctx.facts[expr.path] ?? null;
    }

    case 'add':
    case 'sub':
    case 'mul': {
      const args = expr.args.map(go);
      if (args.some((a) => a === null)) return null;
      const nums = args.map((a) => asNumber(a, expr.op));
      if (nums.length === 0) return null;
      const [head, ...tail] = nums as [number, ...number[]];
      if (expr.op === 'add') return tail.reduce((a, b) => a + b, head);
      if (expr.op === 'sub') return tail.reduce((a, b) => a - b, head);
      return tail.reduce((a, b) => a * b, head);
    }

    case 'div': {
      const a = go(expr.args[0]);
      const b = go(expr.args[1]);
      if (a === null || b === null) return null;
      const divisor = asNumber(b, 'div');
      // Promised by the AST: division by zero is an absence, never an exception.
      if (divisor === 0) return null;
      return Math.trunc(asNumber(a, 'div') / divisor);
    }

    case 'abs':
    case 'neg': {
      const a = go(expr.args[0]);
      if (a === null) return null;
      const n = asNumber(a, expr.op);
      return expr.op === 'abs' ? Math.abs(n) : -n;
    }

    case 'eq':
    case 'ne': {
      const a = go(expr.args[0]);
      const b = go(expr.args[1]);
      // Absence is not equality and not inequality — it is unknown.
      if (a === null || b === null) return null;
      return expr.op === 'eq' ? a === b : a !== b;
    }

    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte': {
      const a = go(expr.args[0]);
      const b = go(expr.args[1]);
      if (a === null || b === null) return null;
      const x = asNumber(a, expr.op);
      const y = asNumber(b, expr.op);
      if (expr.op === 'lt') return x < y;
      if (expr.op === 'lte') return x <= y;
      if (expr.op === 'gt') return x > y;
      return x >= y;
    }

    case 'and':
    case 'or': {
      // Kleene three-valued, evaluated lazily so a decided operand short-circuits the rest.
      const decisive = expr.op === 'and' ? false : true;
      let sawNull = false;
      for (const arg of expr.args) {
        const v = go(arg);
        if (v === null) {
          sawNull = true;
          continue;
        }
        const b = asBoolean(v, expr.op);
        if (b === decisive) return decisive;
      }
      return sawNull ? null : !decisive;
    }

    case 'not': {
      const a = go(expr.args[0]);
      return a === null ? null : !asBoolean(a, 'not');
    }

    case 'isNull':
      // The ONE operator that answers rather than propagates — that is its whole purpose.
      return go(expr.args[0]) === null;

    case 'coalesce': {
      for (const arg of expr.args) {
        const v = go(arg);
        if (v !== null) return v;
      }
      return null;
    }

    case 'if': {
      const cond = go(expr.args[0]);
      // An unknown condition yields an unknown result. Falling through to the else branch would
      // turn "we could not tell" into a definite answer.
      if (cond === null) return null;
      return asBoolean(cond, 'if') ? go(expr.args[1]) : go(expr.args[2]);
    }

    case 'in': {
      const v = go(expr.args[0]);
      if (v === null) return null;
      return expr.args[1].includes(v);
    }

    case 'within': {
      const a = go(expr.args[0]);
      const b = go(expr.args[1]);
      if (a === null || b === null) return null;
      return Math.abs(asNumber(a, 'within') - asNumber(b, 'within')) <= Math.abs(expr.tolerance);
    }
  }
}

/** Numbers only, integers only. A string or a fraction is a rule/extraction bug — raise it. */
function asNumber(v: RuleValue, op: string): number {
  if (typeof v !== 'number') {
    throw new EvaluationError(`${op} requires a number, got ${JSON.stringify(v)}`);
  }
  if (!Number.isInteger(v)) {
    throw new EvaluationError(`${op} requires an integer (montos are whole pesos), got ${v}`);
  }
  return v;
}

function asBoolean(v: RuleValue, op: string): boolean {
  if (typeof v !== 'boolean') {
    throw new EvaluationError(`${op} requires a boolean, got ${JSON.stringify(v)}`);
  }
  return v;
}
