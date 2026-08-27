// The nightly orchestrator (ADR-043) — IMPLEMENTED. An explicit, resumable state machine.
//
// It runs end-to-end TODAY, with stages whose bodies are deferred. That is the point: the manifest
// it produces is an honest account of what the night actually did, including a stage-by-stage
// record of what is not built yet. A loop that cannot run until every stage is finished is a loop
// nobody can test.
//
// FOUR PROPERTIES, each required by the brief:
//
//  1. RESUMABLE. The manifest is saved after EVERY stage. `resume(runId)` reloads it and continues
//     from `nextStage`, so a crash at stage 5 does not re-fetch from SII — which matters because
//     ADR-004 forbids hammering SII and every ingest is paced at 1 req/s.
//  2. INDEPENDENTLY RETRYABLE. Each stage is a pure `(ctx) => StageResult` with no hidden ordering
//     beyond what it reads from the manifest. `runStage` executes exactly one.
//  3. LOGS WHAT IT CHANGED. Every stage returns a `changed` counter map, recorded in the manifest.
//     That map is the substrate of stage 8's day-over-day diff.
//  4. FAILS HONESTLY. `NotImplemented` becomes `not_implemented`, never `ok`. A stage cannot report
//     success for work it did not do.

import { NotImplemented } from '../errors.js';
import { assertNoIdentifiers } from '../confidential.js';
import type { FetchManifest } from '../ingest/manifest.js';
import type { LoopConfig, LoopContext, StageFn, StageResult } from './context.js';
import type { RunManifest, Stage, StageOutcome, StageStatus } from './manifest.js';
import { STAGES, completedStages } from './manifest.js';
import { ingestStage } from './stages/ingest.js';
import { extractStage } from './stages/extract.js';
import { absorbStage } from './stages/absorb.js';
import { mineStage } from './stages/mine.js';
import { proposeStage } from './stages/propose.js';
import { evaluateStage } from './stages/evaluate.js';
import { gateStage } from './stages/gate.js';
import { reportStage } from './stages/report.js';

/** Stage implementations, keyed by name. The orchestrator knows the ORDER, not the work. */
export const STAGE_IMPLEMENTATIONS: Readonly<Record<Stage, StageFn>> = {
  ingest: ingestStage,
  extract: extractStage,
  absorb: absorbStage,
  mine: mineStage,
  propose: proposeStage,
  evaluate: evaluateStage,
  gate: gateStage,
  report: reportStage,
};

/**
 * Stages whose failure does NOT abort the run.
 *
 * `ingest` and `extract` are fatal: everything after them operates on what they produced, so
 * continuing past a failure would evaluate and possibly PROMOTE against a partial night's data —
 * the gate would be comparing metrics computed from an incomplete store. Everything from `absorb`
 * onward is additive, so a failure there costs a night of learning, not correctness.
 */
export const DEFAULT_NON_FATAL: readonly Stage[] = [
  'absorb',
  'mine',
  'propose',
  'evaluate',
  'gate',
  'report',
];

/**
 * The two run modes of ADR-044.
 *
 * ONLY `ingest` needs a live SII session. An earlier reading assumed the cut was 1–2 / 3–8; on
 * inspection `extract` parses artifacts ALREADY in the store, so it belongs on the unattended side.
 * That matters more than it looks: it decouples the cadence of LEARNING from access to SII —
 * learning needs new strategies, new rules and auditor corrections, none of which live at SII.
 */
export const FETCH_STAGES: readonly Stage[] = ['ingest'];

export const LEARN_STAGES: readonly Stage[] = [
  'extract',
  'absorb',
  'mine',
  'propose',
  'evaluate',
  'gate',
  'report',
];

export const DEFAULT_CONFIG: Omit<LoopConfig, 'taxpayers' | 'tolerances'> = {
  meses: 12,
  anios: 3,
  seed: 1,
  dryRun: false,
  nonFatalStages: DEFAULT_NON_FATAL,
};

