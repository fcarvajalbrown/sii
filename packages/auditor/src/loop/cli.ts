#!/usr/bin/env node
// `sii-auditor` — the loop's entry point (ADR-043).
//
// Deliberately dependency-free argument parsing. `packages/cli` uses commander (ADR-008) because it
// has a real subcommand tree with dozens of verbs; this binary has four, and adding a dependency to
// a package that is never published would be ceremony. If it grows a fifth level, adopt commander
// and match the existing surface.
//
// OUTPUT FOLLOWS THE PROJECT CONTRACT (ADR-012): the run manifest goes to STDOUT as JSON, so it
// pipes to `jq`; diagnostics go to STDERR.
//
// EXIT CODES (a scheduler reads these — see the README's scheduling section):
//   0  the run completed. Stages may be `not_implemented`; that is reported, not failed.
//   1  a fatal stage failed and the run aborted, or the context could not be built.
//   2  bad invocation.

import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createNodeRuntime } from '@dostertags/sii-core/node';
import { Rut, authStatus } from '@dostertags/sii-core';
import type { Runtime } from '@dostertags/sii-core';
import { AuditorError, NotImplemented } from '../errors.js';
import { GOLDEN_DIR_ENV, createFileGoldenSet } from '../eval/golden.js';
import {
  STORE_ROOT_ENV,
  createFileArtifactStore,
  createFileNormalizedStore,
  resolveStoreRoot,
} from '../store/file-backed.js';
import { createFileReviewQueue } from '../extract/review-queue.js';
import { createFileExtractionStore } from '../extract/store.js';
import { StrategyRegistry, registerCoreStrategies } from '../extract/strategy.js';
import { createFileNormativaStore, loadChunks } from '../kb/normativa.js';
import { loadSalt, loadSubjects } from '../subjects.js';
import { taxpayerKey } from '../confidential.js';
import type { NormativaCandidate } from '../kb/normativa.js';
import { createFileBehaviorMap } from '../kb/behavior-map.js';
import { createRejectionLedger } from '../rules/promotion.js';
import { createEvalHarness } from '../eval/harness.js';
import { createFileEvalResultStore } from '../eval/file-results.js';
import { deriveRunId } from '../ingest/runtime.js';
import { DEFAULT_FETCH_PLAN } from '../ingest/plan.js';
import { DEFAULT_TOLERANCES } from '../eval/gate.js';
import {
  DEFAULT_CONFIG,
  FETCH_STAGES,
  LEARN_STAGES,
  resumeNightly,
  runNightly,
  runStage,
} from './orchestrator.js';
import { inMemoryContext, unimplementedRuleStore } from './in-memory.js';
import { createFileManifestStore } from './file-manifests.js';
import type { LoopConfig, LoopContext } from './context.js';
import { STAGES } from './manifest.js';
import type { Stage } from './manifest.js';

const USAGE = `sii-auditor — the nightly audit loop (ADR-043)

  sii-auditor fetch [--dry-run] [--seed <n>] [--meses <n>] [--anios <n>]
      Stage 1 ONLY. Needs a live SII session — run 'sii auth login' first.
      This is the only mode that touches SII; it is a deliberate human act (ADR-006).

  sii-auditor learn [--dry-run] [--in-memory] [--seed <n>]
      Stages 2-8. NEVER touches SII: it works on artifacts already in the store.
      This is the scheduler's target ('make nightly'). Because the data may be days
      old, the manifest's 'dataAsOf' states how old, and the report leads with it.

  sii-auditor run [--dry-run] [--in-memory] [--seed <n>] [--meses <n>] [--anios <n>]
      All eight stages, for when a session exists and you want everything at once.
      --dry-run     decide everything, promote and persist nothing.
      --in-memory   drive the state machine with in-memory stores. The stages report
                    'not_implemented' honestly; use it to exercise the loop itself.

  sii-auditor resume <runId>
      Continue an interrupted run from its first unfinished stage.

  sii-auditor stage <runId> <stage>
      Re-run exactly one stage. Stages: ${STAGES.join(' ')}

  sii-auditor status [runId]
      Print a run manifest (the latest when runId is omitted).

  sii-auditor normativa load <file.json>
      Load transcribed regulation chunks into the corpus (ADR-045). The file is a JSON
      array of candidates; every one MUST carry an 'effective' range COPIED from the
      source's own version metadata. A chunk that cannot be dated is REFUSED and the
      whole batch is rejected — a guessed date yields a confident citation of the wrong
      year's law. This command never fetches: transcription is a human step by design.

  sii-auditor normativa list
      Print the anchors the corpus holds — the numerator of the coverage metric.

Environment:
  ${STORE_ROOT_ENV}   Absolute path to the artifact + entity store. MUST be outside the repo.
  ${GOLDEN_DIR_ENV}   Absolute path to the golden set of completed engagements.
`;

