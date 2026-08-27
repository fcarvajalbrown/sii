// The loop binary's argument surface (ADR-044).
//
// `parseArgs`, `stagesFor` and `resolveConfig` are pure precisely so the run MODES can be pinned
// without spawning a process or touching SII — which matters most for `learn`, whose entire
// contract is "never reaches SII".

import { describe, expect, it } from 'vitest';
import { FETCH_STAGES, LEARN_STAGES } from './orchestrator.js';
import { needsSession, parseArgs, resolveConfig, sealedPortal, stagesFor } from './cli.js';
import { STAGES } from './manifest.js';

describe('parseArgs', () => {
  it('recognises the three run modes', () => {
    expect(parseArgs(['run']).command).toBe('run');
    expect(parseArgs(['fetch']).command).toBe('fetch');
    expect(parseArgs(['learn']).command).toBe('learn');
  });

  it('falls back to help for an unknown command', () => {
    expect(parseArgs(['sweep']).command).toBe('help');
    expect(parseArgs([]).command).toBe('help');
  });

  it('carries the shared flags into every mode', () => {
    expect(parseArgs(['learn', '--dry-run']).config.dryRun).toBe(true);
    expect(parseArgs(['fetch', '--seed', '7']).config.seed).toBe(7);
  });
});

describe('normativa subcommand', () => {
  it('is recognised, with its subcommand and argument in the two positionals', () => {
    const p = parseArgs(['normativa', 'load', 'chunks.json']);
    expect(p.command).toBe('normativa');
    expect(p.runId).toBe('load');
    expect(p.stage).toBe('chunks.json');
  });

  it('accepts `normativa list` with no argument', () => {
    const p = parseArgs(['normativa', 'list']);
    expect(p.command).toBe('normativa');
    expect(p.runId).toBe('list');
    expect(p.stage).toBeUndefined();
  });

  it('never selects stages — loading a corpus is not a run mode', () => {
    expect(stagesFor('normativa')).toBeUndefined();
  });
});

describe('stagesFor', () => {
  it('selects ONLY ingest for fetch — the one stage needing a live session', () => {
    expect(stagesFor('fetch')).toEqual(FETCH_STAGES);
    expect(stagesFor('fetch')).toEqual(['ingest']);
  });

  it('selects stages 2–8 for learn, and never ingest', () => {
    expect(stagesFor('learn')).toEqual(LEARN_STAGES);
    expect(stagesFor('learn')).not.toContain('ingest');
  });

  it('puts extract on the LEARN side — it parses stored artifacts, not SII (ADR-044)', () => {
    // The corrected boundary. An earlier reading cut at 1–2 / 3–8; leaving `extract` on the
    // session side would tie re-parsing with a new strategy to somebody logging in, which is
    // exactly the operation most worth repeating cold.
    expect(stagesFor('learn')).toContain('extract');
  });

  it('together the two modes cover every stage exactly once', () => {
    const union = [...stagesFor('fetch'), ...stagesFor('learn')];
    expect([...union].sort()).toEqual([...STAGES].sort());
    expect(new Set(union).size).toBe(STAGES.length);
  });

  it('leaves `run` unselected, so all eight execute', () => {
    expect(stagesFor('run')).toBeUndefined();
  });
});

describe('resolveConfig', () => {
  it('records the selection so the orchestrator can skip what was not chosen', () => {
    expect(resolveConfig({ stages: LEARN_STAGES }).stages).toEqual(LEARN_STAGES);
  });

  it('leaves stages undefined by default — `run` behaviour is unchanged', () => {
    expect(resolveConfig({}).stages).toBeUndefined();
  });
});

describe('needsSession', () => {
  it('is true only when ingest is selected', () => {
    expect(needsSession(resolveConfig({ stages: FETCH_STAGES }))).toBe(true);
    expect(needsSession(resolveConfig({ stages: LEARN_STAGES }))).toBe(false);
    // No selection means all eight, ingest included.
    expect(needsSession(resolveConfig({}))).toBe(true);
  });
});

describe('sealedPortal', () => {
  it('makes a learn run UNABLE to reach SII, not merely unlikely to', async () => {
    // ADR-044's guarantee is worth enforcing at the seam rather than trusting stage selection:
    // if a future stage acquires a session it must fail loudly here, not quietly fetch.
    const portal = sealedPortal();

    await expect(portal.restore({} as never)).rejects.toThrow(/learn/i);
    await expect(portal.interactiveLogin({} as never)).rejects.toThrow(/learn/i);
    await expect(portal.credentialLogin({} as never)).rejects.toThrow(/learn/i);
    await expect(portal.requestPublic({} as never)).rejects.toThrow(/learn/i);
  });
});
