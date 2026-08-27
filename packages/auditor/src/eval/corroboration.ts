// Golden-set independence (W8) — is the ground truth actually independent of the parser?
//
// THE FAILURE THIS MEASURES. A field whose expected value was READ OFF THE ARTIFACT by a human is
// not independent evidence. The golden set and the parser looked at the same bytes, so they can be
// wrong in the same way, and then "accuracy 1.0" measures agreement between two copies of one
// mistake. `bte-resumen` reading honorarios as retención is exactly that shape: the gate catches it
// today only because the RECONCILED fields carry arithmetic confirmation. The read-only ones would
// have agreed with the bug.
//
// WHAT COUNTS AS INDEPENDENT:
//
//   * `arithmetic` — an identity over OTHER golden fields (`liquido = brutos − retenido`). To fool
//     it a parser must be wrong about several fields in a mutually consistent way, which is a much
//     smaller target than being wrong about one.
//   * `cross-source` — a second SII surface reports the same figure. Two independent reads.
//   * `none` (or absent) — read from the artifact only. Honest, and NOT independent.
//
// A CONTRADICTED IDENTITY IS FATAL, not a downgrade. Ground truth that disagrees with itself is
// worse than no ground truth: every metric computed against it is measured against a value the set
// itself says is wrong, and the gate would then be enforcing that wrongness.

import { IntegrityError } from '../errors.js';
import { evaluate, unknownPaths } from '../rules/expression.js';
import type { Expression, RuleValue } from '../rules/expression.js';
import type { ExpectedField } from './golden.js';

export type CorroborationKind =
  /** An identity over other golden fields, evaluated here. */
  | 'arithmetic'
  /** A second, independent SII surface reports the same figure. */
  | 'cross-source'
  /** Read from the artifact only. Declared honestly; still not independent. */
  | 'none';

export interface Corroboration {
  readonly kind: CorroborationKind;
  /** Required for `arithmetic`: an assertion over field paths that must evaluate TRUE. */
  readonly identity?: Expression;
  /** Required for `cross-source`: the other artifact and path that agree. */
  readonly agreesWith?: { readonly artifact: string; readonly path: string };
  /** Free text for a human reviewer — how the confirmation was obtained. */
  readonly note?: string;
}

export interface CorroborationReport {
  /** Verified fields with independent confirmation, sorted. */
  readonly corroborated: readonly string[];
  /** Verified fields read from the artifact only — the "effectively decorative" ones. */
  readonly uncorroborated: readonly string[];
  /**
   * Identities that evaluated FALSE. Always empty in a returned report: a contradiction throws
   * rather than being reported, since a self-inconsistent golden set must not be used at all. The
   * field exists so a caller that catches the error can see the shape.
   */
  readonly contradicted: readonly string[];
  /**
   * `corroborated / verified`. `null` — never 0 — when there are no verified fields: nothing to
   * measure is a different claim from nothing independent.
   */
  readonly independenceRatio: number | null;
}

/**
 * Check every verified field's corroboration, refusing a self-inconsistent set.
 *
 * The fact bag is the golden set's own expected values, keyed by `path`. An identity referencing a
 * path the set does not hold RAISES (W2's rule): that is a broken identity, not an uncorroborated
 * field, and reporting it as the latter would quietly downgrade a typo into a shrug.
 */
export function checkCorroboration(fields: readonly ExpectedField[]): CorroborationReport {
  // Unverified fields are already outside the accuracy denominator; judging their independence
  // would mix two different exclusions.
  const verified = fields.filter((f) => f.verified);

  // Every field is a fact, verified or not — an identity may legitimately lean on a value nobody
  // hand-checked, as long as it is present.
  const facts: Record<string, RuleValue> = {};
  for (const f of fields) facts[f.path] = f.expected;

  const corroborated: string[] = [];
  const uncorroborated: string[] = [];

  for (const f of verified) {
    const c = f.corroboration;

    if (c === undefined || c.kind === 'none') {
      uncorroborated.push(f.path);
      continue;
    }

    if (c.kind === 'cross-source') {
      if (c.agreesWith === undefined) {
        throw new IntegrityError(
          `golden field '${f.path}' claims cross-source corroboration but names no other ` +
            'artifact and path — an unnamed second source cannot be re-checked, so it is not one',
        );
      }
      corroborated.push(f.path);
      continue;
    }

    if (c.identity === undefined) {
      throw new IntegrityError(
        `golden field '${f.path}' claims arithmetic corroboration but carries no identity — ` +
          'there is nothing to evaluate, so the claim cannot be true',
      );
    }

    const missing = unknownPaths(c.identity, facts);
    if (missing.length > 0) {
      throw new IntegrityError(
        `the identity corroborating golden field '${f.path}' references ` +
          `${missing.map((p) => `'${p}'`).join(', ')}, which the golden set does not hold — ` +
          'a broken identity, not an uncorroborated field',
      );
    }

    const { value } = evaluate(c.identity, { facts, asOf: '' });

    if (value === false) {
      throw new IntegrityError(
        `golden set is INTERNALLY INCONSISTENT: the identity corroborating '${f.path}' evaluates ` +
          "false against the set's own values. Ground truth that contradicts itself is worse " +
          'than none — every metric measured against it is measured against a value the set says ' +
          'is wrong. Fix the expected values or drop the identity; do not proceed.',
      );
    }

    if (value === null) {
      // Unknown, not false: an identity over an absent value cannot confirm anything, but it does
      // not contradict either. Honest outcome is "not corroborated".
      uncorroborated.push(f.path);
      continue;
    }

    if (value !== true) {
      throw new IntegrityError(
        `the identity corroborating golden field '${f.path}' evaluated to ` +
          `${JSON.stringify(value)} rather than a boolean — an identity must be an assertion`,
      );
    }

    corroborated.push(f.path);
  }

  return {
    corroborated: [...corroborated].sort(),
    uncorroborated: [...uncorroborated].sort(),
    contradicted: [],
    independenceRatio: verified.length === 0 ? null : corroborated.length / verified.length,
  };
}
