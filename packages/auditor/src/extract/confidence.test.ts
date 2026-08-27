import { describe, expect, it } from 'vitest';
import { DEFAULT_WEIGHTS, REVIEW_THRESHOLD, needsReview, scoreConfidence } from './confidence.js';
import type { ConfidenceSignal } from './record.js';

const signal = (code: ConfidenceSignal['code']): ConfidenceSignal => ({
  code,
  field: 'montoNeto',
  detail: 'test',
});

describe('scoreConfidence', () => {
  it('is 1 for a clean parse', () => {
    expect(scoreConfidence([])).toBe(1);
  });

  it('compounds independent doubts rather than averaging them', () => {
    const one = scoreConfidence([signal('alias_fallback')]);
    const two = scoreConfidence([signal('alias_fallback'), signal('alias_fallback')]);
    expect(two).toBeLessThan(one);
    expect(two).toBeCloseTo(DEFAULT_WEIGHTS.alias_fallback ** 2, 4);
  });

  it('is order-independent, so re-running yields the same number', () => {
    const a = scoreConfidence([signal('unknown_keys'), signal('missing_field')]);
    const b = scoreConfidence([signal('missing_field'), signal('unknown_keys')]);
    expect(a).toBe(b);
  });

  it('treats structural drift as near-fatal — it is how a scraper breaks', () => {
    expect(scoreConfidence([signal('structural_drift')])).toBeLessThan(REVIEW_THRESHOLD);
  });

  it('treats an internal total mismatch as severe (BPST under-counted a real month by 44.5%)', () => {
    expect(scoreConfidence([signal('internal_total_mismatch')])).toBeLessThan(REVIEW_THRESHOLD);
  });

  it('does not send a clean parse with unknown keys to review', () => {
    // `.loose()` doing its job is interesting for clustering, not a reason to distrust the parse.
    expect(needsReview(scoreConfidence([signal('unknown_keys')]))).toBe(false);
  });

  it('sends two moderate doubts to review', () => {
    expect(needsReview(scoreConfidence([signal('alias_fallback'), signal('missing_field')]))).toBe(
      true,
    );
  });

  it('stays within [0,1] and rounds, so float bits cannot differ between runs', () => {
    const many = Array.from({ length: 20 }, () => signal('structural_drift'));
    const score = scoreConfidence(many);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
    expect(Number.isInteger(score * 10_000)).toBe(true);
  });
});
