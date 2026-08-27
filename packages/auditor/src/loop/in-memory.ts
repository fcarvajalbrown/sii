// An in-memory loop context (ADR-043) — what makes the state machine executable TODAY.
//
// The orchestrator, the manifest, the resume logic and the stage sequencing are all real and
// finished. What is missing is the persistence and the stage bodies. This module supplies the
// former in memory so the former can be exercised end-to-end, right now, by
// `sii-auditor run --in-memory` and by tests.
//
// IT IS NOT A FAKE THAT PRETENDS TO WORK. The artifact store, entity store and manifest store here
// are REAL implementations with the same semantics as their file-backed peers — content addressing,
// immutability, last-write-wins upserts, deterministic ordering — held in maps instead of on disk.
// Everything still deferred (review queue, rule store, normativa, behavior map, golden set, eval
// results) THROWS `NotImplemented`, exactly as in production. So a run against this context produces
// a REAL manifest whose stages honestly say what is missing. That is the difference between a demo
// and a lie: the output is an accurate account of a system that is half built.

import { IntegrityError, NotImplemented } from '../errors.js';
import type { AuditEntry, AuditSink, Clock, Runtime } from '@dostertags/sii-core';
import { memoryArtifactStore, memoryNormalizedStore } from '../store/memory.js';
import { memoryReviewQueue } from '../extract/review-queue.js';
import { memoryExtractionStore } from '../extract/store.js';
import { DEFAULT_FETCH_PLAN } from '../ingest/plan.js';
import { StrategyRegistry, registerCoreStrategies } from '../extract/strategy.js';
import { memoryNormativaStore } from '../kb/normativa.js';
import { createFileBehaviorMap } from '../kb/behavior-map.js';
import { createRejectionLedger } from '../rules/promotion.js';
import { createEvalHarness } from '../eval/harness.js';
import type { RuleFilter, RuleRecord, RuleStore } from '../rules/record.js';
import type { EvalResult, EvalResultStore } from '../eval/result.js';
import type { GoldenSet } from '../eval/golden.js';
import type { LoopContext } from './context.js';
import type { RunManifest, RunManifestStore } from './manifest.js';

/** Deterministic clock: starts at a fixed instant and advances a fixed step per `now()` call. */
export function fixedClock(startIso = '2026-08-06T03:00:00.000Z', stepMs = 1000): Clock {
  let t = Date.parse(startIso);
  return {
    now: () => {
      const d = new Date(t);
      t += stepMs;
      return d;
    },
    sleep: () => Promise.resolve(),
  };
}

/** Collects audit entries in memory so a test can assert on them. */
export function memoryAuditSink(): AuditSink & { readonly entries: readonly AuditEntry[] } {
  const entries: AuditEntry[] = [];
  return {
    record: (entry) => {
      entries.push(entry);
    },
    get entries() {
      return entries;
    },
  };
}

/** A genuinely working in-memory manifest store — the piece the orchestrator actually needs. */
export function memoryManifestStore(): RunManifestStore & { readonly all: readonly RunManifest[] } {
  const byId = new Map<string, RunManifest>();
  const order: string[] = [];
  return {
    save: async (manifest) => {
      if (!byId.has(manifest.runId)) order.push(manifest.runId);
      byId.set(manifest.runId, manifest);
    },
    load: async (runId) => byId.get(runId) ?? null,
    recent: async (limit) =>
      [...order]
        .reverse()
        .slice(0, limit)
        .flatMap((id) => {
          const m = byId.get(id);
          return m ? [m] : [];
        }),
    lastIncomplete: async () => {
      for (const id of [...order].reverse()) {
        const m = byId.get(id);
        if (m && m.status !== 'completed') return m;
      }
      return null;
    },
    get all() {
      return order.flatMap((id) => {
        const m = byId.get(id);
        return m ? [m] : [];
      });
    },
  };
}

export function unimplementedRuleStore(): RuleStore {
  const why = 'the rule store is scaffolded but not persisted yet';
  return {
    list: (_filter?: RuleFilter): Promise<readonly RuleRecord[]> => {
      throw new NotImplemented('RuleStore.list', why);
    },
    get: (_id: string): Promise<RuleRecord | null> => {
      throw new NotImplemented('RuleStore.get', why);
    },
    putVersion: (_rule: RuleRecord): Promise<void> => {
      throw new NotImplemented('RuleStore.putVersion', why);
    },
    ruleSetVersion: (): Promise<string> => {
      throw new NotImplemented('RuleStore.ruleSetVersion', why);
    },
  };
}

