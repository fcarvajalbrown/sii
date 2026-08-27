// The promotion state machine (ADR-043 §I4) — IMPLEMENTED, not deferred.
//
// This is the module that makes "nothing self-modifies without passing a gate" a property of the
// code rather than a promise in a document. It is pure, total and synchronous, so it is fully
// testable without a store, a clock or SII.
//
//                    ┌──────────────┐
//    propose ───────▶│  candidate   │──── gate approves ────▶┌───────────┐
//                    └──────────────┘                        │ validated │
//                           │                                └───────────┘
//                           │ gate rejects                          │
//                           ▼                                       │ superseded / withdrawn
//                    ┌──────────────┐◀──────────────────────────────┘
//                    │   retired    │   (terminal — revival needs a NEW version, and the
//                    └──────────────┘    rejection ledger must not already bar it)
//
// TWO RULES CARRY THE SAFETY:
//
//  1. `promote` REQUIRES a `GateApproval` and VALIDATES it — the right rule, the right version, a
//     real golden-set version, a real evaluation instant, and a `promote` verdict. It is not a
//     naming convention or a code-review habit; a caller cannot promote by passing `true`.
//  2. Amending a validated rule does NOT edit it. It appends a NEW version at `candidate`, while
//     the validated version stays live. Production behaviour changes only when the gate says so.

import { IntegrityError } from '../errors.js';
import type { Expression } from './expression.js';
import type { RuleRecord, RuleStatus, RuleVersion } from './record.js';

/**
 * Proof that the regression suite ran and approved this exact rule version.
 *
 * Produced ONLY by `eval/gate.ts`. Carrying the evidence (not just a boolean) means a promotion is
 * auditable after the fact: which golden set, which metrics moved, by how much.
 */
export interface GateApproval {
  readonly verdict: 'promote' | 'reject';
  /** `<ruleId>@<version>` this approval is for. Checked against the rule — no blanket approvals. */
  readonly subject: string;
  /** Golden-set snapshot the evaluation ran against. Empty string is rejected. */
  readonly goldenSetVersion: string;
  /** ISO instant of the evaluation. */
  readonly evaluatedAt: string;
  /** The eval run that produced it, for lookup in the persisted results. */
  readonly evalRunId: string;
  /** Metric deltas, positive = improvement. Rendered in the nightly report. */
  readonly deltas: Readonly<Record<string, number>>;
  /** Present when `verdict === 'reject'`: why. Stored in the ledger so it is not re-proposed. */
  readonly reason?: string;
}

/** A rejected candidate, kept so the loop does not re-propose the same idea every night. */
export interface RejectionEntry {
  /** Content fingerprint of the proposal — see `proposalFingerprint`. */
  readonly fingerprint: string;
  readonly ruleId: string;
  readonly reason: string;
  readonly rejectedAt: string;
  readonly evalRunId: string;
  /** How many times this same idea has been proposed. Rising counts mean stage 5 needs a fix. */
  readonly timesProposed: number;
}

export interface RejectionLedger {
  /** True when this exact proposal was already rejected — stage 5 must skip it. */
  isBarred(fingerprint: string): boolean;
  record(entry: RejectionEntry): void;
  entries(): readonly RejectionEntry[];
}

const LEGAL_TRANSITIONS: Readonly<Record<RuleStatus, readonly RuleStatus[]>> = {
  candidate: ['validated', 'retired'],
  validated: ['retired'],
  retired: [],
};

export function canTransition(from: RuleStatus, to: RuleStatus): boolean {
  return LEGAL_TRANSITIONS[from].includes(to);
}

export interface VersionAuthor {
  /** `loop:<runId>` or an operator handle. Never a person's name (`confidential.ts`). */
  readonly by: string;
  readonly at: string;
  readonly rationale: string;
}

/**
 * Create the first version of a new rule. Always `candidate`, whatever the caller intends —
 * there is no path that mints a validated rule directly.
 */
export function propose(
  id: string,
  base: Omit<RuleRecord, 'current' | 'history' | 'id'>,
  expression: Expression,
  confidence: number,
  author: VersionAuthor,
): RuleRecord {
  const version: RuleVersion = {
    version: 1,
    expression,
    status: 'candidate',
    confidence: clamp01(confidence),
    changedAt: author.at,
    changedBy: author.by,
    rationale: author.rationale,
  };
  return { ...base, id, current: version, history: [version] };
}

/**
 * Append a new CANDIDATE version to an existing rule (an amendment).
 *
 * The rule's current status is untouched: a validated rule keeps governing production output while
 * its proposed successor waits for the gate. This is what lets stage 6 evaluate a change without
 * the change already being live.
 */
