import { describe, it, expect } from 'vitest';
import { FixedClock, InMemoryKeyValueStore, RecordingAuditSink } from '../adapters/fake/index.js';
import type { Runtime } from '../seams/index.js';
import { FakePortalDriver } from '../adapters/fake/index.js';
import { cachedRead, clearCache, readCacheStats } from './cache.js';

function makeRuntime(now = '2026-07-25T12:00:00Z'): Runtime {
  return {
    clock: new FixedClock(new Date(now)),
    audit: new RecordingAuditSink(),
    store: new InMemoryKeyValueStore(),
    portal: new FakePortalDriver(),
  };
}

const KEY = { task: 'iva', rut: '20000042-0', scope: '202603' } as const;

describe('cachedRead (ADR-027)', () => {
  it('misses, fetches, stores — then hits without fetching again', async () => {
    const rt = makeRuntime();
    let calls = 0;
    const fetch = async (): Promise<{ n: number }> => {
      calls++;
      return { n: calls };
    };

    const first = await cachedRead(rt, KEY, { closed: true }, fetch);
    expect(first).toEqual({ value: { n: 1 }, fromCache: false });

    const second = await cachedRead(rt, KEY, { closed: true }, fetch);
    expect(second).toEqual({ value: { n: 1 }, fromCache: true });
    expect(calls).toBe(1); // SII was consulted exactly once
  });

  // The invariant that keeps the cache from lying about the present (ADR-027).
  it('NEVER caches an open period — not even for a moment', async () => {
    const rt = makeRuntime();
    let calls = 0;
    const fetch = async (): Promise<number> => ++calls;

    const a = await cachedRead(rt, KEY, { closed: false }, fetch);
    const b = await cachedRead(rt, KEY, { closed: false }, fetch);

    expect(a.fromCache).toBe(false);
    expect(b.fromCache).toBe(false);
    expect(calls).toBe(2);
    // Nothing was written, so a later "closed" read cannot pick up open-period data.
    expect((await readCacheStats(rt.store)).entries).toBe(0);
  });

  it('refresh bypasses a warm entry AND repopulates it', async () => {
    const rt = makeRuntime();
    let calls = 0;
    const fetch = async (): Promise<number> => ++calls;

    await cachedRead(rt, KEY, { closed: true }, fetch); // warm: 1
    const forced = await cachedRead(rt, KEY, { closed: true, refresh: true }, fetch);
    expect(forced).toEqual({ value: 2, fromCache: false });

    // The refreshed value is what a subsequent hit returns.
    const after = await cachedRead(rt, KEY, { closed: true }, fetch);
    expect(after).toEqual({ value: 2, fromCache: true });
    expect(calls).toBe(2);
  });

  it('expires after the TTL — closed is bounded, not permanent', async () => {
    const rt = makeRuntime();
    let calls = 0;
    const fetch = async (): Promise<number> => ++calls;

    await cachedRead(rt, KEY, { closed: true }, fetch);

    (rt.clock as FixedClock).set(new Date('2026-08-20T12:00:00Z')); // +26 days — still fresh
    expect((await cachedRead(rt, KEY, { closed: true }, fetch)).fromCache).toBe(true);

    (rt.clock as FixedClock).set(new Date('2026-09-01T12:00:00Z')); // +38 days — past 30d TTL
    const stale = await cachedRead(rt, KEY, { closed: true }, fetch);
    expect(stale.fromCache).toBe(false);
    expect(stale.value).toBe(2);
  });

  it('isolates entries by task, rut AND scope — no cross-contamination', async () => {
    const rt = makeRuntime();
    const fetch = (tag: string) => async (): Promise<string> => tag;

    await cachedRead(rt, KEY, { closed: true }, fetch('iva-marzo'));
    const otherScope = await cachedRead(
      rt,
      { ...KEY, scope: '202604' },
      { closed: true },
      fetch('iva-abril'),
    );
    const otherRut = await cachedRead(
      rt,
      { ...KEY, rut: '77777777-7' },
      { closed: true },
      fetch('otro-rut'),
    );
    const otherTask = await cachedRead(
      rt,
      { ...KEY, task: 'renta' },
      { closed: true },
      fetch('renta'),
    );

    expect(otherScope.value).toBe('iva-abril');
    expect(otherRut.value).toBe('otro-rut');
    expect(otherTask.value).toBe('renta');
    expect((await readCacheStats(rt.store)).entries).toBe(4);
  });

  it('invalidates entries written under a different schema version', async () => {
    const rt = makeRuntime();
    let calls = 0;
    const fetch = async (): Promise<number> => ++calls;

    await cachedRead(rt, KEY, { closed: true, version: 1 }, fetch);
    // A curated shape changed → the old entry must not be served.
    const afterBump = await cachedRead(rt, KEY, { closed: true, version: 2 }, fetch);

    expect(afterBump.fromCache).toBe(false);
    expect(afterBump.value).toBe(2);
  });

  it('does not cache a failed fetch — an error must never become a stored result', async () => {
    const rt = makeRuntime();
    const boom = async (): Promise<number> => {
      throw new Error('SII rechazó la consulta');
    };

    await expect(cachedRead(rt, KEY, { closed: true }, boom)).rejects.toThrow('SII rechazó');
    expect((await readCacheStats(rt.store)).entries).toBe(0);
  });

  it('clearCache empties everything and reports how much it dropped', async () => {
    const rt = makeRuntime();
    await cachedRead(rt, KEY, { closed: true }, async () => 1);
    await cachedRead(rt, { ...KEY, scope: '202604' }, { closed: true }, async () => 2);

    const dropped = await clearCache(rt.store);

    expect(dropped).toBe(2);
    expect((await readCacheStats(rt.store)).entries).toBe(0);
  });

  it('bounds the cache, evicting the oldest-fetched entry first', async () => {
    const rt = makeRuntime();
    // Write more than the cap, advancing the clock so insertion order is unambiguous.
    for (let i = 0; i < 205; i++) {
      (rt.clock as FixedClock).set(new Date(Date.UTC(2026, 0, 1, 0, i)));
      await cachedRead(
        rt,
        { ...KEY, scope: `2026${String(i).padStart(4, '0')}` },
        { closed: true },
        async () => i,
      );
    }

    const stats = await readCacheStats(rt.store);
    expect(stats.entries).toBeLessThanOrEqual(200);
    // The very first scope is gone; a recent one survives.
    expect(stats.scopes).not.toContain('20260000');
    expect(stats.scopes).toContain('20260204');
  });
});
