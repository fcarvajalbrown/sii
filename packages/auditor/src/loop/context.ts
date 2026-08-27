// The loop's shared context — every dependency a stage may touch, injected (ADR-003's posture
// applied to this package). A stage receives this and nothing else: no module-level singletons, no
// ambient clock, no direct `process.env` reads. That is what lets the orchestrator be tested
// end-to-end with fakes, exactly as `packages/core` is.

import type { AuditSink, Clock, Runtime } from '@dostertags/sii-core';
import type { ArtifactStore } from '../store/artifacts.js';
import type { NormalizedStore } from '../store/normalized.js';
import type { ReviewQueue } from '../extract/review-queue.js';
import type { ExtractionStore } from '../extract/store.js';
import type { FetchStep } from './stages/ingest.js';
import type { StrategyRegistry } from '../extract/strategy.js';
import type { BehaviorMap } from '../kb/behavior-map.js';
import type { NormativaStore } from '../kb/normativa.js';
import type { RuleStore } from '../rules/record.js';
import type { RejectionLedger } from '../rules/promotion.js';
import type { EvalHarness } from '../eval/harness.js';
import type { EvalResultStore } from '../eval/result.js';
import type { GoldenSet } from '../eval/golden.js';
import type { Tolerances } from '../eval/gate.js';
import type { RunManifest, RunManifestStore, Stage, StageOutcome } from './manifest.js';

export interface LoopConfig {
  /** Pseudonymous subjects to sweep, in order. Ingest is one live session at a time (ADR-005). */
  readonly taxpayers: readonly string[];
  /** Months of history to refresh per run. Closed periods are cheap thanks to ADR-027's cache. */
  readonly meses: number;
  /** Años tributarios to refresh per run. */
  readonly anios: number;
  /** Seed for every stochastic component. Recorded in the manifest for exact replay. */
  readonly seed: number;
  /** Nothing is persisted or promoted. The safe way to inspect a night's proposals. */
  readonly dryRun: boolean;
  readonly tolerances: Tolerances;
  /**
   * Stages that may fail without aborting the run. `ingest` failing is fatal (there is nothing to
   * work on); `report` failing is not (the work already landed). Default in `orchestrator.ts`.
   */
  readonly nonFatalStages: readonly string[];
  /**
   * WHICH stages to run (ADR-044). Omitted ⇒ all eight, the current `run` behaviour.
   *
   * `FETCH_STAGES` (`ingest` alone) is the only mode that needs a live SII session; `LEARN_STAGES`
   * (2–8) never touches SII and is the scheduler's target. Note this SELECTS stages, whereas
   * `OrchestratorDeps.stages` SUBSTITUTES their implementations — different objects, different jobs.
   *
   * `DEFAULT_NON_FATAL` deliberately does not change with the mode: in `learn`, `extract` stays
   * fatal because everything after it derives from what it produced; `ingest` simply does not run.
   */
  readonly stages?: readonly Stage[];
  /**
   * Verify the live session belongs to each swept subject. DEFAULT TRUE, and production never sets
   * it false — it exists so tests can exercise the multi-taxpayer failure-isolation logic, which a
   * single real session can never reach (ADR-006 keeps login interactive, so N subjects is N
   * logins).
   */
  readonly requireSessionMatch?: boolean;
}

export interface LoopContext {
  readonly runId: string;
  readonly config: LoopConfig;

  /**
   * The UNDECORATED `core` runtime.
   *
   * Stage 1 wraps it per taxpayer with `recordingDriver`, because artifacts must be filed under the
   * subject they belong to and the composition root does not know which one is being swept. Wrapping
   * once up front would file everything under a single key — and wrapping again in the stage would
   * record every response twice.
   */
  readonly runtime: Runtime;
  /**
   * What stage 1 fetches, as data. Each step is a thin call into a SHIPPED `core` task, never new
   * fetch code — the facades already hold the SII knowledge and re-implementing it would fork them.
   */
  readonly fetchPlan: readonly FetchStep[];
  /**
   * The pseudonymous key of the taxpayer the LIVE SESSION belongs to, or `null` when it cannot be
   * determined. Stage 1 refuses to record anything it cannot attribute: session-keyed surfaces
   * always read the login principal (ADR-005), so sweeping a subject the session is not for files
   * one taxpayer’s data under another’s key, silently.
   */
  readonly sessionSubject: () => Promise<string | null>;
  readonly clock: Clock;
  /** Reuses `core`'s audit sink rather than adding a second receipt (ADR-043: no redundancy). */
  readonly audit: AuditSink;

  readonly artifacts: ArtifactStore;
  readonly entities: NormalizedStore;
  /** Stage 2's own output log. `ArtifactStore.prune` reads it to know what is still cited. */
  readonly extractions: ExtractionStore;
  readonly reviews: ReviewQueue;
  readonly strategies: StrategyRegistry;

  readonly normativa: NormativaStore;
  readonly behavior: BehaviorMap;

  readonly rules: RuleStore;
  readonly rejections: RejectionLedger;

  readonly golden: GoldenSet;
  readonly harness: EvalHarness;
  readonly evalResults: EvalResultStore;

  readonly manifests: RunManifestStore;

  /** The manifest as it stands. Stages read it to see what earlier stages produced. */
  readonly manifest: () => RunManifest;
}

/** What a stage returns. The orchestrator stamps timing and status onto it. */
export interface StageResult {
  readonly summary: string;
  readonly changed: Readonly<Record<string, number>>;
  /** `true` when the stage legitimately had nothing to do (→ `skipped`, not `ok`). */
  readonly idle?: boolean;
}

export type StageFn = (ctx: LoopContext) => Promise<StageResult>;

/** Read an earlier stage's recorded outcome — how `gate` finds what `evaluate` produced. */
export function outcomeOf(manifest: RunManifest, stage: string): StageOutcome | undefined {
  return manifest.stages.find((s) => s.stage === stage);
}
