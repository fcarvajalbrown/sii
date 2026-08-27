// Golden-set independence (W8, ADR-043 §I5).
//
// THE PROBLEM THIS EXISTS FOR. A ground-truth value that was only READ OFF THE ARTIFACT is not
// independent evidence: the golden set and the parser can be wrong in exactly the same way, and
// then accuracy 1.0 measures agreement between two copies of one mistake. `bte-resumen` reading
// honorarios as retención is precisely that shape of bug — the gate catches it today only because
// the RECONCILED fields are arithmetic-confirmed. The read-only fields would not have caught it.
//
// A field corroborated by an ARITHMETIC IDENTITY over other golden fields is different in kind: to
// fool it, a parser would have to be wrong about several fields in a mutually consistent way.

import { describe, expect, it } from 'vitest';
import { IntegrityError } from '../errors.js';
import { checkCorroboration } from './corroboration.js';
import type { ExpectedField } from './golden.js';
import type { Expression } from '../rules/expression.js';

const ART = 'a'.repeat(64);

const field = (
  path: string,
  expected: number,
  over: Partial<ExpectedField> = {},
): ExpectedField => ({
  artifact: ART,
  path,
  expected,
  verified: true,
  ...over,
});

/** `liquido === brutos - retenido` — the identity a BHE row must satisfy. */
const liquidoIdentity: Expression = {
  op: 'eq',
  args: [
    { op: 'field', path: 'liquido' },
    {
      op: 'sub',
      args: [
        { op: 'field', path: 'brutos' },
        { op: 'field', path: 'retenido' },
      ],
    },
  ],
};

describe('arithmetic corroboration', () => {
  it('marks a field corroborated when its identity holds', () => {
    const report = checkCorroboration([
      field('brutos', 1_000_000),
      field('retenido', 145_000),
      field('liquido', 855_000, {
        corroboration: { kind: 'arithmetic', identity: liquidoIdentity },
      }),
    ]);

    expect(report.corroborated).toEqual(['liquido']);
    expect(report.contradicted).toEqual([]);
  });

  it('REFUSES a golden set whose own identity does not hold', () => {
    // Ground truth that contradicts itself is worse than no ground truth: every metric computed
    // against it is measured against a value the set itself says is wrong.
    expect(() =>
      checkCorroboration([
        field('brutos', 1_000_000),
        field('retenido', 145_000),
        // 855.000 is the right answer; 900.000 is not.
        field('liquido', 900_000, {
          corroboration: { kind: 'arithmetic', identity: liquidoIdentity },
        }),
      ]),
    ).toThrow(IntegrityError);
  });

  it('names the field and the identity when it refuses', () => {
    expect(() =>
      checkCorroboration([
        field('brutos', 1_000_000),
        field('retenido', 145_000),
        field('liquido', 900_000, {
          corroboration: { kind: 'arithmetic', identity: liquidoIdentity },
        }),
      ]),
    ).toThrow(/liquido/);
  });

  it('RAISES when the identity references a field the set does not hold', () => {
    // W2's rule, applied here: a path the bag does not declare is a broken identity, not an
    // uncorroborated field. Treating it as "could not corroborate" would quietly downgrade a typo.
    expect(() =>
      checkCorroboration([
        field('brutos', 1_000_000),
        field('liquido', 855_000, {
          corroboration: { kind: 'arithmetic', identity: liquidoIdentity },
        }),
      ]),
    ).toThrow(/retenido/);
  });
});

describe('cross-source corroboration', () => {
  it('counts a field confirmed by a second surface', () => {
    const report = checkCorroboration([
      field('f29.codigo.151', 145_000, {
        corroboration: {
          kind: 'cross-source',
          agreesWith: { artifact: 'b'.repeat(64), path: 'bhe.retencionReceptor' },
        },
      }),
    ]);
    expect(report.corroborated).toEqual(['f29.codigo.151']);
  });
});

describe('the honest count', () => {
  it('lists verified fields that are READ-ONLY as uncorroborated', () => {
    // These are the ones the roadmap called "effectively decorative": verified by a human reading
    // the same bytes the parser read.
    const report = checkCorroboration([
      field('honorarios', 500_000),
      field('pagado', 400_000),
      field('brutos', 1_000_000),
      field('retenido', 145_000),
      field('liquido', 855_000, {
        corroboration: { kind: 'arithmetic', identity: liquidoIdentity },
      }),
    ]);

    expect(report.uncorroborated.sort()).toEqual(['brutos', 'honorarios', 'pagado', 'retenido']);
    expect(report.independenceRatio).toBeCloseTo(0.2, 5);
  });

  it('reports independence as null, not 0, when there are no verified fields to judge', () => {
    // No verified ground truth is "nothing to measure", not "0% independent".
    const report = checkCorroboration([field('x', 1, { verified: false })]);
    expect(report.independenceRatio).toBeNull();
  });

  it('ignores UNVERIFIED fields entirely — they are already out of the denominator', () => {
    const report = checkCorroboration([
      field('verified-one', 1),
      field('unverified-one', 2, { verified: false }),
    ]);
    expect(report.uncorroborated).toEqual(['verified-one']);
    expect(report.independenceRatio).toBe(0);
  });

  it('treats an explicit `none` exactly like an absent corroboration', () => {
    // Declaring "this was only read" must not look better than saying nothing.
    const report = checkCorroboration([field('x', 1, { corroboration: { kind: 'none' } })]);
    expect(report.uncorroborated).toEqual(['x']);
  });
});

describe('determinism', () => {
  it('sorts every list, so two runs produce identical reports', () => {
    const report = checkCorroboration([field('z', 1), field('a', 2), field('m', 3)]);
    expect(report.uncorroborated).toEqual(['a', 'm', 'z']);
  });
});
