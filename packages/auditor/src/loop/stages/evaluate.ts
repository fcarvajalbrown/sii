// Stage 6 — EVALUATE (ADR-043).
//
// Run the full regression suite: a BASELINE evaluation of production as it stands, and — when
// stage 5 proposed anything — a CANDIDATE evaluation of production plus the change-set.
//
// THE BASELINE RUNS EVERY NIGHT, even with nothing proposed. That is what makes trends queryable
// ("results persisted per run"), and it is how a metric drop caused by SII changing its payloads
// becomes visible on the night it happens rather than the next time someone proposes a change.
//
// TWO RUNS, NOT ONE REUSED. Comparing tonight's candidate against LAST night's stored result would
// be cheaper and wrong: the golden set may have grown in between, and a movement caused by the SET
// changing is not a movement caused by the CODE changing. Both results carry `goldenSetVersion`
// precisely so that confusion is impossible — and running both tonight keeps them comparable.
//
// AN EMPTY GOLDEN SET IS NOT AN ERROR HERE. It produces a result with zero engagements, and
// `gate.ts` rejects on `no_golden_set`. Failing at the gate rather than here keeps the reason
// visible in the manifest instead of surfacing as a stage crash.

import type { LoopContext, StageResult } from '../context.js';
import { outcomeOf } from '../context.js';

/** Deterministic eval-run ids, so stage 7 finds what stage 6 produced without extra plumbing. */
export const baselineRunId = (runId: string): string => `${runId}-baseline`;
export const candidateRunId = (runId: string): string => `${runId}-candidate`;

export async function evaluateStage(ctx: LoopContext): Promise<StageResult> {
  const manifest = ctx.manifest();
  const proposed = outcomeOf(manifest, 'propose');
  const proposals = proposed?.status === 'ok' ? (proposed.changed['proposals'] ?? 0) : 0;

  const baseline = await ctx.harness.run({ runId: baselineRunId(ctx.runId) });

  const changed: Record<string, number> = {
    engagements: baseline.engagements.length,
    fieldsCompared: baseline.extraction.fieldsCompared,
    extractionFailures: baseline.extraction.failures,
    evaluations: 1,
  };

  if (proposals === 0) {
    return {
      summary:
        baseline.engagements.length === 0
          ? 'baseline evaluated against an EMPTY golden set — the gate will reject on no_golden_set'
          : `baseline evaluated over ${baseline.engagements.length} engagement(s); no proposals to test`,
      changed,
    };
  }

  // Stage 5 registers its candidates inertly; they are named here, never activated.
  const candidates = ctx.strategies.candidates().map((s) => `${s.id}@${s.version}`);
  const candidate = await ctx.harness.run({
    runId: candidateRunId(ctx.runId),
    ...(candidates.length > 0 ? { candidateStrategies: candidates } : {}),
  });

  return {
    summary: `baseline + candidate evaluated over ${candidate.engagements.length} engagement(s)`,
    changed: { ...changed, evaluations: 2, candidatesTested: candidates.length },
  };
}
