import { describe, expect, it } from 'vitest';
import { IntegrityError } from '../errors.js';
import {
  amend,
  canTransition,
  createRejectionLedger,
  promote,
  proposalFingerprint,
  propose,
  retire,
} from './promotion.js';
import type { GateApproval, VersionAuthor } from './promotion.js';
import type { Expression } from './expression.js';
import type { RuleRecord } from './record.js';

const author: VersionAuthor = {
  by: 'loop:run-1',
  at: '2026-08-06T03:00:00.000Z',
  rationale: 'mined from cluster c-1',
};

const expr: Expression = {
  op: 'in',
  args: [{ op: 'field', path: 'dte.tipo' }, ['61']],
};

const base = {
  kind: 'classification' as const,
  title: 'Nota de crédito revierte el documento que corrige',
  applicability: { effectiveFrom: '2020-01-01', effectiveTo: null },
  provenance: {
    anchors: ['DL-825/1974#art-57'],
    references: ['ADR-022'],
    origin: 'observed' as const,
  },
};

const newRule = (): RuleRecord => propose('reversa-nc', base, expr, 0.2, author);

const approval = (subject: string, over: Partial<GateApproval> = {}): GateApproval => ({
  verdict: 'promote',
  subject,
  goldenSetVersion: 'golden-v1',
  evaluatedAt: '2026-08-06T03:05:00.000Z',
  evalRunId: 'run-1',
  deltas: { 'extraction.accuracy': 0.01 },
  ...over,
});

describe('transitions', () => {
  it('permits only the legal edges', () => {
    expect(canTransition('candidate', 'validated')).toBe(true);
    expect(canTransition('candidate', 'retired')).toBe(true);
    expect(canTransition('validated', 'retired')).toBe(true);
    expect(canTransition('validated', 'candidate')).toBe(false);
    expect(canTransition('retired', 'validated')).toBe(false);
    expect(canTransition('retired', 'candidate')).toBe(false);
  });
});

describe('propose', () => {
  it('always mints a candidate — there is no path to a born-validated rule', () => {
    const rule = newRule();
    expect(rule.current.status).toBe('candidate');
    expect(rule.current.version).toBe(1);
    expect(rule.history).toHaveLength(1);
  });

  it('clamps confidence into [0,1]', () => {
    expect(propose('r', base, expr, 5, author).current.confidence).toBe(1);
    expect(propose('r', base, expr, -2, author).current.confidence).toBe(0);
  });
});

describe('promote', () => {
  it('validates a candidate carrying a well-formed approval', () => {
    const rule = newRule();
    const promoted = promote(rule, approval('reversa-nc@1'));
    expect(promoted.current.status).toBe('validated');
    expect(promoted.history).toHaveLength(1);
    expect(promoted.history.at(-1)?.status).toBe('validated');
  });

  it('refuses an approval for a different version — approvals are per-version', () => {
    const rule = newRule();
    expect(() => promote(rule, approval('reversa-nc@2'))).toThrow(IntegrityError);
  });

  it('refuses a reject verdict', () => {
    const rule = newRule();
    expect(() => promote(rule, approval('reversa-nc@1', { verdict: 'reject' }))).toThrow(
      IntegrityError,
    );
  });

  it('refuses an approval with no golden-set version', () => {
    const rule = newRule();
    expect(() => promote(rule, approval('reversa-nc@1', { goldenSetVersion: '' }))).toThrow(
      /golden-set/,
    );
  });

  it('refuses an approval missing its evaluation identity', () => {
    const rule = newRule();
    expect(() => promote(rule, approval('reversa-nc@1', { evalRunId: '' }))).toThrow(
      IntegrityError,
    );
  });

  it('refuses to validate a rule with no provenance', () => {
    const bare = propose(
      'no-cite',
      { ...base, provenance: { anchors: [], references: [], origin: 'mined' } },
      expr,
      0.2,
      author,
    );
    expect(() => promote(bare, approval('no-cite@1'))).toThrow(/provenance/);
  });

  it('refuses to re-promote an already validated rule', () => {
    const validated = promote(newRule(), approval('reversa-nc@1'));
    expect(() => promote(validated, approval('reversa-nc@1'))).toThrow(/illegal transition/);
  });
});

describe('amend', () => {
  it('appends a CANDIDATE version and leaves the validated one governing', () => {
    const validated = promote(newRule(), approval('reversa-nc@1'));
    const amended = amend(validated, { op: 'lit', value: true }, 0.3, author);

    expect(amended.current.version).toBe(2);
    expect(amended.current.status).toBe('candidate');
    expect(amended.history).toHaveLength(2);
    // The prior version is preserved untouched — history is append-only.
    expect(amended.history[0]?.status).toBe('validated');
  });

  it('refuses to amend a retired rule', () => {
    const retired = retire(newRule(), 'superseded', author);
    expect(() => amend(retired, expr, 0.5, author)).toThrow(/retired/);
  });
});

describe('retire', () => {
  it('requires a reason — it is what stops the idea returning', () => {
    expect(() => retire(newRule(), '   ', author)).toThrow(/reason/);
  });

  it('retires a validated rule', () => {
    const validated = promote(newRule(), approval('reversa-nc@1'));
    const retired = retire(validated, 'replaced by reversa-nc-v2', author);
    expect(retired.current.status).toBe('retired');
    expect(retired.current.rationale).toBe('replaced by reversa-nc-v2');
  });
});

describe('proposalFingerprint + rejection ledger', () => {
  it('ignores rationale and timestamp — a re-worded bad idea is still barred', () => {
    const a = proposalFingerprint('classification', expr, 'REGS');
    const b = proposalFingerprint('classification', expr, 'REGS');
    expect(a).toBe(b);

    const ledger = createRejectionLedger();
    expect(ledger.isBarred(a)).toBe(false);
    ledger.record({
      fingerprint: a,
      ruleId: 'reversa-nc',
      reason: 'no improvement',
      rejectedAt: author.at,
      evalRunId: 'run-1',
      timesProposed: 0,
    });
    expect(ledger.isBarred(b)).toBe(true);
  });

  it('is insensitive to key order inside the expression', () => {
    const one: Expression = {
      op: 'within',
      args: [
        { op: 'lit', value: 1 },
        { op: 'lit', value: 2 },
      ],
      tolerance: 5,
    };
    const two: Expression = {
      tolerance: 5,
      args: [
        { value: 1, op: 'lit' },
        { op: 'lit', value: 2 },
      ],
      op: 'within',
    } as Expression;
    expect(proposalFingerprint('reconciliation', one, '*')).toBe(
      proposalFingerprint('reconciliation', two, '*'),
    );
  });

  it('counts repeat proposals so a stuck generator is visible', () => {
    const ledger = createRejectionLedger();
    const fp = proposalFingerprint('anomaly', expr, '*');
    const entry = {
      fingerprint: fp,
      ruleId: 'r',
      reason: 'dismissed',
      rejectedAt: author.at,
      evalRunId: 'run-1',
      timesProposed: 0,
    };
    ledger.record(entry);
    ledger.record(entry);
    expect(ledger.entries()[0]?.timesProposed).toBe(2);
  });
});
