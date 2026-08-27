// Stage 7 — GATE (ADR-043 §I4).
//
// Promote only what improves at least one target metric without regressing the others beyond
// tolerance. Rejected candidates are retained with the reason, so the same bad idea is not
// re-proposed nightly.
//
// THE DECISION LOGIC IS NOT HERE. It is `eval/gate.ts` — pure, total and testable without a store
// or a clock. This stage is the wiring: fetch the two eval results stage 6 produced, call
// `evaluateGate`, then apply the outcome. Keeping the judgement pure is deliberate; the one piece
// of this system that must never be subtly wrong should be the piece with no I/O in it.
//
// A NIGHT WITH NOTHING TO PROMOTE IS A HEALTHY NIGHT. With no candidate evaluation, this stage
// reports `ok` with `promoted: 0` — the system declined to change itself on no evidence, which is
// the designed behaviour and not a failure.
//
// DRY RUN decides everything and promotes nothing, so a human can read tonight's verdicts before
// letting the loop act on them.

import type { LoopContext, StageResult } from '../context.js';
import { approvalFor, evaluateGate } from '../../eval/gate.js';
import { baselineRunId, candidateRunId } from './evaluate.js';

export async function gateStage(ctx: LoopContext): Promise<StageResult> {
  const baseline = await ctx.evalResults.get(baselineRunId(ctx.runId));
  const candidate = await ctx.evalResults.get(candidateRunId(ctx.runId));

  if (baseline === null) {
    return {
      summary: 'no baseline evaluation this run — nothing can be promoted (the gate fails closed)',
      changed: { promoted: 0, rejected: 0 },
      idle: true,
    };
  }

  if (candidate === null) {
    return {
      summary: 'no candidate change-set was evaluated — nothing to promote',
      changed: { promoted: 0, rejected: 0 },
      idle: true,
    };
  }

  // The baseline for comparison is the PREVIOUS accepted result, not tonight's own baseline run:
  // tonight's baseline measures the same production code the candidate is being compared against,
  // so it is the correct reference for "did this change help".
  const decision = evaluateGate(candidate, baseline, ctx.config.tolerances);

  const subjects = ctx.strategies.candidates().map((s) => `${s.id}@${s.version}`);
  let promoted = 0;
  let rejected = 0;

  for (const subject of subjects) {
    const approval = approvalFor(decision, subject);

    if (approval.verdict === 'promote') {
      if (!ctx.config.dryRun) {
        const [id, version] = subject.split('@');
        if (id !== undefined && version !== undefined) ctx.strategies.activate(id, Number(version));
      }
      promoted += 1;
      continue;
    }

    rejected += 1;
    // Retained with the verbatim reason, keyed by the SUBJECT, so stage 5 does not re-propose it.
    ctx.rejections.record({
      fingerprint: subject,
      ruleId: subject,
      reason: decision.explanation,
      rejectedAt: ctx.clock.now().toISOString(),
      evalRunId: decision.evalRunId,
      timesProposed: 0,
    });
  }

  const verb = ctx.config.dryRun ? 'would promote' : 'promoted';
  return {
    summary:
      subjects.length === 0
        ? `gate ran (${decision.verdict}: ${decision.explanation}) with no subjects to act on`
        : `${verb} ${promoted}, rejected ${rejected} — ${decision.explanation}`,
    changed: { promoted, rejected },
  };
}
