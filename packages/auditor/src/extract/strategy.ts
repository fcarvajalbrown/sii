// Extraction strategies + the versioned registry (ADR-043).
//
// A strategy is a named, versioned parser from raw artifact bytes to typed records. Registering
// them — rather than calling parsers directly — buys three things the loop needs:
//
//   1. ATTRIBUTION. Every record carries `<strategyId>@<version>`, so "did accuracy change because
//      the parser changed or because SII changed?" is answerable from the data.
//   2. COEXISTENCE. Two versions of one strategy can be registered at once, which is how stage 6
//      evaluates a proposed parser against the golden set WITHOUT touching the production one.
//   3. SELECTION. `appliesTo` matches on the manifest, so the loop routes each artifact to its
//      parsers without a switch statement that every new surface has to edit.
//
// RELATIONSHIP TO `packages/core`: strategies WRAP the existing facades, they do not replace them.
// The 14 facades are already the correct, live-observed, cited parsers (ADR-004) with ~596 tests
// behind them. Rewriting them here would fork the SII knowledge that took this project a year to
// acquire. A strategy's job is to invoke one and attach confidence + provenance.

import type { FetchManifest } from '../ingest/manifest.js';
import type { AnyEntity } from '../store/entities.js';
import type { ExtractionOutcome, ExtractionRecord } from './record.js';
import { bpstPaginaStrategy } from './strategies/bpst-pagina.js';
import { bteResumenStrategy } from './strategies/bte-resumen.js';
import { f29PropuestaStrategy } from './strategies/f29-propuesta.js';
import { rcvResumenStrategy } from './strategies/rcv-resumen.js';

/** Which artifacts a strategy can parse. Matched against the manifest, cheaply, before any I/O. */
export interface StrategyScope {
  /** Substring or regex the fetched URL must match. */
  readonly url: string | RegExp;
  /** Restrict to specific transports, e.g. `['requestJson']`. Omit for any. */
  readonly transports?: readonly FetchManifest['transport'][];
}

export interface ExtractionContext {
  readonly manifest: FetchManifest;
  readonly bytes: Buffer;
  readonly runId: string;
  /** Pseudonymous subject (`confidential.ts`). */
  readonly taxpayer: string;
  /** ISO instant from the `Clock` seam — never `Date.now()` (ADR-043 §I5). */
  readonly now: string;
}

export interface ExtractionStrategy<T = unknown> {
  /** Stable, kebab-case, surface-scoped: `rcv-detalle`, `f22-codigos`, `giros-tabla`. */
  readonly id: string;
  /**
   * Monotonic integer. Bumped on ANY behaviour change, including a threshold tweak — the whole
   * point is that a metric shift is attributable to a specific version.
   */
  readonly version: number;
  readonly scope: StrategyScope;
  /** One line for the nightly report and the review queue UI. */
  readonly describes: string;
  /**
   * Parse. MUST be deterministic: same bytes + same version ⇒ same records, same ids, same
   * confidence. MUST NOT perform I/O, and MUST NOT reach SII — the bytes are already here.
   */
  extract(ctx: ExtractionContext): Promise<ExtractionOutcome<T>>;

  /**
   * Project one extracted record into normalized rows, so stage 2 can upsert them.
   *
   * WHY THE STRATEGY OWNS THIS and not the stage: only the parser knows the natural key of what it
   * read (taxpayer + período + form + código, say), and `entityId` must be derived from that key or
   * every reproducibility guarantee in ADR-043 §I5 collapses into a diff of meaningless ids. A
   * generic projection in the stage would have to guess.
   *
   * OPTIONAL, and the absence is REPORTED, never silent: a strategy without a projection has its
   * records logged and routed as normal, and the stage counts them under `unprojected` and names
   * the strategy in its summary. That is the honest state for a parser whose entity mapping has not
   * been decided yet — inventing one would put a wrong-shaped row in the store, which is worse than
   * an absent row because everything downstream would treat it as fact.
   *
   * Returning `[]` means "this record genuinely yields no rows" and is NOT the same as omitting the
   * method.
   */
  toEntities?(record: ExtractionRecord<T>, ctx: EntityProjectionContext): readonly AnyEntity[];
}

