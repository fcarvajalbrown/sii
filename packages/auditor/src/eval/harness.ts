// The regression harness (ADR-043) — replays the golden set and produces an `EvalResult`.
//
// TWO PROPERTIES ARE NON-NEGOTIABLE:
//
//  1. IT NEVER TOUCHES SII. It replays the golden set's STORED artifacts through the registered
//     strategies. That is what makes it fast enough to run twice a night, deterministic, and safe
//     to run repeatedly — and it matches the project's standing rule that tests never hit prod.
//  2. IT EVALUATES A CHANGE-SET IN ISOLATION. `run` takes the strategy refs to substitute, so a
//     proposed parser is measured WITHOUT being active in production. That is what makes
//     "propose, then gate, then promote" possible rather than "promote, then find out".
//
// DETERMINISM: engagements in id order, manifests in `retrievedAt` then `contentHash` order,
// strategies in `id` order. Two runs over the same inputs produce byte-identical results.

import { needsReview } from '../extract/confidence.js';
import { strategyRef } from '../extract/strategy.js';
import type { ExtractionStrategy, StrategyRegistry } from '../extract/strategy.js';
import { inScope } from '../extract/strategy.js';
import type { ExtractionRecord } from '../extract/record.js';
import type { RuleRecord } from '../rules/record.js';
import type { NormativaStore } from '../kb/normativa.js';
import type { GoldenSet } from './golden.js';
import type { EvalResult, EvalResultStore } from './result.js';
import { extractionMetrics, findingMetrics, normativaMetrics } from './metrics.js';
import type { ProducedFinding, ResolvedAnchor } from './metrics.js';
import { checkCorroboration } from './corroboration.js';

export interface HarnessDeps {
  readonly golden: GoldenSet;
  readonly registry: StrategyRegistry;
  readonly results: EvalResultStore;
  /** ISO instant from the `Clock` seam (ADR-043 §I5). */
  readonly now: () => string;
  /**
   * Optional. Without it every expected citation counts as unresolved and normativa coverage is
   * 0 — which is the honest reading today, since no corpus is loaded (`kb/normativa.ts`).
   */
  readonly normativa?: NormativaStore;
  /**
   * Findings the system produced for an engagement. Absent until rules are evaluated end to end;
   * without it, finding precision/recall are measured against an empty produced set (recall 0,
   * precision null) rather than silently skipped.
   */
  readonly findingsFor?: (engagementId: string) => Promise<readonly ProducedFinding[]>;
}

export interface HarnessRun {
  readonly runId: string;
  /** Engagements to evaluate. Omit for all — the nightly default. */
  readonly engagements?: readonly string[];
  /**
   * `<strategyId>@<version>` refs to use INSTEAD of the active ones, per strategy id. `undefined`
   * measures production as it stands (the baseline run).
   */
  readonly candidateStrategies?: readonly string[];
  /** Rule versions under test. Recorded in `ruleSetVersion`; rule evaluation is still deferred. */
  readonly candidateRules?: readonly RuleRecord[];
}

export interface EvalHarness {
  /** Evaluate and persist. The persisted result is what `gate.ts` later compares against. */
  run(request: HarnessRun): Promise<EvalResult>;
}

