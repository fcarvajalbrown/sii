import { describe, it, expect } from 'vitest';
import { testing, type Runtime } from '@dostertags/sii-core';
import { run, runJson } from '../test-helpers.js';

// `sii cache` is purely local: no session, no SII. It must work with an empty runtime.
function makeRuntime(): Runtime {
  return {
    clock: new testing.FixedClock(new Date('2026-07-25T12:00:00Z')),
    audit: new testing.RecordingAuditSink(),
    store: new testing.InMemoryKeyValueStore(),
    portal: new testing.FakePortalDriver(),
  };
}

/** A cache file as the core writes it (ADR-027 shape). */
const seedCache = async (rt: Runtime): Promise<void> => {
  await rt.store.write('cache', {
    'iva|20000042-0|202603': {
      version: 1,
      fetchedAt: Date.parse('2026-07-01T00:00:00Z'),
      scope: '202603',
      value: { ok: true },
    },
    'renta|20000042-0|2024': {
      version: 1,
      fetchedAt: Date.parse('2026-07-10T00:00:00Z'),
      scope: '2024',
      value: { ok: true },
    },
  });
};

describe('sii cache command (fake runtime, no SII)', () => {
  it('reports an empty cache without needing a session', async () => {
    const rt = makeRuntime(); // no login at all
    const out = await run(rt, 'cache', '--human');

    expect(out).toContain('0 entrada');
    expect(out).toContain('Vacío');
  });

  it('lists the periods held and the oldest entry', async () => {
    const rt = makeRuntime();
    await seedCache(rt);

    const out = await run(rt, 'cache', '--human');

    expect(out).toContain('2 entrada');
    expect(out).toContain('202603');
    expect(out).toContain('2024');
    expect(out).toContain('2026-07-01'); // oldest
  });

  it('--clear empties it and reports how many were dropped', async () => {
    const rt = makeRuntime();
    await seedCache(rt);

    const out = await run(rt, 'cache', '--clear', '--human');
    expect(out).toContain('2 entrada');

    // Really gone.
    const after = (await runJson(makeRuntimeWith(rt), 'cache')) as { entries: number };
    expect(after.entries).toBe(0);
  });

  it('emits stats as JSON by default (ADR-012)', async () => {
    const rt = makeRuntime();
    await seedCache(rt);

    const json = (await runJson(rt, 'cache')) as { entries: number; scopes: string[] };

    expect(json.entries).toBe(2);
    expect(json.scopes).toContain('202603');
  });
});

/** Reuse a runtime's store so a second `run` sees the first command's writes. */
function makeRuntimeWith(source: Runtime): Runtime {
  return { ...makeRuntime(), store: source.store };
}