export type Command =
  'run' | 'fetch' | 'learn' | 'resume' | 'stage' | 'status' | 'normativa' | 'help';

export interface ParsedArgs {
  readonly command: Command;
  readonly runId?: string;
  readonly stage?: string;
  readonly inMemory: boolean;
  readonly config: Partial<LoopConfig>;
}

/**
 * Which stages a run mode drives (ADR-044). `undefined` ⇒ all eight.
 *
 * `fetch` is stage 1 alone because `ingest` is the ONLY stage that needs a live session; everything
 * from `extract` onward reads the artifact store, so `learn` runs unattended.
 */
export function stagesFor(command: Command): readonly Stage[] | undefined {
  if (command === 'fetch') return FETCH_STAGES;
  if (command === 'learn') return LEARN_STAGES;
  return undefined;
}

/** Pure, so it is testable without spawning a process. */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const [command, ...rest] = argv;
  const flags = new Map<string, string>();
  const positional: string[] = [];

  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (token === undefined) continue;
    if (token.startsWith('--')) {
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags.set(token.slice(2), next);
        i += 1;
      } else {
        flags.set(token.slice(2), 'true');
      }
    } else {
      positional.push(token);
    }
  }

  const config: Partial<LoopConfig> = {
    ...(flags.has('dry-run') ? { dryRun: true } : {}),
    ...(flags.has('seed') ? { seed: Number(flags.get('seed')) } : {}),
    ...(flags.has('meses') ? { meses: Number(flags.get('meses')) } : {}),
    ...(flags.has('anios') ? { anios: Number(flags.get('anios')) } : {}),
  };
  const inMemory = flags.has('in-memory');

  const known = new Set(['run', 'fetch', 'learn', 'resume', 'stage', 'status', 'normativa']);
  if (command === undefined || !known.has(command)) {
    return { command: 'help', inMemory, config };
  }

  return {
    command: command as ParsedArgs['command'],
    inMemory,
    config,
    ...(positional[0] !== undefined ? { runId: positional[0] } : {}),
    ...(positional[1] !== undefined ? { stage: positional[1] } : {}),
  };
}

/** Resolve the effective config. Env is read HERE only — never inside a stage. */
export function resolveConfig(overrides: Partial<LoopConfig>): LoopConfig {
  return {
    ...DEFAULT_CONFIG,
    taxpayers: [],
    tolerances: DEFAULT_TOLERANCES,
    ...overrides,
  };
}

/**
 * Wire the real dependencies — the composition root.
 *
 * Builds the `core` runtime with `createNodeRuntime` (`./node` subpath, ADR-016), wraps its
 * `PortalDriver` with `recordingDriver` so every fetch is captured, and constructs the file-backed
 * stores under `SII_AUDITOR_STORE`.
 *
 * WHAT IS REAL AND WHAT IS NOT, as of today: the recorder, the artifact store, the entity store,
 * the manifest store, the golden-set reader and the eval-result store are wired for real. The
 * review queue, the rule store, normativa and the behavior map are still throwing stubs. So a
 * `run` gets as far as the built parts allow and then reports honestly on the rest — a partially
 * built system doing its partial job, with the manifest saying exactly which parts are which.
 */
/** True when the selected stages include `ingest` — the only stage that needs a live session. */
export function needsSession(config: LoopConfig): boolean {
  return config.stages === undefined || config.stages.includes('ingest');
}

/**
 * A `PortalDriver` that refuses every call — what a `learn` run gets instead of a real one.
 *
 * ADR-044 says `learn` never touches SII. Leaving a working driver wired and relying on stage
 * selection alone would make that a CONVENTION; sealing the seam makes it a property. If a future
 * stage grows an accidental fetch, it fails loudly here rather than quietly reaching production SII
 * from an unattended 03:00 cron with nobody watching.
 */
