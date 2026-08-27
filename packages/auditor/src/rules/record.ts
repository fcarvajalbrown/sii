// The rule record (ADR-043 §I3) — versioned, inspectable, provenanced tax logic.
//
// What lives here today as TypeScript conditionals and should migrate: `f22-codigos.ts`,
// `f29-codigos.ts` (157 códigos), `TIPOS_REVERSA` (the netting set that caused a phantom descuadre
// in 15 of 16 months when it was missing), the honorarios reconciliation's código 151-not-153
// distinction, and `monitor.ts`'s severity ladder. Each is real tax knowledge with a real source,
// currently unversioned and uncited.
//
// MIGRATION IS NOT AUTOMATIC AND MUST NOT BE. Every one of those needs its `provenance` filled in
// with a genuine citation, and this project does not yet have a normativa corpus to cite. A rule
// that claims `status: 'validated'` with a fabricated anchor would be worse than the conditional
// it replaced — it would look authoritative. Migration proceeds rule by rule, as the corpus covers
// each one.

import type { CitationAnchor } from '../kb/normativa.js';
import type { Expression } from './expression.js';

export type RuleId = string;

/**
 * The promotion lifecycle. Transitions are enforced by `promotion.ts`; this type only names them.
 *
 *   candidate  — proposed (by the loop or a human). NEVER applied to production output.
 *   validated  — passed the regression gate. The only state whose rules affect real findings.
 *   retired    — withdrawn. Kept forever: a retired rule's history is why it is not re-proposed.
 */
export type RuleStatus = 'candidate' | 'validated' | 'retired';

/** What a rule DOES when its expression holds. */
export type RuleKind =
  /** Classify or label a record (this DTE type reverses; this código is honorarios). */
  | 'classification'
  /** Two figures that must agree — the reconciliation shape (`iva`, `honorarios`). */
  | 'reconciliation'
  /** A compliance obligation with a deadline (F29 by day 12 or 20; the Art. 3 acuse clock). */
  | 'obligation'
  /** A condition that, when met, is worth an auditor's attention. Never auto-issues a finding. */
  | 'anomaly';

/** Where a rule applies. Empty fields mean "no restriction" — stated, not implied. */
export interface Applicability {
  /** Régimen codes, verbatim as SII sends them: `M14A`, `REGS`, `FAEL`, `SGGC`. */
  readonly regimenes?: readonly string[];
  /** Which forms/surfaces the rule reads. */
  readonly forms?: readonly ('F22' | 'F29' | 'F50' | 'RCV' | 'DJ' | 'BHE' | 'BPST')[];
  /**
   * The period range the rule is valid FOR — not when it was written. A rule about a régimen that
   * began in 2020 must not be applied to 2018 (the retrospectivity rule, ADR-043 §I2).
   */
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
}

/** Why we believe the rule. Non-empty for `validated` — enforced by `promotion.ts`. */
export interface RuleProvenance {
  /** Normativa anchors the rule encodes. The citation a finding renders. */
  readonly anchors: readonly CitationAnchor[];
  /** ADR ids / contract docs / audit logs that motivated it, e.g. `ADR-029`. */
  readonly references: readonly string[];
  /**
   * How it came to exist. `observed` = derived from live SII behaviour; `mined` = proposed by the
   * loop's stage 5; `auditor` = a human wrote it. Never `inferred` — a rule cannot come from a
   * model's prior (ADR-043 §I2).
   */
  readonly origin: 'observed' | 'mined' | 'auditor';
}

export interface RuleVersion {
  readonly version: number;
  readonly expression: Expression;
  readonly status: RuleStatus;
  /** [0,1]. For `mined` rules, the support observed in stage 4. For authored ones, the author's. */
  readonly confidence: number;
  readonly changedAt: string;
  /** Who or what made this version: `loop:<runId>` or an operator handle. */
  readonly changedBy: string;
  /** Free text: why this version exists, or why it was retired. Shown in the nightly report. */
  readonly rationale: string;
}

export interface RuleRecord {
  readonly id: RuleId;
  readonly kind: RuleKind;
  /** One line a contador would recognise, in Spanish where the domain is Spanish (CONVENTIONS). */
  readonly title: string;
  readonly applicability: Applicability;
  readonly provenance: RuleProvenance;
  /** Current version — always the last element of `history`. */
  readonly current: RuleVersion;
  /** Every version ever, oldest first. Append-only: nothing is edited in place. */
  readonly history: readonly RuleVersion[];
}

export const ruleRef = (rule: RuleRecord): string => `${rule.id}@${rule.current.version}`;

export interface RuleFilter {
  readonly status?: readonly RuleStatus[];
  readonly kind?: readonly RuleKind[];
  /** Only rules in force on this date. */
  readonly asOf?: string;
  readonly regimen?: string;
}

export interface RuleStore {
  /** Rules matching the filter, `id` ascending (deterministic). */
  list(filter?: RuleFilter): Promise<readonly RuleRecord[]>;
  get(id: RuleId): Promise<RuleRecord | null>;
  /** Persist a new version. Appends to history; never mutates an existing version. */
  putVersion(rule: RuleRecord): Promise<void>;
  /**
   * A content hash over every VALIDATED rule's current version. Stamped into the run manifest so
   * "same inputs and same rule-set version ⇒ identical output" is checkable, not just claimed.
   */
  ruleSetVersion(): Promise<string>;
}

/** True when the rule is in force on `date` per its applicability window. */
export function appliesOn(rule: RuleRecord, date: string): boolean {
  const { effectiveFrom, effectiveTo } = rule.applicability;
  if (date < effectiveFrom) return false;
  return effectiveTo === null || date < effectiveTo;
}
