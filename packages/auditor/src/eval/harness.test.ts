// End-to-end proof of the measurement chain (ADR-043): a golden engagement on disk → the harness
// replays its stored artifacts through a registered strategy → metrics → a gate decision.
//
// The engagement here is SYNTHETIC — it is a fixture for the HARNESS, not a golden set. Real
// golden engagements come from completed audits and are never generated (the brief forbids it, and
// a generated fixture measures nothing about extraction). What this proves is that the machinery
// computes what it claims to; whether the numbers mean anything depends on real engagements.

import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IntegrityError } from '../errors.js';
import { StrategyRegistry } from '../extract/strategy.js';
import type { ExtractionStrategy } from '../extract/strategy.js';
import { contentHash, instant } from '../provenance.js';
import { memoryEvalResultStore } from '../loop/in-memory.js';
import { createFileGoldenSet } from './file-golden.js';
import { createFileEvalResultStore } from './file-results.js';
import { createEvalHarness } from './harness.js';
import { evaluateGate } from './gate.js';
import type { EvalResult } from './result.js';

let root: string;
const NOW = '2026-08-06T03:00:00.000Z';

beforeEach(async () => {
  root = await fsp.mkdtemp(join(tmpdir(), 'sii-auditor-eval-'));
});
afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

/** Write a minimal engagement to disk and return its artifact hash. */
async function writeEngagement(
  id: string,
  body: string,
  opts: { expected?: number; sealed?: boolean } = {},
): Promise<string> {
  const dir = join(root, id);
  const hash = createHash('sha256').update(body).digest('hex');

  await fsp.mkdir(join(dir, 'artifacts'), { recursive: true });
  await fsp.mkdir(join(dir, 'expected'), { recursive: true });

  await fsp.writeFile(
    join(dir, 'manifest.json'),
    JSON.stringify({
      id,
      taxpayer: 'tk-aaa',
      periods: ['202309'],
      regimen: 'M14A',
      applicableCorpus: [],
      sealedAt: opts.sealed === false ? '' : NOW,
      sealedBy: 'operator-1',
      notes: 'harness fixture',
    }),
  );
  await fsp.writeFile(join(dir, 'artifacts', hash), body);
  await fsp.writeFile(
    join(dir, 'artifacts', 'manifests.jsonl'),
    `${JSON.stringify({
      contentHash: hash,
      url: 'https://zeus.sii.cl/cvc_cgi/bte/bte_indiv_cons2',
      transport: 'requestForm',
      httpStatus: 200,
      retrievedAt: NOW,
      contentType: null,
      byteLength: body.length,
      durationMs: 5,
      taxpayer: 'tk-aaa',
      runId: 'run-0',
    })}\n`,
  );
  await fsp.writeFile(
    join(dir, 'expected', 'extractions.jsonl'),
    `${JSON.stringify({
      artifact: hash,
      path: 'retencionTotal',
      expected: opts.expected ?? 164368,
      verified: true,
    })}\n`,
  );
  await fsp.writeFile(join(dir, 'expected', 'findings.jsonl'), '');
  await fsp.writeFile(
    join(dir, 'expected', 'citations.jsonl'),
    `${JSON.stringify({ findingId: 'f1', anchor: 'DL-824/1974#art-74', asOf: '2023-09-30' })}\n`,
  );
  return hash;
}

/** Mark an engagement superseded, the only supported way to correct or extend a sealed one. */
async function supersede(id: string, by: string): Promise<void> {
  const path = join(root, id, 'manifest.json');
  const m = JSON.parse(await fsp.readFile(path, 'utf8')) as Record<string, unknown>;
  await fsp.writeFile(path, JSON.stringify({ ...m, supersededBy: by }));
}