export function sealedPortal(): Runtime['portal'] {
  const sealed = (what: string): never => {
    throw new NotImplemented(
      what,
      'a learn run never reaches SII (ADR-044) — run `sii-auditor fetch` after `sii auth login`',
    );
  };
  return {
    interactiveLogin: async () => sealed('PortalDriver.interactiveLogin'),
    credentialLogin: async () => sealed('PortalDriver.credentialLogin'),
    restore: async () => sealed('PortalDriver.restore'),
    requestPublic: async () => sealed('PortalDriver.requestPublic'),
  };
}

export async function buildContext(
  config: LoopConfig,
): Promise<Omit<LoopContext, 'runId' | 'config' | 'manifest'>> {
  const root = resolveStoreRoot(process.env[STORE_ROOT_ENV], process.cwd());
  const goldenDir = process.env[GOLDEN_DIR_ENV];

  const artifacts = createFileArtifactStore({ root });
  const base = createNodeRuntime();

  // UNDECORATED on purpose. Stage 1 wraps this per taxpayer with `recordingDriver`, because
  // artifacts must be filed under the subject they belong to and this root does not know which one
  // is being swept. Wrapping here would file a whole sweep under one key (the old `'unassigned'`
  // placeholder), and wrapping in BOTH places would record every response twice.
  //
  // In `learn` the driver is SEALED instead, so "never reaches SII" stays a property of the wiring
  // rather than a convention stage selection happens to honour (ADR-044).
  const runtime: Runtime = needsSession(config) ? base : { ...base, portal: sealedPortal() };

  const registry = new StrategyRegistry();
  registerCoreStrategies(registry);
  const golden = createFileGoldenSet(goldenDir ?? join(root, 'golden'));
  const results = createFileEvalResultStore(root);

  return {
    runtime,
    fetchPlan: DEFAULT_FETCH_PLAN,
    // Who the live session belongs to, as a KEY. The RUT comes from the local session record (no
    // extra SII call — liveness is tested by the first fetch anyway) and is hashed here, so the
    // stage never sees it. `null` when there is no session or it cannot be canonicalised, which
    // stage 1 treats as "cannot attribute" and refuses to record against.
    sessionSubject: async (): Promise<string | null> => {
      try {
        const status = await authStatus(base);
        if (status.rut === null) return null;
        return taxpayerKey(Rut.parse(status.rut).canonical, await loadSalt(base.store));
      } catch {
        return null;
      }
    },
    clock: base.clock,
    audit: base.audit,
    artifacts,
    entities: createFileNormalizedStore({ root }),
    extractions: createFileExtractionStore(root),
    reviews: createFileReviewQueue(root),
    strategies: registry,
    normativa: createFileNormativaStore(root),
    behavior: createFileBehaviorMap(root),
    rules: unimplementedRuleStore(),
    rejections: createRejectionLedger(),
    golden,
    harness: createEvalHarness({
      golden,
      registry,
      results,
      now: () => base.clock.now().toISOString(),
    }),
    evalResults: results,
    manifests: createFileManifestStore(root),
  };
}

/** Timestamped, sortable, filename-safe. Same shape as `deriveRunId`, from a `Date` instead. */
export function newRunId(now: Date): string {
  return deriveRunId({ now: () => now, sleep: async () => undefined });
}

