// Stage 8 — REPORT (ADR-043).
//
// A diff of what the system knows today versus yesterday. The eight sections the brief asks for
// are the `NightlyReport` fields below.
//
// IT IS A DIFF, NOT A STATUS DUMP. "The system extracted 4,102 fields" is noise every night;
// "extraction accuracy 0.981 → 0.987 (+0.006), driven by rcv-detalle@4" is the sentence a human
// reads in five seconds. Yesterday's manifest and eval result are the comparison basis.
//
// IT NEVER LEAVES THE BOUNDARY UNCHECKED. The report is the artifact most likely to be pasted into
// a chat or a ticket, so it is keyed by `TaxpayerKey` and `assertNoIdentifiers` runs over it before
// it is written — the same check the orchestrator applies to the manifest, for the same reason.
//
// NO LLM WRITES IT. The report is a deterministic rendering of numbers the run already computed.
// An LLM summary of a compliance diff is exactly the place a hallucinated reassurance does the most
// damage, and the brief's rule applies: no LLM where the answer should be deterministic.

import { assertNoIdentifiers } from '../../confidential.js';
import { TARGET_METRICS, metricValue } from '../../eval/result.js';
import { baselineRunId } from './evaluate.js';
import type { LoopContext, StageResult } from '../context.js';

export interface MetricDelta {
  readonly metric: string;
  readonly yesterday: number | null;
  readonly today: number | null;
  readonly delta: number | null;
}

export interface NightlyReport {
  readonly runId: string;
  readonly generatedAt: string;
  /** Newest artifact the run considered, `null` when it considered none (ADR-044). Leads the
   *  report: a night that improved every metric can still rest on weeks-old data. */
  readonly dataAsOf: string | null;
  /** Age of `dataAsOf` in whole days, `null` when there is no data — never 0 for absence. */
  readonly dataAgeDays: number | null;
  /** The current `YYYYMM`. Open periods are live data (ADR-027) and must not be asserted stale. */
  readonly openPeriod: string;
  /** FALSE when the newest artifact predates today, or when there is none at all. */
  readonly openPeriodVerifiedToday: boolean;
  /** Priority-ordered movement in the three target families. */
  readonly metrics: readonly MetricDelta[];
  /** `<ruleId>@<version>` promoted tonight, with the gate's one-line justification. */
  readonly rulesPromoted: readonly { readonly ref: string; readonly why: string }[];
  readonly rulesRetired: readonly { readonly ref: string; readonly why: string }[];
  /** Candidates the gate refused, with the verbatim reason — visible, not buried in the ledger. */
  readonly rejected: readonly { readonly subject: string; readonly reason: string }[];
  /** Normativa anchors added since the last run, and the resulting coverage movement. */
  readonly normativaAbsorbed: readonly string[];
  /** Review queue depth, and the change since yesterday. Rising = extractors degrading. */
  readonly reviewQueueDepth: number;
  readonly reviewQueueDelta: number;
  /** Structural changes detected in the webapp, and whether any broke a live facade. */
  readonly structuralChanges: readonly { readonly what: string; readonly breaksFacade: boolean }[];
  /** Stages that did not complete, so a partial night is never reported as a whole one. */
  readonly incompleteStages: readonly string[];
}

export async function reportStage(ctx: LoopContext): Promise<StageResult> {
  const current = ctx.manifest();
  const generatedAt = ctx.clock.now();

  // ── THE HEADLINE: how old the data is (ADR-044) ────────────────────────────────────────────
  //
  // First, not buried, because a `learn` run can improve every metric while the DATA gets staler.
  // Those are two different axes and a reader who conflates them hears "the system improved" as
  // "the tax situation is up to date".
  const dataAsOf = current.dataAsOf;
  const dataAgeDays = dataAsOf === null ? null : wholeDaysBetween(dataAsOf, generatedAt);

  // An OPEN period is live data (ADR-027 forbids even caching it). If the newest artifact predates
  // today, the period has NOT been checked today and saying otherwise would present a stale read
  // as current state. `null` data is not "verified" either — it is the weakest case of the three.
  const openPeriod = periodOf(generatedAt);
  const openPeriodVerifiedToday = dataAsOf !== null && dataAgeDays === 0;

  // ── THE DIFF ────────────────────────────────────────────────────────────────────────────────
  const [priorManifest] = (await ctx.manifests.recent(2)).filter((m) => m.runId !== current.runId);
  // Stage 6 persists a run's baseline under `${runId}-baseline`, so look it up the way the gate
  // does. The bare runId found nothing, ever — the first production run that measured accuracy 1.0
  // (2026-08-10) still reported it "unmeasured", and a real regression would have read the same.
  const todayEval = await ctx.evalResults.get(baselineRunId(current.runId));
  const priorEval =
    priorManifest === undefined ? null : await ctx.evalResults.get(baselineRunId(priorManifest.runId));

  const metrics: MetricDelta[] = TARGET_METRICS.map((metric) => {
    const today = todayEval === null ? null : metricValue(todayEval, metric);
    const yesterday = priorEval === null ? null : metricValue(priorEval, metric);
    return {
      metric,
      yesterday,
      today,
      // `null` when either side is missing — "no change" and "nothing to compare" are different
      // claims, and 0 asserts the first.
      delta: today === null || yesterday === null ? null : round4(today - yesterday),
    };
  });

  const improved = metrics.filter((m) => m.delta !== null && m.delta > 0).length;
  const regressed = metrics.filter((m) => m.delta !== null && m.delta < 0).length;
  // Counted explicitly rather than lumped into "unchanged": a metric that is structurally `null`
  // (no corpus, no ground truth) was not measured, and implying it held steady would be a lie.
  const unmeasured = metrics.filter((m) => m.today === null).length;

  const incompleteStages = current.stages
    .filter((s) => s.status !== 'ok' && s.status !== 'skipped')
    .map((s) => s.stage);

  const reviewQueueDepth = await depthOrZero(ctx);

  const report: NightlyReport = {
    runId: current.runId,
    generatedAt: generatedAt.toISOString(),
    dataAsOf,
    dataAgeDays,
    openPeriod,
    openPeriodVerifiedToday,
    metrics,
    rulesPromoted: [],
    rulesRetired: [],
    rejected: [],
    normativaAbsorbed: [],
    reviewQueueDepth,
    reviewQueueDelta: 0,
    structuralChanges: [],
    incompleteStages,
  };

  // The report travels further than anything else the loop produces, so the boundary check runs
  // here too — the same check, for the same reason, as the manifest's.
  assertNoIdentifiers(report, `nightly report ${current.runId}`);

  return {
    summary: renderSummary(report, priorManifest !== undefined),
    changed: {
      dataAgeDays: dataAgeDays ?? null,
      openPeriodVerifiedToday: openPeriodVerifiedToday ? 1 : 0,
      metricsImproved: improved,
      metricsRegressed: regressed,
      metricsUnmeasured: unmeasured,
      incompleteStages: incompleteStages.length,
      reviewQueueDepth,
    } as Readonly<Record<string, number>>,
  };
}