/** A strategy that reads `retencionTotal` out of the fixture body. */
function bpstStrategy(version = 1, offset = 0): ExtractionStrategy {
  return {
    id: 'bpst-mensual',
    version,
    scope: { url: 'bte_indiv_cons2', transports: ['requestForm'] },
    describes: 'BPST monthly totals',
    async extract(ctx) {
      const match = /retencionTotal=(\d+)/.exec(ctx.bytes.toString('utf8'));
      if (match === null) {
        return {
          records: [],
          failures: [
            {
              strategy: `bpst-mensual@${version}`,
              provenance: {
                kind: 'artifact',
                artifact: contentHash(ctx.manifest.contentHash),
                url: ctx.manifest.url,
                retrievedAt: instant(ctx.manifest.retrievedAt),
                strategy: `bpst-mensual@${version}`,
                locator: '/',
              },
              message: 'no se encontró la fila (*)Totales',
              failedAt: instant(ctx.now),
              taxpayer: ctx.taxpayer,
              runId: ctx.runId,
            },
          ],
        };
      }
      return {
        records: [
          {
            id: `${ctx.manifest.contentHash}:bpst`,
            strategy: `bpst-mensual@${version}`,
            provenance: {
              kind: 'artifact',
              artifact: contentHash(ctx.manifest.contentHash),
              url: ctx.manifest.url,
              retrievedAt: instant(ctx.manifest.retrievedAt),
              strategy: `bpst-mensual@${version}`,
              locator: '/retencionTotal',
            },
            value: { retencionTotal: Number(match[1]) + offset },
            confidence: 1,
            signals: [],
            extractedAt: instant(ctx.now),
            taxpayer: ctx.taxpayer,
            runId: ctx.runId,
          },
        ],
        failures: [],
      };
    },
  };
}

function harnessFor(registry: StrategyRegistry, results = memoryEvalResultStore()) {
  return {
    harness: createEvalHarness({
      golden: createFileGoldenSet(root),
      registry,
      results,
      now: () => NOW,
    }),
    results,
  };
}

