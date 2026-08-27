// The default fetch plan is DATA (W5), so its shape is pinned like data: which steps exist, under
// which stable ids. Step ids land in per-step failure reporting and in a human's reading of the
// manifest, so a rename is a visible decision, not drift.

import { describe, expect, it } from 'vitest';
import { DEFAULT_FETCH_PLAN } from './plan.js';

describe('DEFAULT_FETCH_PLAN', () => {
  it('sweeps the surfaces the shipped consumers read — including the F29 propuesta', () => {
    // `f29-propuesta` earns its place differently from the rest: it is the ONE swept surface a
    // registered strategy can parse (f29-propuesta@2), so it is what turns a fetch+learn into the
    // store's first extracted entities. Removing it silently would regress the loop to fetching
    // only surfaces nothing parses.
    expect(DEFAULT_FETCH_PLAN.map((s) => s.id)).toEqual([
      'situacion',
      'rcv-resumen',
      'f29-overview',
      'f29-propuesta',
      'f22-status',
    ]);
  });

  it('never repeats a step id — per-step failure isolation keys on it', () => {
    const ids = DEFAULT_FETCH_PLAN.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
