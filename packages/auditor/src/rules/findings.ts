// Rules → findings (ADR-043 §I3/§I4) — the step that turns versioned tax logic into something a
// contador reads.
//
// THE EXPRESSION IS THE ASSERTION THAT MUST HOLD, not the description of a problem. A
// reconciliation evaluates TRUE when the figures agree, so a finding is raised when it comes back
// FALSE. Writing it the other way round reads worse and, more importantly, makes the `null` case
// ambiguous — see below, which is the whole reason this module is careful.
//
// THREE RULES, each preventing a silent failure:
//
//   1. `null` NEVER produces a finding. `null` is "we do not know" — a month whose F29 was never
//      read cannot be reconciled, and calling that a discrepancy invents one out of missing data.
//      The fastest way to make a real finding ignored is to bury it in twenty that were never real.
//      Callers who need to distinguish "reconciled" from "could not be checked" ask for
//      `collectUnknown`; conflating them would report the second as the first.
//   2. Only VALIDATED rules produce findings. The gate is the only way into production
//      (ADR-043 §I4) — a candidate must not reach a report however confident its author was.
//   3. A rule referencing a fact the bag does not declare RAISES. That is what W2's `unknownPaths`
//      was built for: without it a typo'd path evaluates to "unknown", produces nothing, and reports
//      a clean month.

import { createHash } from 'node:crypto';
import { evaluate, unknownPaths } from './expression.js';
import { appliesOn } from './record.js';
import { EvaluationError } from '../errors.js';
import type { RuleValue } from './expression.js';
import type { RuleKind, RuleRecord } from './record.js';
import type { ProducedFinding } from '../eval/metrics.js';

export interface FindingContext {
  /** Pseudonymous subject (`confidential.ts`). Never a RUT. */
  readonly taxpayer: string;
  /** The período (`YYYYMM`) or año (`YYYY`) under evaluation. */
  readonly period: string;
  /** The date the rules are applied AS OF — the commercial period, never `now`. */
  readonly asOf: string;
  readonly facts: Readonly<Record<string, RuleValue>>;
}

/** A rule that could not be decided, and why. NOT a finding — the distinction is the point. */
export interface UndecidedRule {
  readonly ruleId: string;
  readonly period: string;
  /** The rule's own title, so a report can say what went unchecked rather than just how many. */
  readonly describes: string;
}

export interface FindingOutcome {
  readonly findings: readonly ProducedFinding[];
  /** Rules whose assertion evaluated to `null`. Reported separately, never as "balanced". */
  readonly unknown: readonly UndecidedRule[];
}

/**
 * Kinds that may auto-issue a finding.
 *
 * `anomaly` is excluded because `RuleKind` says so in as many words — "a condition that, when met,
 * is worth an auditor's attention. Never auto-issues a finding." `classification` is excluded
 * because it labels records; it does not assert anything that can be violated.
 */
const FINDING_KINDS: readonly RuleKind[] = ['reconciliation', 'obligation'];

export function produceFindings(
  rules: readonly RuleRecord[],
  ctx: FindingContext,
): Promise<readonly ProducedFinding[]>;
export function produceFindings(
  rules: readonly RuleRecord[],
  ctx: FindingContext,
  options: { readonly collectUnknown: true },
): Promise<FindingOutcome>;
export async function produceFindings(
  rules: readonly RuleRecord[],
  ctx: FindingContext,
  options?: { readonly collectUnknown?: boolean },
): Promise<readonly ProducedFinding[] | FindingOutcome> {
  const findings: ProducedFinding[] = [];
  const unknown: UndecidedRule[] = [];

  // Sorted so two identical runs emit findings in the same order (ADR-043 §I5) — a report diff
  // should show what changed, not how the rule store happened to iterate.
  const applicable = [...rules]
    .sort((a, b) => a.id.localeCompare(b.id))
    .filter((r) => r.current.status === 'validated')
    .filter((r) => FINDING_KINDS.includes(r.kind))
    .filter((r) => appliesOn(r, ctx.asOf));

  for (const rule of applicable) {
    // PRE-FLIGHT (W2). The evaluator would also raise, but only for a path it actually reads —
    // lazy branches hide the rest until the day the condition flips. Checking the whole tree here
    // rejects the rule up front rather than shipping a latent silent miss.
    const missing = unknownPaths(rule.current.expression, ctx.facts);
    if (missing.length > 0) {
      throw new EvaluationError(
        `rule ${rule.id} references ${missing.map((p) => `'${p}'`).join(', ')}, which the fact ` +
          `bag for period ${ctx.period} does not declare — the rule cannot be evaluated, and ` +
          'evaluating it to "unknown" would report a clean period instead of a broken rule',
      );
    }

    const { value } = evaluate(rule.current.expression, { facts: ctx.facts, asOf: ctx.asOf });

    // ABSENCE IS NOT A DISCREPANCY. Recorded as undecided so a caller can say "not checked"
    // instead of silently implying "checked and fine".
    if (value === null) {
      unknown.push({ ruleId: rule.id, period: ctx.period, describes: rule.title });
      continue;
    }

    // The assertion held — nothing to report.
    if (value === true) continue;

    // Anything non-boolean is a malformed rule, not a finding: a reconciliation that returns a
    // number has been written wrong, and raising a finding from it would attach a real-looking
    // discrepancy to a rule nobody can read.
    if (value !== false) {
      throw new EvaluationError(
        `rule ${rule.id} is a ${rule.kind} but its expression evaluated to ` +
          `${JSON.stringify(value)} rather than a boolean — a ${rule.kind} expression must be the ` +
          'assertion that must hold, so it can only be true, false, or null',
      );
    }

    findings.push({
      id: findingId(rule.id, rule.current.version, ctx.taxpayer, ctx.period),
      ruleId: rule.id,
      period: ctx.period,
      describes: rule.title,
      materiality: materialityOf(rule, ctx),
      // The rule's declared anchors, verbatim. Whether they RESOLVE for `asOf` is a separate
      // question, measured by `normativaMetrics` — a finding is arithmetic over extracted facts,
      // and the citation supports why the figures should agree rather than being the claim itself.
      citedAnchors: [...rule.provenance.anchors],
    });
  }

  if (options?.collectUnknown === true) return { findings, unknown };
  return findings;
}

/**
 * Deterministic finding id.
 *
 * Keyed by rule VERSION as well as rule, so a re-worded or re-tuned rule produces a new finding
 * rather than silently mutating one an auditor already dismissed.
 */
function findingId(ruleId: string, version: number, taxpayer: string, period: string): string {
  const digest = createHash('sha256')
    .update(`${ruleId}@${version}|${taxpayer}|${period}`, 'utf8')
    .digest('hex');
  return `finding:${digest.slice(0, 16)}`;
}

/**
 * Pesos at stake, when the rule's shape makes that computable.
 *
 * For a `within` reconciliation the gap between the two sides IS the materiality, so it is derived
 * rather than guessed. Every other shape reports `null` — NOT 0, which would rank a real but
 * unquantified finding below a trivial quantified one in the auditor's queue.
 */
function materialityOf(rule: RuleRecord, ctx: FindingContext): number | null {
  const expr = rule.current.expression;
  if (expr.op !== 'within') return null;

  const left = evaluate(expr.args[0], { facts: ctx.facts, asOf: ctx.asOf }).value;
  const right = evaluate(expr.args[1], { facts: ctx.facts, asOf: ctx.asOf }).value;
  if (typeof left !== 'number' || typeof right !== 'number') return null;
  return Math.abs(left - right);
}