describe('the measurement chain, end to end', () => {
  it('replays a stored artifact and scores extraction accuracy', async () => {
    await writeEngagement('eng-1', 'retencionTotal=164368');
    const registry = new StrategyRegistry();
    registry.register(bpstStrategy());

    const { harness } = harnessFor(registry);
    const result = await harness.run({ runId: 'run-1' });

    expect(result.engagements).toEqual(['eng-1']);
    expect(result.extraction.fieldsCompared).toBe(1);
    expect(result.extraction.fieldsCorrect).toBe(1);
    expect(result.extraction.accuracy).toBe(1);
    expect(result.strategyVersions).toEqual(['bpst-mensual@1']);
    expect(result.goldenSetVersion).not.toBe('');
  });

  it('catches a parser that reads the wrong figure', async () => {
    await writeEngagement('eng-1', 'retencionTotal=164368');
    const registry = new StrategyRegistry();
    registry.register(bpstStrategy(1, 1)); // off by one peso

    const { harness } = harnessFor(registry);
    const result = await harness.run({ runId: 'run-1' });
    expect(result.extraction.accuracy).toBe(0);
  });

  it('counts an extraction failure without aborting the run', async () => {
    await writeEngagement('eng-1', 'no totals here');
    const registry = new StrategyRegistry();
    registry.register(bpstStrategy());

    const { harness } = harnessFor(registry);
    const result = await harness.run({ runId: 'run-1' });
    expect(result.extraction.failures).toBe(1);
    expect(result.extraction.accuracy).toBe(0);
  });

  it('survives a strategy that throws — one broken parser must not hide the others', async () => {
    await writeEngagement('eng-1', 'retencionTotal=164368');
    const registry = new StrategyRegistry();
    registry.register({
      ...bpstStrategy(),
      id: 'exploding',
      extract: () => {
        throw new Error('boom');
      },
    });
    registry.register(bpstStrategy());

    const { harness } = harnessFor(registry);
    const result = await harness.run({ runId: 'run-1' });
    expect(result.extraction.accuracy).toBe(1);
    expect(result.extraction.failures).toBe(1);
  });

  it('reports normativa coverage as 0 while no corpus is loaded', async () => {
    await writeEngagement('eng-1', 'retencionTotal=164368');
    const registry = new StrategyRegistry();
    registry.register(bpstStrategy());

    const { harness } = harnessFor(registry);
    const result = await harness.run({ runId: 'run-1' });
    // One anchor needed, none held. Honest, and it is what the gate sees.
    expect(result.normativa.expectedAnchors).toBe(1);
    expect(result.normativa.heldAnchors).toBe(0);
    expect(result.normativa.coverage).toBe(0);
  });

  it('is deterministic — same inputs, byte-identical result', async () => {
    await writeEngagement('eng-1', 'retencionTotal=164368');
    const registry = new StrategyRegistry();
    registry.register(bpstStrategy());
    const { harness } = harnessFor(registry);

    const a = await harness.run({ runId: 'run-1' });
    const b = await harness.run({ runId: 'run-1' });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('persists the result so trends are queryable', async () => {
    await writeEngagement('eng-1', 'retencionTotal=164368');
    const registry = new StrategyRegistry();
    registry.register(bpstStrategy());
    const results = createFileEvalResultStore(root);
    const { harness } = harnessFor(registry, results);

    await harness.run({ runId: 'run-1' });
    expect((await results.get('run-1'))?.extraction.accuracy).toBe(1);
    expect(await results.latest()).not.toBeNull();
  });
});

describe('evaluating a change-set in isolation', () => {
  it('substitutes a candidate for the active version of the same id', async () => {
    await writeEngagement('eng-1', 'retencionTotal=164368');
    const registry = new StrategyRegistry();
    registry.register(bpstStrategy(1, 1)); // active, and wrong
    registry.register(bpstStrategy(2)); // candidate, correct — registered but NOT activated

    const { harness } = harnessFor(registry);

    const baseline = await harness.run({ runId: 'base' });
    expect(baseline.extraction.accuracy).toBe(0);

    const candidate = await harness.run({
      runId: 'cand',
      candidateStrategies: ['bpst-mensual@2'],
    });
    expect(candidate.extraction.accuracy).toBe(1);
    expect(candidate.strategyVersions).toEqual(['bpst-mensual@2']);

    // And the gate promotes it, because extraction improved with nothing regressing.
    const decision = evaluateGate(candidate, baseline);
    expect(decision.verdict).toBe('promote');
    expect(decision.explanation).toContain('extraction.accuracy');
  });

  it('rejects an unknown candidate ref rather than silently measuring production', async () => {
    await writeEngagement('eng-1', 'retencionTotal=164368');
    const registry = new StrategyRegistry();
    registry.register(bpstStrategy());
    const { harness } = harnessFor(registry);

    await expect(
      harness.run({ runId: 'r', candidateStrategies: ['bpst-mensual@99'] }),
    ).rejects.toThrow(/unknown candidate strategy/);
  });
});

describe('the gate over a real harness result', () => {
  it('rejects everything when the golden set is empty', async () => {
    const registry = new StrategyRegistry();
    const { harness } = harnessFor(registry);

    const result = await harness.run({ runId: 'run-1' });
    expect(result.engagements).toEqual([]);
    expect(result.goldenSetVersion).toBe('');

    const decision = evaluateGate(result, null);
    expect(decision.verdict).toBe('reject');
    expect(decision.reason).toBe('no_golden_set');
  });

  it('does not treat a zero-engagement result as a baseline', async () => {
    const results = memoryEvalResultStore();
    const empty: EvalResult = {
      runId: 'empty',
      evaluatedAt: NOW,
      goldenSetVersion: '',
      ruleSetVersion: 'none',
      strategyVersions: [],
      engagements: [],
      extraction: {
        fieldsCompared: 0,
        fieldsCorrect: 0,
        accuracy: null,
        byStrategy: {},
        routedToReview: 0,
        failures: 0,
      },
      normativa: { expectedAnchors: 0, heldAnchors: 0, coverage: null, misdatedCitations: 0 },
      findings: {
        truePositives: 0,
        falsePositives: 0,
        falseNegatives: 0,
        precision: null,
        recall: null,
        f1: null,
        materialityWeightedRecall: null,
      },
      durationMs: 0,
    };
    await results.put(empty);
    expect(await results.latest()).toBeNull();
  });
});

describe('golden set integrity', () => {
  it('refuses an engagement whose manifest names a different id', async () => {
    await writeEngagement('eng-1', 'x');
    await fsp.rename(join(root, 'eng-1'), join(root, 'eng-renamed'));

    await expect(createFileGoldenSet(root).load('eng-renamed')).rejects.toThrow(IntegrityError);
  });

  it('refuses an UNSEALED engagement when asked for it BY NAME', async () => {
    await writeEngagement('eng-1', 'x', { sealed: false });
    await expect(createFileGoldenSet(root).load('eng-1')).rejects.toThrow(/not sealed/);
  });

  it('HIDES an unsealed engagement from list() and version()', async () => {
    // Regression: listing it made `version()` throw, so ONE in-progress engagement took down
    // evaluation for every finished one. Staging must never break the harness.
    await writeEngagement('sealed-1', 'retencionTotal=1');
    await writeEngagement('wip-1', 'retencionTotal=2', { sealed: false });

    const golden = createFileGoldenSet(root);
    expect(await golden.list()).toEqual(['sealed-1']);
    await expect(golden.version()).resolves.not.toBe('');
    // Staging tooling still sees it.
    expect(await golden.listAll()).toEqual(['sealed-1', 'wip-1']);
  });

  it('still evaluates the sealed engagements while one is being staged', async () => {
    await writeEngagement('sealed-1', 'retencionTotal=164368');
    await writeEngagement('wip-1', 'retencionTotal=999', { sealed: false });

    const registry = new StrategyRegistry();
    registry.register(bpstStrategy());
    const { harness } = harnessFor(registry);

    const result = await harness.run({ runId: 'run-1' });
    expect(result.engagements).toEqual(['sealed-1']);
    expect(result.extraction.accuracy).toBe(1);
  });

  it('HIDES a superseded engagement, so v1 and v2 are not double-counted', async () => {
    // Sealing is final, so a correction or extension is a NEW engagement. Without `supersededBy`
    // both would be evaluated over the SAME evidence, inflating every denominator.
    await writeEngagement('eng-1', 'retencionTotal=164368');
    await writeEngagement('eng-1-v2', 'retencionTotal=164368');
    await supersede('eng-1', 'eng-1-v2');

    const golden = createFileGoldenSet(root);
    expect(await golden.list()).toEqual(['eng-1-v2']);
    // Still on disk — it is the record of what was measured then.
    expect(await golden.listAll()).toEqual(['eng-1', 'eng-1-v2']);
  });

  it('keeps a superseded engagement loadable BY NAME, for auditing an old result', async () => {
    await writeEngagement('eng-1', 'x');
    await supersede('eng-1', 'eng-1-v2');
    await expect(createFileGoldenSet(root).load('eng-1')).resolves.toMatchObject({
      manifest: { supersededBy: 'eng-1-v2' },
    });
  });

  it('evaluates only the superseding version', async () => {
    await writeEngagement('eng-1', 'retencionTotal=1');
    await writeEngagement('eng-1-v2', 'retencionTotal=164368');
    await supersede('eng-1', 'eng-1-v2');

    const registry = new StrategyRegistry();
    registry.register(bpstStrategy());
    const { harness } = harnessFor(registry);

    const result = await harness.run({ runId: 'run-1' });
    expect(result.engagements).toEqual(['eng-1-v2']);
    expect(result.extraction.fieldsCompared).toBe(1);
  });

  it('THROWS on a malformed manifest — corruption is not a work in progress', async () => {
    await writeEngagement('eng-1', 'x');
    await fsp.writeFile(join(root, 'eng-1', 'manifest.json'), '{ not json');
    await expect(createFileGoldenSet(root).list()).rejects.toThrow(/malformed/);
  });

  it('changes its version when ground truth changes', async () => {
    await writeEngagement('eng-1', 'retencionTotal=164368');
    const before = await createFileGoldenSet(root).version();

    await writeEngagement('eng-1', 'retencionTotal=164368', { expected: 999 });
    const after = await createFileGoldenSet(root).version();

    // A metric shift caused by the SET changing must be distinguishable from a code change.
    expect(after).not.toBe(before);
  });

  it('ignores stray files beside the engagements', async () => {
    await writeEngagement('eng-1', 'x');
    await fsp.writeFile(join(root, 'README.md'), '# notes');
    expect(await createFileGoldenSet(root).list()).toEqual(['eng-1']);
  });
});