export function createEvalHarness(deps: HarnessDeps): EvalHarness {
  return {
    async run(request: HarnessRun): Promise<EvalResult> {
      const startedMs = Date.parse(deps.now());

      const ids = [...(request.engagements ?? (await deps.golden.list()))].sort();
      const goldenSetVersion = await deps.golden.version();
      const strategies = resolveStrategies(deps.registry, request.candidateStrategies);

      const expectedFields = [];
      const expectedFindings = [];
      const expectedCitations = [];
      const produced: ExtractionRecord[] = [];
      const producedFindings: ProducedFinding[] = [];
      const resolvedAnchors: ResolvedAnchor[] = [];
      let routedToReview = 0;
      let failures = 0;

      for (const id of ids) {
        const engagement = await deps.golden.load(id);
        // W8: refuse to measure against ground truth that contradicts itself. Throws when a
        // declared identity evaluates false — every metric computed from such a set would be
        // measured against a value the set itself says is wrong, and the gate would then enforce
        // that wrongness. Checked here because this is the only place a golden set is consumed.
        checkCorroboration(engagement.fields);
        expectedFields.push(...engagement.fields);
        expectedFindings.push(...engagement.findings);
        expectedCitations.push(...engagement.citations);

        const manifests = [...engagement.manifests].sort(
          (a, b) =>
            a.retrievedAt.localeCompare(b.retrievedAt) ||
            a.contentHash.localeCompare(b.contentHash),
        );

        for (const manifest of manifests) {
          const bytes = await deps.golden.artifact(id, manifest.contentHash);
          if (bytes === null) {
            // The engagement cites evidence it does not hold. Counted, never skipped silently.
            failures += 1;
            continue;
          }

          for (const strategy of strategies.filter((s) => inScope(s.scope, manifest))) {
            try {
              const outcome = await strategy.extract({
                manifest,
                bytes,
                runId: request.runId,
                taxpayer: manifest.taxpayer,
                now: deps.now(),
              });
              produced.push(...outcome.records);
              failures += outcome.failures.length;
              routedToReview += outcome.records.filter((r) => needsReview(r.confidence)).length;
            } catch {
              // A strategy that throws is a failed extraction, not a failed run — one broken
              // parser must not hide the accuracy of the others.
              failures += 1;
            }
          }
        }

        if (deps.findingsFor !== undefined) {
          producedFindings.push(...(await deps.findingsFor(id)));
        }
        resolvedAnchors.push(...(await resolveCitations(deps.normativa, engagement.citations)));
      }

      // The denominator is the anchors these engagements actually NEEDED — not a corpus registry
      // we do not have, and not the anchors we happen to hold (that always reads 100%).
      const expectedAnchorCount = new Set(expectedCitations.map((c) => `${c.anchor}|${c.asOf}`))
        .size;

      const finishedIso = deps.now();
      const result: EvalResult = {
        runId: request.runId,
        evaluatedAt: finishedIso,
        goldenSetVersion,
        ruleSetVersion: ruleSetVersionOf(request.candidateRules),
        strategyVersions: strategies.map(strategyRef).sort(),
        engagements: ids,
        extraction: extractionMetrics(expectedFields, produced, routedToReview, failures),
        normativa: normativaMetrics(expectedCitations, resolvedAnchors, expectedAnchorCount),
        findings: findingMetrics(expectedFindings, producedFindings),
        durationMs: Math.max(0, Date.parse(finishedIso) - startedMs),
      };

      await deps.results.put(result);
      return result;
    },
  };
}

/**
 * Active strategies, with any candidate refs substituted for their id.
 *
 * A candidate REPLACES the active version of the same id rather than running alongside it —
 * otherwise both would extract the same field and the last one written would silently decide the
 * measurement.
 */
function resolveStrategies(
  registry: StrategyRegistry,
  candidateRefs?: readonly string[],
): readonly ExtractionStrategy[] {
  const all = registry.all();
  const candidates = (candidateRefs ?? []).flatMap((ref) => {
    const found = all.find((s) => strategyRef(s) === ref);
    if (found === undefined) throw new Error(`unknown candidate strategy ${ref}`);
    return [found];
  });
  const overridden = new Set(candidates.map((s) => s.id));

  const active = all.filter((s) => {
    const resolved = registry.resolve(s.id);
    return resolved !== undefined && strategyRef(resolved) === strategyRef(s);
  });

  return [...active.filter((s) => !overridden.has(s.id)), ...candidates].sort((a, b) =>
    strategyRef(a).localeCompare(strategyRef(b)),
  );
}

/** Ask the KB whether each cited anchor resolves, and to the right effective version. */
async function resolveCitations(
  normativa: NormativaStore | undefined,
  citations: readonly { readonly anchor: string; readonly asOf: string }[],
): Promise<readonly ResolvedAnchor[]> {
  const out: ResolvedAnchor[] = [];
  for (const c of citations) {
    if (normativa === undefined) {
      out.push({ anchor: c.anchor, asOf: c.asOf, resolved: false, correctVersion: false });
      continue;
    }
    try {
      const chunk = await normativa.resolve(c.anchor, c.asOf);
      out.push({
        anchor: c.anchor,
        asOf: c.asOf,
        resolved: chunk !== null,
        // `resolve` is contracted to return the version in force ON `asOf`, so a non-null answer
        // IS the right version. A future store that returns a nearest match must revisit this.
        correctVersion: chunk !== null,
      });
    } catch {
      // No corpus loaded yet — unresolved, which is the honest reading (coverage 0).
      out.push({ anchor: c.anchor, asOf: c.asOf, resolved: false, correctVersion: false });
    }
  }
  return out;
}

/** Deterministic fingerprint of the rule versions under test. `none` when no rules are involved. */
function ruleSetVersionOf(rules: readonly RuleRecord[] | undefined): string {
  if (rules === undefined || rules.length === 0) return 'none';
  return rules
    .map((r) => `${r.id}@${r.current.version}`)
    .sort()
    .join(',');
}
