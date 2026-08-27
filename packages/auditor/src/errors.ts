// Errors for the auditor package (ADR-043).
//
// `NotImplemented` is load-bearing, not decoration. The alternative — a stub that returns `[]`,
// `null`, or a plausible-looking empty result — is the failure mode this whole package exists to
// prevent: a silently wrong figure delivered with confidence. Same reasoning ADR-034 used to pick
// the DOM over a re-derived GWT schema (prefer the source that fails LOUDLY over the one that can
// lie quietly), applied to our own unfinished code.

/** Base for everything this package throws, so a caller can distinguish it from a `SiiError`. */
export class AuditorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * Thrown by a deferred implementation. NEVER caught-and-defaulted by the loop: a stage that hits
 * one records `status: 'not_implemented'` in the run manifest and moves on, so the manifest is an
 * honest account of what the night actually did.
 *
 * @param what   The operation, e.g. `'NormalizedStore.upsertTaxpayer'`.
 * @param why    What must exist first, e.g. `'the SQLite adapter (ADR-043 alt. 4)'`.
 */
export class NotImplemented extends AuditorError {
  readonly what: string;
  readonly why: string;

  constructor(what: string, why: string) {
    super(`${what} is not implemented yet — ${why}`);
    this.what = what;
    this.why = why;
  }
}

/** A stored record failed its own invariant (a rule with no provenance, an answer with no cite). */
export class IntegrityError extends AuditorError {}

/** The confidentiality boundary was about to be crossed (`confidential.ts`). Never downgraded. */
export class ConfidentialityError extends AuditorError {}

/**
 * A rule expression could not be evaluated because it is ILL-TYPED — a string where a number was
 * required, a non-integer peso, an operator applied to the wrong arity.
 *
 * Deliberately distinct from a `null` result. `null` means the DATA was absent, which is ordinary
 * in this domain and propagates. This means the RULE (or the extraction feeding it) is wrong, and
 * it is raised loudly rather than folded into `null` — a rule that silently evaluates to "unknown"
 * because of a type bug would suppress findings without anyone noticing.
 */
export class EvaluationError extends AuditorError {}