export interface OrchestratorDeps {
  /** Everything except `runId`, `config` and `manifest` — the orchestrator supplies those. */
  readonly services: Omit<LoopContext, 'runId' | 'config' | 'manifest'>;
  readonly config: LoopConfig;
  /**
   * Substitute stage implementations. Injectable for the same reason `core`'s external
   * dependencies are (ADR-003): the failure paths — a fatal stage aborting the run, a non-fatal one
   * being tolerated — are otherwise unreachable in a test without a live SII.
   */
  readonly stages?: Partial<Record<Stage, StageFn>>;
}

const implementationFor = (deps: OrchestratorDeps, stage: Stage): StageFn =>
  deps.stages?.[stage] ?? STAGE_IMPLEMENTATIONS[stage];

/** Start a fresh nightly run and drive it to completion. */
export async function runNightly(
  deps: OrchestratorDeps,
  runId: string,
  seedManifest?: Partial<RunManifest>,
): Promise<RunManifest> {
  const startedAt = deps.services.clock.now().toISOString();
  // The reproducibility triple, captured at the START so it describes the code that ran tonight —
  // not what the gate may have promoted by the end (ADR-043 §I5).
  const versions = await captureVersions(deps);
  const initial: RunManifest = {
    runId,
    startedAt,
    finishedAt: null,
    status: 'running',
    taxpayers: [...deps.config.taxpayers].sort(),
    ruleSetVersion: seedManifest?.ruleSetVersion ?? versions.ruleSetVersion,
    strategyVersions: seedManifest?.strategyVersions ?? versions.strategyVersions,
    goldenSetVersion: seedManifest?.goldenSetVersion ?? versions.goldenSetVersion,
    seed: deps.config.seed,
    dryRun: deps.config.dryRun,
    stages: [],
    resumedFrom: seedManifest?.resumedFrom ?? null,
    dataAsOf: null,
  };
  return drive(deps, initial);
}

/**
 * Resume an interrupted run. Completed stages are not re-run — the whole reason the manifest is
 * saved after each one.
 */
export async function resumeNightly(deps: OrchestratorDeps, runId: string): Promise<RunManifest> {
  const prior = await deps.services.manifests.load(runId);
  if (prior === null) throw new Error(`no manifest for run ${runId} — nothing to resume`);
  if (prior.status === 'completed') return prior;
  return drive(deps, { ...prior, status: 'running' });
}

/**
 * Execute one stage against an existing manifest. The unit of independent retry.
 *
 * This runs the stage UNCONDITIONALLY — `config.stages` selects what a *run* drives, but an
 * operator naming a stage explicitly (`sii-auditor stage <runId> ingest`) has already made that
 * choice, and silently refusing would be the kind of quiet no-op this package forbids.
 */
export async function runStage(
  deps: OrchestratorDeps,
  manifest: RunManifest,
  stage: Stage,
): Promise<RunManifest> {
  const ctx = contextFor(deps, manifest);
  const outcome = await execute(
    implementationFor(deps, stage),
    stage,
    ctx,
    deps.services.clock.now(),
  );
  return recordOutcome(deps, manifest, outcome);
}

/** Merge one stage outcome into the manifest and persist. The resume point. */
async function recordOutcome(
  deps: OrchestratorDeps,
  manifest: RunManifest,
  outcome: StageOutcome,
): Promise<RunManifest> {
  // Re-running a stage REPLACES its prior outcome rather than appending a second one, so the
  // manifest always states the current truth about each stage exactly once.
  const stages = [...manifest.stages.filter((s) => s.stage !== outcome.stage), outcome].sort(
    (a, b) => STAGES.indexOf(a.stage) - STAGES.indexOf(b.stage),
  );
  const updated: RunManifest = { ...manifest, stages };
  await persist(deps, updated);
  return updated;
}

/** True when this run mode drives `stage`. No selection ⇒ all eight. */
function selected(config: LoopConfig, stage: Stage): boolean {
  return config.stages === undefined || config.stages.includes(stage);
}

