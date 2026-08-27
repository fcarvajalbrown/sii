import { describe, expect, it } from 'vitest';
import { MIN_OBSERVATIONS, differences, mad, median, rankFromZ, robustZ } from './baseline.js';
import type { Observation } from './baseline.js';

describe('median / mad', () => {
  it('handles odd and even samples', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it('does not mutate its input', () => {
    const xs = [3, 1, 2];
    median(xs);
    expect(xs).toEqual([3, 1, 2]);
  });

  it('throws on an empty sample rather than inventing a value', () => {
    expect(() => median([])).toThrow(RangeError);
  });

  it('is zero for a constant sample', () => {
    expect(mad([5, 5, 5, 5])).toBe(0);
  });
});

describe('robustZ', () => {
  const history = [100, 102, 98, 101, 99, 100, 103];

  it('is near zero for a typical value', () => {
    expect(Math.abs(robustZ(100, history) ?? 99)).toBeLessThan(1);
  });

  it('is large for an outlier', () => {
    expect(Math.abs(robustZ(500, history) ?? 0)).toBeGreaterThan(3);
  });

  it('preserves sign — a collapse and a spike are different stories', () => {
    expect(robustZ(500, history)).toBeGreaterThan(0);
    expect(robustZ(1, history)).toBeLessThan(0);
  });

  it('abstains rather than returning 0 when history is too short', () => {
    expect(robustZ(100, [100, 101])).toBeNull();
  });

  it('needs MIN_OBSERVATIONS points', () => {
    const short = Array.from({ length: MIN_OBSERVATIONS - 1 }, (_, i) => 100 + i);
    const enough = Array.from({ length: MIN_OBSERVATIONS }, (_, i) => 100 + i);
    expect(robustZ(100, short)).toBeNull();
    expect(robustZ(100, enough)).not.toBeNull();
  });

  it('abstains on a constant history instead of dividing by zero', () => {
    // Every deviation would be infinitely surprising — never the useful reading.
    expect(robustZ(101, [100, 100, 100, 100, 100, 100, 100])).toBeNull();
  });

  it('resists a single contaminating outlier, unlike mean/sd', () => {
    // One wild month must not inflate the spread enough to hide itself.
    const contaminated = [100, 102, 98, 101, 99, 100, 100_000];
    expect(Math.abs(robustZ(100_000, contaminated) ?? 0)).toBeGreaterThan(3);
  });
});

describe('rankFromZ', () => {
  it('is monotone in |z| and saturating', () => {
    expect(rankFromZ(1)).toBeLessThan(rankFromZ(3));
    expect(rankFromZ(3)).toBeLessThan(rankFromZ(10));
    expect(rankFromZ(1000)).toBeLessThanOrEqual(1);
  });

  it('is symmetric in sign', () => {
    expect(rankFromZ(-4)).toBe(rankFromZ(4));
  });
});

describe('differences', () => {
  it('skips absent values instead of imputing zero', () => {
    const series: Observation[] = [
      { period: '202401', value: 100 },
      { period: '202402', value: null },
      { period: '202403', value: 130 },
      { period: '202404', value: 140 },
    ];
    // Only 202403→202404 has both sides present.
    expect(differences(series)).toEqual([10]);
  });

  it('is empty for a single observation', () => {
    expect(differences([{ period: '202401', value: 5 }])).toEqual([]);
  });
});
