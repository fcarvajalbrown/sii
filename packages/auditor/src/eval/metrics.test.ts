import { describe, expect, it } from 'vitest';
import { REVIEW_THRESHOLD } from '../extract/confidence.js';
import { contentHash, instant } from '../provenance.js';
import type { ExtractionRecord } from '../extract/record.js';
import type { ExpectedCitation, ExpectedField, ExpectedFinding } from './golden.js';
import {
  extractionMetrics,
  f1,
  findingMetrics,
  flatten,
  normativaMetrics,
  ratio,
} from './metrics.js';
import type { ProducedFinding, ResolvedAnchor } from './metrics.js';

const ART = contentHash('a'.repeat(64));

const record = (value: unknown, over: Partial<ExtractionRecord> = {}): ExtractionRecord => ({
  id: 'x1',
  strategy: 'bpst-mensual@1',
  provenance: {
    kind: 'artifact',
    artifact: ART,
    url: 'https://zeus.sii.cl/cvc_cgi/bte/bte_indiv_cons2',
    retrievedAt: instant('2026-08-06T03:00:00.000Z'),
    strategy: 'bpst-mensual@1',
    locator: '/',
  },
  value,
  confidence: 1,
  signals: [],
  extractedAt: instant('2026-08-06T03:00:00.000Z'),
  taxpayer: 'tk-aaa',
  runId: 'run-1',
  ...over,
});

const field = (
  path: string,
  expected: ExpectedField['expected'],
  verified = true,
): ExpectedField => ({
  artifact: ART,
  path,
  expected,
  verified,
});

describe('flatten', () => {
  it('addresses nested values the way ExpectedField.path writes them', () => {
    expect(flatten({ rows: [{ montoNeto: 1000 }, { montoNeto: 2000 }] })).toEqual([
      ['rows[0].montoNeto', 1000],
      ['rows[1].montoNeto', 2000],
    ]);
  });

  it('treats null as a LEAF — an absent figure is a real value here', () => {
    expect(flatten({ total: null })).toEqual([['total', null]]);
  });

  it('is key-order independent', () => {
    expect(flatten({ b: 1, a: 2 })).toEqual(flatten({ a: 2, b: 1 }));
  });
});

describe('extractionMetrics', () => {
  it('scores exact field matches', () => {
    const m = extractionMetrics(
      [field('retencionTotal', 164368), field('boletas', 2)],
      [record({ retencionTotal: 164368, boletas: 2 })],
      0,
      0,
    );
    expect(m.fieldsCompared).toBe(2);
    expect(m.fieldsCorrect).toBe(2);
    expect(m.accuracy).toBe(1);
  });

  it('EXCLUDES unverified ground truth from the denominator', () => {
    // Counting unchecked fields as correct is the fastest route to a meaningless 99%.
    const m = extractionMetrics(
      [field('a', 1), field('b', 999, false)],
      [record({ a: 1, b: 2 })],
      0,
      0,
    );
    expect(m.fieldsCompared).toBe(1);
    expect(m.accuracy).toBe(1);
  });

  it('counts a MISSING extraction as incorrect — a miss is not a pass', () => {
    const m = extractionMetrics([field('retencionTotal', 164368)], [record({})], 0, 0);
    expect(m.fieldsCorrect).toBe(0);
    expect(m.accuracy).toBe(0);
  });

  it('counts a field routed to REVIEW as incorrect, not abstained', () => {
    // Otherwise a strategy scores 100% by routing everything uncertain to a human.
    const low = record({ retencionTotal: 164368 }, { confidence: REVIEW_THRESHOLD - 0.01 });
    const m = extractionMetrics([field('retencionTotal', 164368)], [low], 1, 0);
    expect(m.fieldsCorrect).toBe(0);
    expect(m.routedToReview).toBe(1);
  });

  it('compares EXACTLY — no numeric tolerance', () => {
    // The nota-de-crédito netting bug was an exact-value error; a tolerance would normalise it.
    const m = extractionMetrics([field('total', 1_750_685)], [record({ total: 1_750_684 })], 0, 0);
    expect(m.accuracy).toBe(0);
  });

  it('does not coerce null to 0, or 0 to null', () => {
    expect(extractionMetrics([field('t', null)], [record({ t: 0 })], 0, 0).accuracy).toBe(0);
    expect(extractionMetrics([field('t', 0)], [record({ t: null })], 0, 0).accuracy).toBe(0);
    expect(extractionMetrics([field('t', null)], [record({ t: null })], 0, 0).accuracy).toBe(1);
  });

  it('attributes accuracy per strategy, so a regression names its parser', () => {
    const m = extractionMetrics(
      [field('a', 1), field('b', 1)],
      [
        record({ a: 1 }, { strategy: 'bte-mensual@1' }),
        record({ b: 2 }, { strategy: 'bpst-mensual@1' }),
      ],
      0,
      0,
    );
    expect(m.byStrategy['bte-mensual@1']).toBe(1);
    expect(m.byStrategy['bpst-mensual@1']).toBe(0);
  });

  it('returns null accuracy when nothing was comparable — never a defaulted 1', () => {
    expect(extractionMetrics([], [], 0, 0).accuracy).toBeNull();
  });
});