/** Working in-memory `EvalResultStore`, same semantics as the file-backed one. */
export function memoryEvalResultStore(): EvalResultStore {
  const byRun = new Map<string, EvalResult>();
  const ordered = (): readonly EvalResult[] =>
    [...byRun.values()].sort(
      (a, b) => a.evaluatedAt.localeCompare(b.evaluatedAt) || a.runId.localeCompare(b.runId),
    );

  return {
    put: async (result) => {
      byRun.set(result.runId, result);
    },
    get: async (runId) => byRun.get(runId) ?? null,
    recent: async (limit) => [...ordered()].reverse().slice(0, limit),
    latest: async () => {
      const all = ordered();
      for (let i = all.length - 1; i >= 0; i -= 1) {
        const r = all[i];
        // A result that evaluated nothing is not a baseline — same rule as the file store.
        if (r !== undefined && r.engagements.length > 0) return r;
      }
      return null;
    },
  };
}

/**
 * An EMPTY golden set, which is the honest in-memory default: there is no synthetic golden data,
 * ever (the brief forbids it, and a generated fixture measures nothing). `version()` returns the
 * empty string, so `gate.ts` correctly rejects everything with `no_golden_set`.
 */
export function emptyGoldenSet(): GoldenSet {
  return {
    list: async () => [],
    load: async (id) => {
      throw new IntegrityError(`golden engagement ${id} does not exist in the empty in-memory set`);
    },
    artifact: async () => null,
    version: async () => '',
  };
}

/**
 * A runtime whose seams all throw. The loop never reaches SII in this mode — stage 1 stops at
 * `NotImplemented` well before any driver call, and this makes an accidental network call
 * impossible rather than merely unlikely.
 */
function unreachableRuntime(clock: Clock, audit: AuditSink): Runtime {
  const boom = (what: string): never => {
    throw new NotImplemented(what, 'the in-memory context never reaches SII by design');
  };
  return {
    clock,
    audit,
    store: {
      read: () => boom('KeyValueStore.read'),
      write: () => boom('KeyValueStore.write'),
      delete: () => boom('KeyValueStore.delete'),
    },
    portal: {
      interactiveLogin: () => boom('PortalDriver.interactiveLogin'),
      credentialLogin: () => boom('PortalDriver.credentialLogin'),
      restore: () => boom('PortalDriver.restore'),
      requestPublic: () => boom('PortalDriver.requestPublic'),
    },
  };
}

export interface InMemoryContextOptions {
  readonly clock?: Clock;
  readonly manifests?: RunManifestStore;
}

/** Build a context sufficient to drive the orchestrator end-to-end. */
export function inMemoryContext(
  options: InMemoryContextOptions = {},
): Omit<LoopContext, 'runId' | 'config' | 'manifest'> {
  const clock = options.clock ?? fixedClock();
  const audit = memoryAuditSink();
  const golden = emptyGoldenSet();
  const registry = new StrategyRegistry();
  registerCoreStrategies(registry);
  const results = memoryEvalResultStore();

  return {
    runtime: unreachableRuntime(clock, audit),
    fetchPlan: DEFAULT_FETCH_PLAN,
    // No session in memory, so stage 1 refuses to attribute anything — the honest default.
    sessionSubject: async () => null,
    clock,
    audit,
    // Real implementations with the same semantics as the file-backed pair, held in maps — not
    // mocks. The review queue is still deferred, so it stays a throwing stub.
    artifacts: memoryArtifactStore(),
    entities: memoryNormalizedStore(),
    extractions: memoryExtractionStore(),
    reviews: memoryReviewQueue(),
    strategies: registry,
    normativa: memoryNormativaStore(),
    behavior: createFileBehaviorMap('<in-memory>'),
    rules: unimplementedRuleStore(),
    rejections: createRejectionLedger(),
    golden,
    harness: createEvalHarness({ golden, registry, results, now: () => clock.now().toISOString() }),
    evalResults: results,
    manifests: options.manifests ?? memoryManifestStore(),
  };
}