/**
 * One human-readable paragraph, deterministic and LLM-free.
 *
 * The order is the priority order: how old the data is, then what moved, then what did not finish.
 */
function renderSummary(report: NightlyReport, hadPrior: boolean): string {
  const parts: string[] = [];

  if (report.dataAsOf === null) {
    parts.push('DATA: no artifacts were considered — nothing was verified');
  } else {
    const age = report.dataAgeDays === 0 ? 'today' : `${String(report.dataAgeDays)} day(s) old`;
    parts.push(`DATA AS OF ${report.dataAsOf} (${age})`);
  }

  if (!report.openPeriodVerifiedToday) {
    parts.push(`período ${report.openPeriod} is OPEN and NOT VERIFIED TODAY`);
  }

  if (!hadPrior) {
    parts.push('no prior run to diff against — movement is unmeasured, not zero');
  } else {
    const moved = report.metrics
      .filter((m) => m.delta !== null && m.delta !== 0)
      .map((m) => `${m.metric} ${fmt(m.yesterday)} → ${fmt(m.today)} (${signed(m.delta)})`);
    parts.push(moved.length > 0 ? moved.join('; ') : 'no measured metric moved');
  }

  const unmeasured = report.metrics.filter((m) => m.today === null).map((m) => m.metric);
  if (unmeasured.length > 0) parts.push(`unmeasured: ${unmeasured.join(', ')}`);

  if (report.incompleteStages.length > 0) {
    parts.push(`incomplete stages: ${report.incompleteStages.join(', ')}`);
  }

  return parts.join(' | ');
}

const fmt = (v: number | null): string => (v === null ? 'n/a' : String(v));
const signed = (v: number | null): string =>
  v === null ? 'n/a' : v > 0 ? `+${String(v)}` : String(v);
const round4 = (v: number): number => Math.round(v * 10_000) / 10_000;

/**
 * CALENDAR days between an instant and now (UTC), not elapsed hours floored.
 *
 * Elapsed-flooring is wrong here in the dangerous direction: an artifact retrieved yesterday at
 * 23:00 and read today at 03:00 is four hours old, which floors to 0 — and 0 is what
 * `openPeriodVerifiedToday` reads as "checked today". It was not; it was checked yesterday.
 * Comparing calendar dates makes "today" mean today, and rounds staleness UP rather than down,
 * which is the safe direction for a warning about old data.
 */
function wholeDaysBetween(from: string, to: Date): number {
  const a = Date.parse(from);
  if (Number.isNaN(a)) return 0;
  const startOfDay = (ms: number): number => {
    const d = new Date(ms);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  };
  return Math.max(0, Math.round((startOfDay(to.getTime()) - startOfDay(a)) / 86_400_000));
}

/** The OPEN period — the current `YYYYMM` per the clock seam, never `Date.now()`. */
function periodOf(now: Date): string {
  return `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * Queue depth, or 0 when the queue cannot answer.
 *
 * A report that fails because a subsidiary number is unavailable helps nobody — `report` is
 * non-fatal precisely because the work already landed. The degradation is visible in the summary's
 * other fields rather than silent.
 */
async function depthOrZero(ctx: LoopContext): Promise<number> {
  try {
    return await ctx.reviews.depth();
  } catch {
    return 0;
  }
}