describe('normativaMetrics', () => {
  const cite = (anchor: string, asOf = '2023-09-30'): ExpectedCitation => ({
    findingId: 'f1',
    anchor,
    asOf,
  });
  const res = (anchor: string, over: Partial<ResolvedAnchor> = {}): ResolvedAnchor => ({
    anchor,
    asOf: '2023-09-30',
    resolved: true,
    correctVersion: true,
    ...over,
  });

  it('counts an anchor as held only when it resolves for the engagement asOf date', () => {
    const m = normativaMetrics([cite('CT/1974#art-200')], [res('CT/1974#art-200')], 2);
    expect(m.heldAnchors).toBe(1);
    expect(m.coverage).toBe(0.5);
  });

  it('counts a WRONG-DATED resolution separately — it is worse than absence', () => {
    // Absence declines; a wrong date answers confidently with the wrong year's law.
    const m = normativaMetrics(
      [cite('DL-824/1974#art-31')],
      [res('DL-824/1974#art-31', { correctVersion: false })],
      1,
    );
    expect(m.heldAnchors).toBe(0);
    expect(m.misdatedCitations).toBe(1);
    expect(m.coverage).toBe(0);
  });

  it('uses the DECLARED corpus as the denominator, not what happens to be held', () => {
    const m = normativaMetrics([cite('a')], [res('a')], 10);
    expect(m.coverage).toBe(0.1);
  });

  it('is null when no corpus scope was declared', () => {
    expect(normativaMetrics([], [], 0).coverage).toBeNull();
  });

  it('does not double-count a repeated citation', () => {
    const m = normativaMetrics([cite('a'), cite('a')], [res('a')], 1);
    expect(m.heldAnchors).toBe(1);
  });
});

describe('findingMetrics', () => {
  const expected = (over: Partial<ExpectedFinding> = {}): ExpectedFinding => ({
    id: 'e1',
    ruleId: 'retencion-151',
    period: '202309',
    describes: 'retención declarada no coincide',
    confirmed: true,
    materiality: 100_000,
    ...over,
  });
  const produced = (over: Partial<ProducedFinding> = {}): ProducedFinding => ({
    id: 'p1',
    ruleId: 'retencion-151',
    period: '202309',
    describes: 'retención declarada no coincide',
    materiality: 100_000,
    citedAnchors: ['DL-824/1974#art-74'],
    ...over,
  });

  it('counts a matched confirmed finding as a true positive', () => {
    const m = findingMetrics([expected()], [produced()]);
    expect(m.truePositives).toBe(1);
    expect(m.falsePositives).toBe(0);
    expect(m.falseNegatives).toBe(0);
    expect(m.precision).toBe(1);
    expect(m.recall).toBe(1);
  });

  it('counts a confirmed finding NOT surfaced as a false negative', () => {
    const m = findingMetrics([expected()], []);
    expect(m.falseNegatives).toBe(1);
    expect(m.recall).toBe(0);
  });

  it('counts a surfaced-but-DISMISSED finding as a false positive', () => {
    // Dismissals are the precision denominator; a golden set of only confirmed findings
    // measures neither precision nor recall.
    const m = findingMetrics([expected({ confirmed: false })], [produced()]);
    expect(m.falsePositives).toBe(1);
    expect(m.truePositives).toBe(0);
    expect(m.precision).toBe(0);
  });

  it('treats an UNCITED finding as a false positive even if the issue was real', () => {
    // "An answer without provenance is a bug" — this is the metric-level teeth behind it.
    const m = findingMetrics([expected()], [produced({ citedAnchors: [] })]);
    expect(m.truePositives).toBe(0);
    expect(m.falsePositives).toBe(1);
    expect(m.falseNegatives).toBe(1);
  });

  it('counts a cited finding matching nothing in the golden set as a false positive', () => {
    const m = findingMetrics([expected()], [produced(), produced({ id: 'p2', period: '202401' })]);
    expect(m.truePositives).toBe(1);
    expect(m.falsePositives).toBe(1);
  });

  it('falls back to period+description when the golden set attributed no rule', () => {
    const m = findingMetrics(
      [expected({ ruleId: null, describes: 'Retención  Declarada No Coincide' })],
      [produced({ ruleId: null })],
    );
    expect(m.truePositives).toBe(1);
  });

  it('weights recall by materiality — a missed material issue costs more', () => {
    const m = findingMetrics(
      [
        expected({ id: 'big', period: '202301', materiality: 10_000_000 }),
        expected({ id: 'small', period: '202302', materiality: 1_000 }),
      ],
      [produced({ period: '202302' })],
    );
    expect(m.recall).toBe(0.5);
    // Unweighted recall says 50%; weighted says the miss was almost everything that mattered.
    expect(m.materialityWeightedRecall).toBeLessThan(0.01);
  });

  it('returns nulls rather than zeros when there is nothing to measure', () => {
    const m = findingMetrics([], []);
    expect(m.precision).toBeNull();
    expect(m.recall).toBeNull();
    expect(m.f1).toBeNull();
  });
});

describe('ratio / f1', () => {
  it('returns null on a zero denominator instead of NaN', () => {
    expect(ratio(0, 0)).toBeNull();
    expect(ratio(1, 4)).toBe(0.25);
  });

  it('propagates null through f1', () => {
    expect(f1(null, 1)).toBeNull();
    expect(f1(0, 0)).toBeNull();
    expect(f1(0.5, 0.5)).toBe(0.5);
  });
});
