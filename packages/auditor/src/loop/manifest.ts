// The run manifest (ADR-043) — the honest account of one night.
//
// Written INCREMENTALLY, after every stage, not at the end. That is what makes the loop resumable:
// a crash at stage 5 leaves a manifest saying stages 1–4 completed and with what, so a resume
// starts at 5 instead of re-fetching everything from SII (which ADR-004's pacing posture makes
// expensive and rude).
//
// It is also the artifact the confidentiality boundary applies to most sharply: a manifest is the
// thing most likely to be pasted into a chat, a ticket, or a report. Everything in it is keyed by
// `TaxpayerKey`, and `assertNoIdentifiers` runs over it before it is persisted.

export const STAGES = [
  'ingest',
  'extract',
  'absorb',
  'mine',
  'propose',
  'evaluate',
  'gate',
  'report',
] as const;

export type Stage = (typeof STAGES)[number];

export type StageStatus =
  /** Ran and did its work. */
  | 'ok'
  /**
   * Ran and had nothing to do, OR was not selected for this run mode (ADR-044). Distinct from `ok`
   * so an idle night is visible as idle. The two cases are told apart by `summary`/`detail`, which
   * are always explicit — a stage is NEVER silently absent from the manifest.
   */
  | 'skipped'
  /** Hit a `NotImplemented`. The loop continues; the manifest says exactly what is missing. */
  | 'not_implemented'
  /** Threw something else. Recorded verbatim; the loop decides whether to continue (see below). */
  | 'failed';

export interface StageOutcome {
  readonly stage: Stage;
  readonly status: StageStatus;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  /** One line for a human. */
  readonly summary: string;
  /**
   * What this stage CHANGED, as counters. Every stage logs its mutations here — required by the
   * brief ("each stage ... logs what it changed") and the basis of the day-over-day diff.
   */
  readonly changed: Readonly<Record<string, number>>;
  /** Verbatim message when `status` is `failed`/`not_implemented`. SII messages pass through
   *  unchanged (ADR-004) — never translated, never summarised. */
  readonly detail: string | null;
}

export type RunStatus = 'running' | 'completed' | 'aborted';

export interface RunManifest {
  readonly runId: string;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly status: RunStatus;
  /** Pseudonymous subjects swept, ascending. NEVER a RUT (`confidential.ts`). */
  readonly taxpayers: readonly string[];
  /**
   * The reproducibility triple. Same inputs + same three versions ⇒ identical output
   * (ADR-043 §I5). Anything else is a bug in this package, not in the data.
   */
  readonly ruleSetVersion: string;
  readonly strategyVersions: readonly string[];
  readonly goldenSetVersion: string | null;
  /** Seed for every stochastic component. Recorded so a run can be replayed exactly. */
  readonly seed: number;
  /** True when nothing was persisted or promoted — the safe way to inspect the loop. */
  readonly dryRun: boolean;
  readonly stages: readonly StageOutcome[];
  /** Set when resuming: the run this one continues. */
  readonly resumedFrom: string | null;
  /**
   * The NEWEST `retrievedAt` among the artifacts this run considered — `null` when it considered
   * none (ADR-044). Never coerced to a date, never to 0.
   *
   * WHY IT IS MANDATORY. A `learn` run never touches SII, so it works on artifacts that may be
   * weeks old. A nightly report that LOOKS current while resting on stale data is exactly the
   * "confidently wrong" failure this package exists to prevent, so the age of the data is a
   * first-class field of the night's record rather than something a reader must infer.
   *
   * It dates the DATA, not the run. `startedAt` says when the loop ran; this says how old what it
   * reasoned about is. Confusing the two would read "the system improved" as "the tax situation is
   * up to date" — two different axes (ADR-044 Consequences).
   */
  readonly dataAsOf: string | null;
}

export interface RunManifestStore {
  /** Persist the manifest as it stands. Called after EVERY stage — this is the resume point. */
  save(manifest: RunManifest): Promise<void>;
  load(runId: string): Promise<RunManifest | null>;
  /** Newest first. `report` diffs against `recent(2)[1]` to say what changed since yesterday. */
  recent(limit: number): Promise<readonly RunManifest[]>;
  /** The most recent manifest that did NOT complete — the resume candidate. */
  lastIncomplete(): Promise<RunManifest | null>;
}

/** Stages already finished in a prior attempt, so a resume can skip them. */
export function completedStages(manifest: RunManifest): ReadonlySet<Stage> {
  return new Set(
    manifest.stages.filter((s) => s.status === 'ok' || s.status === 'skipped').map((s) => s.stage),
  );
}

/** The next stage to run, or `null` when the run is finished. */
export function nextStage(manifest: RunManifest): Stage | null {
  const done = completedStages(manifest);
  return STAGES.find((s) => !done.has(s)) ?? null;
}