export function amend(
  rule: RuleRecord,
  expression: Expression,
  confidence: number,
  author: VersionAuthor,
): RuleRecord {
  if (rule.current.status === 'retired') {
    throw new IntegrityError(
      `cannot amend retired rule ${rule.id} — a retired rule is terminal; create a new rule id`,
    );
  }
  const version: RuleVersion = {
    version: rule.current.version + 1,
    expression,
    status: 'candidate',
    confidence: clamp01(confidence),
    changedAt: author.at,
    changedBy: author.by,
    rationale: author.rationale,
  };
  return { ...rule, current: version, history: [...rule.history, version] };
}

/**
 * Promote a candidate to `validated`. THE ONLY PATH into production behaviour.
 *
 * Every precondition below is checked, in order, and each failure names what was wrong — a
 * promotion that fails silently would be indistinguishable from one that succeeded.
 */
export function promote(rule: RuleRecord, approval: GateApproval): RuleRecord {
  const ref = `${rule.id}@${rule.current.version}`;

  if (approval.verdict !== 'promote') {
    throw new IntegrityError(`gate verdict for ${ref} is '${approval.verdict}', not 'promote'`);
  }
  if (approval.subject !== ref) {
    throw new IntegrityError(
      `gate approval is for ${approval.subject}, not ${ref} — approvals are per-version`,
    );
  }
  if (!canTransition(rule.current.status, 'validated')) {
    throw new IntegrityError(`illegal transition ${rule.current.status} → validated for ${ref}`);
  }
  if (approval.goldenSetVersion.trim() === '') {
    throw new IntegrityError(
      `${ref}: approval carries no golden-set version — an empty golden set approves everything, ` +
        'so the gate must reject rather than pass (ADR-043 §I4)',
    );
  }
  if (approval.evaluatedAt.trim() === '' || approval.evalRunId.trim() === '') {
    throw new IntegrityError(`${ref}: approval is missing its evaluation instant or run id`);
  }
  if (rule.provenance.anchors.length === 0 && rule.provenance.references.length === 0) {
    throw new IntegrityError(
      `${ref}: refusing to validate a rule with no provenance — a validated rule states law, and ` +
        'an assertion without a citation is a bug (ADR-043 §I2)',
    );
  }

  const version: RuleVersion = { ...rule.current, status: 'validated' };
  return { ...rule, current: version, history: replaceLast(rule.history, version) };
}

/** Retire a rule version. Legal from `candidate` (gate rejected) and `validated` (superseded). */
export function retire(rule: RuleRecord, reason: string, author: VersionAuthor): RuleRecord {
  if (!canTransition(rule.current.status, 'retired')) {
    throw new IntegrityError(
      `illegal transition ${rule.current.status} → retired for ${rule.id}@${rule.current.version}`,
    );
  }
  if (reason.trim() === '') {
    throw new IntegrityError('a retirement needs a reason — it is what stops the idea returning');
  }
  const version: RuleVersion = {
    ...rule.current,
    status: 'retired',
    changedAt: author.at,
    changedBy: author.by,
    rationale: reason,
  };
  return { ...rule, current: version, history: replaceLast(rule.history, version) };
}

/**
 * Stable fingerprint of a proposal's SUBSTANCE — kind, applicability and expression, but NOT its
 * rationale, author or timestamp. Two nights that propose the same idea in different words produce
 * the same fingerprint, which is exactly what the rejection ledger needs to bar a repeat.
 */
export function proposalFingerprint(
  kind: string,
  expression: Expression,
  applicabilityKey: string,
): string {
  return `${kind}|${applicabilityKey}|${canonicalExpression(expression)}`;
}

/** Deterministic textual form of an expression: sorted keys, no whitespace. */
function canonicalExpression(expr: Expression): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v === null || typeof v !== 'object') return v;
    const src = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort()) out[k] = sort(src[k]);
    return out;
  };
  return JSON.stringify(sort(expr));
}

/** In-memory ledger. A persistent one wraps the same interface over the rule store. */
export function createRejectionLedger(seed: readonly RejectionEntry[] = []): RejectionLedger {
  const byFingerprint = new Map(seed.map((e) => [e.fingerprint, e]));
  return {
    isBarred: (fingerprint) => byFingerprint.has(fingerprint),
    record: (entry) => {
      const prior = byFingerprint.get(entry.fingerprint);
      byFingerprint.set(entry.fingerprint, {
        ...entry,
        timesProposed: (prior?.timesProposed ?? 0) + 1,
      });
    },
    entries: () =>
      [...byFingerprint.values()].sort((a, b) => a.fingerprint.localeCompare(b.fingerprint)),
  };
}

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

function replaceLast(
  history: readonly RuleVersion[],
  version: RuleVersion,
): readonly RuleVersion[] {
  return [...history.slice(0, -1), version];
}
