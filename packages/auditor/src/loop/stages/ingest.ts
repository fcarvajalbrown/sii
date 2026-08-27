// Stage 1 — INGEST (ADR-043).
//
// Fetch new periods and documents; detect structural changes in the webapp and flag broken
// selectors.
//
// HOW IT REACHES SII, and why it is not a new crawler: it calls the SHIPPED `core` tasks
// (`rcvListAll`, `f22Status`, `f29Overview`, `djStatus`, `girosList`, …) through a runtime whose
// `PortalDriver` has been wrapped by `recordingDriver`. The facades behave exactly as they do for
// the CLI — same pacing, same audit receipts, same operate/session rules — while every raw
// response lands in the artifact store on the way past. Writing a parallel fetch path here would
// fork a year of SII knowledge and bypass the guardrails ADR-003 centralised.
//
// STRUCTURAL DRIFT DETECTION is the second half of the stage and the input to self-healing: each
// artifact is compared against the `BehaviorMap`'s recorded shape for that endpoint, and a
// difference becomes a `StructuralChange`. `breaksFacade: true` when a selector a live facade
// depends on is the thing that moved — that is the "broken selector" flag, and it is what stage 4
// clusters into a parser fix.
//
// ONE LIVE SESSION AT A TIME (ADR-005, untouched): taxpayers are swept SEQUENTIALLY, each with its
// own login. The store is multi-taxpayer; the ingest is not concurrent.

import { NotAuthenticatedError } from '@dostertags/sii-core';
import type { Runtime } from '@dostertags/sii-core';
import { createRecordingRuntime } from '../../ingest/runtime.js';
import type { LoopContext, StageResult } from '../context.js';

/** What one step is fetching for. `taxpayer` is the pseudonymous key, never a RUT. */
export interface FetchScope {
  readonly taxpayer: string;
  /** Months of history to refresh, from `LoopConfig`. */
  readonly meses: number;
  /** Años tributarios to refresh. */
  readonly anios: number;
}

/**
 * One unit of fetching — a thin call into a SHIPPED `core` task.
 *
 * A step must not contain fetch logic of its own. `packages/core`'s facades are the correct,
 * live-observed, cited parsers with a year of SII knowledge behind them; re-implementing any part
 * of that here would fork it. A step's whole job is to invoke one task with the right arguments and
 * let `recordingDriver` capture whatever it reads on the way past.
 */
export interface FetchStep {
  /** Stable, kebab-case: `rcv-resumen`, `f22-status`. Appears in the stage summary. */
  readonly id: string;
  readonly describes: string;
  run(runtime: Runtime, scope: FetchScope): Promise<void>;
}