/** What a projection needs beyond the record itself — the spine fields only the stage knows. */
export interface EntityProjectionContext {
  /** From the `Clock` seam, so a projection never reads the wall clock (ADR-043 §I5). */
  readonly recordedAt: string;
  readonly taxpayer: string;
}

export const strategyRef = (s: Pick<ExtractionStrategy, 'id' | 'version'>): string =>
  `${s.id}@${s.version}`;

/**
 * The registry. Holds every registered version of every strategy; `resolve` picks the ACTIVE one
 * per id (highest version that has been activated), while `candidates` exposes the rest so stage 6
 * can evaluate a proposal in isolation.
 */
export class StrategyRegistry {
  readonly #byRef = new Map<string, ExtractionStrategy>();
  readonly #active = new Map<string, number>();

  /**
   * Register a version. Registering does NOT activate it — a newly proposed parser is inert until
   * the gate promotes it (ADR-043 §I4). Re-registering the same ref is an error, not a silent
   * overwrite: two different parsers under one ref would make attribution a lie.
   */
  register(strategy: ExtractionStrategy): void {
    const ref = strategyRef(strategy);
    if (this.#byRef.has(ref)) {
      throw new Error(`strategy ${ref} is already registered — bump the version instead`);
    }
    this.#byRef.set(ref, strategy);
    if (!this.#active.has(strategy.id)) this.#active.set(strategy.id, strategy.version);
  }

  /** Promote a registered version to active. Called by the gate, never by a stage directly. */
  activate(id: string, version: number): void {
    const ref = `${id}@${version}`;
    if (!this.#byRef.has(ref)) throw new Error(`cannot activate unregistered strategy ${ref}`);
    this.#active.set(id, version);
  }

  /** The active version of one strategy, or `undefined`. */
  resolve(id: string): ExtractionStrategy | undefined {
    const v = this.#active.get(id);
    return v === undefined ? undefined : this.#byRef.get(`${id}@${v}`);
  }

  /** Active strategies whose scope matches this manifest, `id` ascending (deterministic order). */
  match(manifest: FetchManifest): readonly ExtractionStrategy[] {
    return [...this.#active.keys()].sort().flatMap((id) => {
      const s = this.resolve(id);
      return s && inScope(s.scope, manifest) ? [s] : [];
    });
  }

  /** Registered-but-not-active versions — what stage 6 evaluates and stage 7 may promote. */
  candidates(): readonly ExtractionStrategy[] {
    return [...this.#byRef.values()]
      .filter((s) => this.#active.get(s.id) !== s.version)
      .sort((a, b) => strategyRef(a).localeCompare(strategyRef(b)));
  }

  /** Every registered version, for the run manifest's `ruleSetVersion` fingerprint. */
  all(): readonly ExtractionStrategy[] {
    return [...this.#byRef.values()].sort((a, b) => strategyRef(a).localeCompare(strategyRef(b)));
  }
}

export function inScope(scope: StrategyScope, manifest: FetchManifest): boolean {
  if (scope.transports && !scope.transports.includes(manifest.transport)) return false;
  return typeof scope.url === 'string'
    ? manifest.url.includes(scope.url)
    : scope.url.test(manifest.url);
}

/**
 * Register the production strategy set — the parsers a real run extracts with.
 *
 * Today that is the three golden-set parsers (`f29-propuesta`, `bte-resumen`, `bpst-pagina`).
 * The remaining shipped `core` facades still have NO wrapper, and the original deferral reasoning
 * stands for them: each wrapper needs its facade's raw-payload shape to compute `alias_fallback` /
 * `unknown_keys` signals honestly, and those live inside the facades' private zod projections.
 * Note the gap the registered set leaves open (pinned by a test in `strategy.test.ts`): none of
 * these three matches a surface the DEFAULT fetch plan sweeps, so a fetch+extract of plan
 * artifacts upserts nothing until a wrapper for a swept surface (start with `rcv-detalle`) lands.
 */
export function registerCoreStrategies(registry: StrategyRegistry): void {
  registry.register(bpstPaginaStrategy);
  registry.register(bteResumenStrategy);
  registry.register(f29PropuestaStrategy);
  registry.register(rcvResumenStrategy);
}