export async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseArgs(argv);

  if (parsed.command === 'help') {
    process.stdout.write(USAGE);
    return argv.length === 0 ? 2 : 0;
  }

  const selection = stagesFor(parsed.command);

  // Subjects come from `<store>/subjects.json`, never from argv — a RUT is inside the
  // confidentiality boundary and a flag would publish it in the process list (`subjects.ts`).
  // Resolved HERE, at the composition root, so no stage ever sees anything but a `TaxpayerKey`.
  let taxpayers: readonly string[] = [];
  if (!parsed.inMemory) {
    try {
      const root = resolveStoreRoot(process.env[STORE_ROOT_ENV], process.cwd());
      const base = createNodeRuntime();
      taxpayers = await loadSubjects(root, await loadSalt(base.store));
    } catch (err) {
      if (err instanceof AuditorError) {
        process.stderr.write(`sii-auditor: cannot resolve subjects — ${err.message}\n`);
        return 1;
      }
      throw err;
    }
  }

  const config = resolveConfig({
    ...parsed.config,
    taxpayers,
    ...(selection === undefined ? {} : { stages: selection }),
  });

  let services: Omit<LoopContext, 'runId' | 'config' | 'manifest'>;
  try {
    services = parsed.inMemory ? inMemoryContext() : await buildContext(config);
  } catch (err) {
    // A misconfigured store root (`ConfidentialityError`) and a deferred dependency
    // (`NotImplemented`) are both operator-actionable: say what is wrong and exit 1, rather than
    // dumping a stack trace into a scheduler's log.
    if (err instanceof AuditorError) {
      process.stderr.write(`sii-auditor: cannot start — ${err.message}\n`);
      return 1;
    }
    throw err;
  }

  const deps = { services, config };

  switch (parsed.command) {
    // The three run modes differ only in which stages they select; the orchestrator is one.
    case 'run':
    case 'fetch':
    case 'learn': {
      const manifest = await runNightly(deps, newRunId(services.clock.now()));
      process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
      return manifest.status === 'aborted' ? 1 : 0;
    }
    case 'resume': {
      if (parsed.runId === undefined) {
        process.stderr.write('sii-auditor: resume needs a runId\n');
        return 2;
      }
      const manifest = await resumeNightly(deps, parsed.runId);
      process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
      return manifest.status === 'aborted' ? 1 : 0;
    }
    case 'stage': {
      if (parsed.runId === undefined || parsed.stage === undefined) {
        process.stderr.write('sii-auditor: stage needs a runId and a stage name\n');
        return 2;
      }
      if (!STAGES.includes(parsed.stage as Stage)) {
        process.stderr.write(`sii-auditor: unknown stage '${parsed.stage}'\n`);
        return 2;
      }
      const prior = await services.manifests.load(parsed.runId);
      if (prior === null) {
        process.stderr.write(`sii-auditor: no manifest for run ${parsed.runId}\n`);
        return 1;
      }
      const manifest = await runStage(deps, prior, parsed.stage as Stage);
      process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
      return 0;
    }
    case 'normativa': {
      // `runId`/`stage` are just the two positionals the parser collects; here they are the
      // subcommand and its argument.
      const sub = parsed.runId;
      if (sub === 'list') {
        const held = await services.normativa.anchors();
        process.stdout.write(`${JSON.stringify(held, null, 2)}\n`);
        return 0;
      }
      if (sub !== 'load' || parsed.stage === undefined) {
        process.stderr.write('sii-auditor: usage — normativa load <file.json> | normativa list\n');
        return 2;
      }
      const raw = await readFile(parsed.stage, 'utf8');
      const parsedFile: unknown = JSON.parse(raw);
      if (!Array.isArray(parsedFile)) {
        process.stderr.write('sii-auditor: the chunk file must be a JSON array of candidates\n');
        return 2;
      }
      try {
        // `loadChunks` refuses the WHOLE batch if any chunk cannot be dated — a partially loaded
        // corpus is one whose gaps nobody declared.
        const chunks = loadChunks(parsedFile as readonly NormativaCandidate[]);
        await services.normativa.upsert(chunks);
        process.stdout.write(
          `${JSON.stringify({ loaded: chunks.length, anchors: await services.normativa.anchors() }, null, 2)}\n`,
        );
        return 0;
      } catch (err) {
        // A refused chunk is the operator's cue to go and verify a date at the source, not a crash.
        // Same posture as the context-build handler above: say what is wrong, exit 1, no stack.
        if (err instanceof AuditorError) {
          process.stderr.write(`sii-auditor: corpus REFUSED — ${err.message}\n`);
          return 1;
        }
        throw err;
      }
    }
    case 'status': {
      const manifest =
        parsed.runId === undefined
          ? ((await services.manifests.recent(1))[0] ?? null)
          : await services.manifests.load(parsed.runId);
      if (manifest === null) {
        process.stderr.write('sii-auditor: no run manifest found\n');
        return 1;
      }
      process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
      return 0;
    }
  }
}

// Only execute when run as a binary — importing this module for tests must not start a sweep.
const invokedDirectly =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];

if (invokedDirectly) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