export async function ingestStage(ctx: LoopContext): Promise<StageResult> {
  if (ctx.config.taxpayers.length === 0) {
    return { summary: 'no taxpayers configured — nothing to ingest', changed: {}, idle: true };
  }

  // Sorted, not configuration order: two identical runs must sweep in the same sequence or the
  // artifacts land in a different order and a run-to-run diff becomes noise (ADR-043 §I5).
  const taxpayers = [...ctx.config.taxpayers].sort();
  const pauseMs = 1000;

  // ── WHO IS ACTUALLY LOGGED IN ───────────────────────────────────────────────────────────────
  //
  // Session-keyed surfaces (F22, F29, situación) ALWAYS read the login principal (ADR-005), so
  // sweeping subject X while authenticated as Y files Y's real responses under X's key. That is
  // the "evidence attributed to the wrong subject" failure this file's header warns about, and it
  // is SILENT — every downstream figure would be attributed to someone who never had it. Found on
  // a live run 2026-08-10, which did exactly that before this check existed.
  //
  // Default ON. `requireSessionMatch: false` exists only so tests can exercise the multi-taxpayer
  // failure-isolation logic, which one real session can never reach; it is not a production path.
  const guarded = ctx.config.requireSessionMatch !== false;
  const sessionSubject = guarded ? await ctx.sessionSubject() : null;

  if (guarded && sessionSubject === null) {
    throw new Error(
      'cannot determine which taxpayer the live session belongs to, so nothing fetched could be ' +
        'attributed — run `sii auth login` and retry. Recording under a guessed subject would ' +
        'file one taxpayer’s data under another’s key, and nothing downstream would notice.',
    );
  }
  if (guarded && !taxpayers.includes(sessionSubject as string)) {
    throw new Error(
      `no configured subject matches the live session — ${String(taxpayers.length)} subject(s) ` +
        'are configured and the session belongs to none of them. Run `sii auth login` as one of ' +
        'them, or add it to `subjects.json`.',
    );
  }

  let artifacts = 0;
  let stepsFailed = 0;
  let taxpayersFailed = 0;
  let taxpayersSkipped = 0;
  const skipped: string[] = [];
  const problems: string[] = [];

  for (const taxpayer of taxpayers) {
    // A subject the live session does not belong to is SKIPPED, not fetched. It is not a failure —
    // the operator simply has to log in as that subject and run `fetch` again (ADR-006 keeps login
    // interactive, so N subjects is N logins).
    if (guarded && taxpayer !== sessionSubject) {
      taxpayersSkipped += 1;
      skipped.push(taxpayer);
      continue;
    }

    // ONE LIVE SESSION AT A TIME (ADR-005). Taxpayers are swept sequentially, never concurrently,
    // and each gets its OWN recording runtime so its artifacts are filed under its own key —
    // evidence attributed to the wrong subject is worse than evidence not captured.
    const { runtime } = createRecordingRuntime({
      taxpayer,
      runId: ctx.runId,
      base: ctx.runtime,
      artifacts: ctx.artifacts,
      onRecorded: () => {
        artifacts += 1;
      },
    });

    const scope: FetchScope = {
      taxpayer,
      meses: ctx.config.meses,
      anios: ctx.config.anios,
    };

    // A taxpayer has FAILED only when nothing at all succeeded for it. One step failing while the
    // others land is a partial read — real, useful, and not the same as a subject that could not
    // be reached; conflating them would abort a night that mostly worked.
    let stepsOk = 0;

    for (const step of ctx.fetchPlan) {
      try {
        await step.run(runtime, scope);
        stepsOk += 1;
      } catch (err) {
        stepsFailed += 1;
        // SII's own message passes through unchanged (ADR-004) — never translated or summarised.
        const message = err instanceof Error ? err.message : String(err);
        problems.push(`${taxpayer}/${step.id}: ${message}`);

        // A SESSION error is not a per-item error. Every subsequent call would fail identically,
        // so continuing would hammer SII for nothing and bury the real cause under N copies of it.
        // It stops THIS taxpayer only — each subject has its own session, so a dead one here says
        // nothing about the next (ADR-005).
        if (err instanceof NotAuthenticatedError) break;

        // Otherwise: stop the STEP, not the batch (CONVENTIONS). NEVER retried — a block is
        // server-side and timed, and retrying is the one thing that makes it worse (ADR-004).
        continue;
      } finally {
        // Paced through the `Clock` seam, so the fake resolves instantly and tests do not wait.
        await ctx.clock.sleep(pauseMs);
      }
    }

    if (stepsOk === 0) taxpayersFailed += 1;
  }

  // EVERY taxpayer failing is not a partial night, it is a failed one — the usual cause being that
  // nobody logged in. `ingest` is a fatal stage precisely so the run aborts here instead of letting
  // `evaluate` and `gate` reason about a store that gained nothing tonight. Reporting `ok` with
  // zero artifacts would read downstream as "there was nothing new", which is a different claim.
  const attempted = taxpayers.length - taxpayersSkipped;
  if (attempted > 0 && taxpayersFailed === attempted) {
    throw new Error(
      `ingest recorded nothing: all ${taxpayers.length} taxpayer(s) failed — ${problems.join(' | ')}`,
    );
  }

  const parts = [
    `${String(attempted)} taxpayer(s) swept`,
    `${String(artifacts)} artifact(s) recorded`,
  ];
  if (taxpayersSkipped > 0) {
    parts.push(
      `${String(taxpayersSkipped)} subject(s) skipped — the live session belongs to a different ` +
        'taxpayer; run `sii auth login` as each one and re-run fetch',
    );
  }
  if (stepsFailed > 0) parts.push(`${stepsFailed} step failure(s): ${problems.join(' | ')}`);

  return {
    summary: parts.join('; '),
    changed: {
      taxpayersSwept: attempted,
      taxpayersSkipped,
      taxpayersFailed,
      artifacts,
      stepsFailed,
    },
    // Not idle: the sweep ran. A night that fetched nothing NEW still looked, and saying otherwise
    // would let stage 2 read "nothing to extract" as "nothing happened".
    idle: false,
  };
}