/**
 * The outcome recorded for a stage this run mode did not select.
 *
 * It is `skipped` and it is PRESENT. ADR-043 makes the manifest the honest account of the night, so
 * a stage that did not run says so, with a reason — omitting it would leave a reader unable to tell
 * "not selected" from "forgotten", which is precisely the ambiguity the manifest exists to remove.
 */
function unselectedOutcome(deps: OrchestratorDeps, stage: Stage): StageOutcome {
  const at = deps.services.clock.now().toISOString();
  const mode =
    deps.config.stages === FETCH_STAGES
      ? 'fetch'
      : deps.config.stages === LEARN_STAGES
        ? 'learn'
        : 'this run';
  return {
    stage,
    status: 'skipped',
    startedAt: at,
    finishedAt: at,
    durationMs: 0,
    summary: `${stage} was not selected in ${mode} mode`,
    changed: {},
    detail:
      stage === 'ingest'
        ? 'ingest is the only stage that needs a live SII session (ADR-044); a learn run never reaches SII'
        : `not selected for this run mode (ADR-044); selected: ${(deps.config.stages ?? []).join(', ')}`,
  };
}

async function drive(deps: OrchestratorDeps, start: RunManifest): Promise<RunManifest> {
  // `dataAsOf` is computed UP FRONT, not only at finalization: stage 8 reads it from the in-flight
  // manifest to LEAD the report with it (ADR-044), and a value that exists only after the stages
  // have run left the production report claiming "no artifacts were considered" on every run.
  // Refreshed after ingest — the one stage that adds artifacts — so the report and the final
  // manifest agree; the finalization compute stays, covering the abort path with the same rule.
  let manifest = { ...start, dataAsOf: await computeDataAsOf(deps) };
  await persist(deps, manifest);

  // Iterate the fixed stage ORDER, attempting each remaining stage EXACTLY ONCE per pass. Driving
  // off `nextStage` instead would spin forever on a `not_implemented` stage, because that status
  // is deliberately not "completed" — a resume must retry it, but this pass must not.
  const alreadyDone = completedStages(manifest);

  for (const stage of STAGES) {
    if (alreadyDone.has(stage)) continue;

    // A stage this mode did not select is RECORDED, never executed — the implementation is not even
    // looked up, which is what keeps a `learn` run from constructing a `PortalDriver`.
    if (!selected(deps.config, stage)) {
      manifest = await recordOutcome(deps, manifest, unselectedOutcome(deps, stage));
      continue;
    }

    manifest = await runStage(deps, manifest, stage);
    if (stage === 'ingest') {
      manifest = { ...manifest, dataAsOf: await computeDataAsOf(deps) };
      await persist(deps, manifest);
    }

    const outcome = manifest.stages.find((s) => s.stage === stage);
    const fatal = outcome?.status === 'failed' && !deps.config.nonFatalStages.includes(stage);
    if (fatal) {
      manifest = {
        ...manifest,
        status: 'aborted',
        finishedAt: deps.services.clock.now().toISOString(),
        dataAsOf: await computeDataAsOf(deps),
      };
      await persist(deps, manifest);
      return manifest;
    }
    // A `not_implemented` stage does NOT abort — the run continues and the manifest records the
    // gap. That is what makes the loop executable while it is still being built.
  }

  manifest = {
    ...manifest,
    status: 'completed',
    finishedAt: deps.services.clock.now().toISOString(),
    dataAsOf: await computeDataAsOf(deps),
  };
  await persist(deps, manifest);
  return manifest;
}

/**
 * How old the data this run reasoned about actually is (ADR-044).
 *
 * Computed at the END so it covers both modes with one rule: a `fetch` run has just added tonight's
 * artifacts, a `learn` run considers whatever was already in the store. Either way this is the
 * newest `retrievedAt` the run could have seen.
 *
 * SCOPED TO THE SWEPT SUBJECTS. Reporting another taxpayer's newer artifact would date this run's
 * data to someone else's — an overclaim of freshness, the one direction that is dangerous. For the
 * same reason a run with NO configured subjects reports `null`: it swept nobody, so it considered
 * nothing, and the store's unrelated contents must not stand in for that.
 */
async function computeDataAsOf(deps: OrchestratorDeps): Promise<string | null> {
  let newest: string | null = null;

  for (const taxpayer of deps.config.taxpayers) {
    let manifests: readonly FetchManifest[];
    try {
      manifests = await deps.services.artifacts.findManifests({ taxpayer });
    } catch {
      // A store that cannot answer must not abort a run that has already done its work. `null`
      // stays `null` — the honest "not determined", never a fabricated date.
      continue;
    }
    for (const m of manifests) {
      if (newest === null || Date.parse(m.retrievedAt) > Date.parse(newest)) newest = m.retrievedAt;
    }
  }

  return newest;
}

async function execute(
  fn: StageFn,
  stage: Stage,
  ctx: LoopContext,
  started: Date,
): Promise<StageOutcome> {
  const startedAt = started.toISOString();
  let status: StageStatus;
  let summary: string;
  let changed: Readonly<Record<string, number>> = {};
  let detail: string | null = null;

  try {
    const result: StageResult = await fn(ctx);
    status = result.idle === true ? 'skipped' : 'ok';
    summary = result.summary;
    changed = result.changed;
  } catch (err) {
    if (err instanceof NotImplemented) {
      status = 'not_implemented';
      summary = `${stage} is not implemented yet`;
      detail = err.message;
    } else {
      status = 'failed';
      summary = `${stage} failed`;
      // SII's own message passes through unchanged (ADR-004) — never translated or summarised.
      detail = err instanceof Error ? err.message : String(err);
    }
  }

  const finished = ctx.clock.now();
  return {
    stage,
    status,
    startedAt,
    finishedAt: finished.toISOString(),
    durationMs: finished.getTime() - started.getTime(),
    summary,
    changed,
    detail,
  };
}

/**
 * Read the three versions that make a run replayable.
 *
 * Each is captured defensively: a store that is still a deferred stub must not stop the run from
 * starting. `'unavailable'` is recorded rather than a plausible-looking default, so a manifest
 * never claims a version it did not actually read.
 */
async function captureVersions(deps: OrchestratorDeps): Promise<{
  ruleSetVersion: string;
  strategyVersions: readonly string[];
  goldenSetVersion: string | null;
}> {
  let ruleSetVersion = 'unavailable';
  try {
    ruleSetVersion = await deps.services.rules.ruleSetVersion();
  } catch {
    // The rule store is still a stub; recorded honestly as unavailable.
  }

  let goldenSetVersion: string | null = null;
  try {
    goldenSetVersion = await deps.services.golden.version();
  } catch {
    // A missing or unreadable golden directory — the gate will reject on `no_golden_set` anyway.
  }

  return {
    ruleSetVersion,
    strategyVersions: deps.services.strategies.all().map((s) => `${s.id}@${s.version}`),
    goldenSetVersion,
  };
}

function contextFor(deps: OrchestratorDeps, manifest: RunManifest): LoopContext {
  return {
    ...deps.services,
    runId: manifest.runId,
    config: deps.config,
    manifest: () => manifest,
  };
}

/**
 * Save the manifest, refusing to write one that carries a client identifier.
 *
 * The manifest is the artifact most likely to be pasted into a ticket or a chat, so the boundary
 * check runs HERE rather than trusting every stage to have kept its summary clean. A stage that
 * interpolates an SII glosa into its summary is caught before the file is written.
 */
async function persist(deps: OrchestratorDeps, manifest: RunManifest): Promise<void> {
  assertNoIdentifiers(manifest, `run manifest ${manifest.runId}`);
  if (deps.config.dryRun) return;
  await deps.services.manifests.save(manifest);
}
