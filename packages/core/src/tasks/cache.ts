// Local read-through cache (ADR-027). The dominant cost of a read is not the POST — it is
// `withSession` restoring a cookie jar into a FRESH Chromium and tearing it down. So this caches
// the TASK RESULT: a warm read opens no browser at all, which is what makes multi-period analysis
// practical (a twelve-month series was twelve browser launches).
//
// TWO RULES CARRY THE CORRECTNESS:
//
// 1. The CURRENT and FUTURE periods are never cached, not even briefly. An open month's F29 or an
//    unfiled F22 is live data. The caller declares `closed`; when false we fetch and write
//    NOTHING, so open-period data can never later be served as if it were settled.
//
// 2. "Closed" is NOT "immutable". Documents get registered late into the RCV and an F22 can be
//    superseded by a rectificatoria years later. So closed entries carry a bounded TTL rather
//    than living forever — the honest encoding of a domain where the past can still move.
//
// PII: entries hold whole task payloads, which for RCV still includes `raw` (counterparty
// identity — finding F-03). That is the taxpayer's own data in a directory ACL-restricted on
// Windows (ADR-025) and 0700 on POSIX, but it is a LARGER on-disk footprint than before and it
// makes fixing F-03 more urgent, not less.
import type { Clock, KeyValueStore, Runtime } from '../seams/index.js';

/** Distinct KeyValueStore key (ADR-007) — never shares a file with session/operate/monitor. */
const CACHE_KEY = 'cache';

/** Closed periods are cheap to re-read once a month; this bounds how stale a figure can be. */
const TTL_MS = 30 * 24 * 60 * 60_000;

/** Cap so repeated analysis cannot grow the file without bound. Oldest-fetched evicted first. */
const MAX_ENTRIES = 200;

/** Identifies one cached read. `scope` is the canonical period/year the entry covers
 *  (`202603`, `2025`), which is also what makes eviction and `sii cache` legible. */
export interface CacheKey {
  readonly task: string;
  readonly rut: string;
  readonly scope: string;
}

export interface CacheOptions {
  /** Is the period this read covers strictly in the PAST? Only then may it be stored. */
  readonly closed: boolean;
  /** Bypass a warm entry and repopulate it. Always available, per ADR-027. */
  readonly refresh?: boolean;
  /** Curated-shape version. Bump when a projection changes so old entries self-invalidate. */
  readonly version?: number;
}

interface CacheEntry {
  readonly version: number;
  readonly fetchedAt: number;
  readonly scope: string;
  readonly value: unknown;
}

type CacheFile = Record<string, CacheEntry>;

const entryKey = (k: CacheKey): string => `${k.task}|${k.rut}|${k.scope}`;

const readFile = async (store: KeyValueStore): Promise<CacheFile> =>
  (await store.read<CacheFile>(CACHE_KEY)) ?? {};

/** Drop expired entries, then the oldest-fetched until we are under the cap. */
function prune(file: CacheFile, now: number): CacheFile {
  const live = Object.entries(file).filter(([, e]) => now - e.fetchedAt < TTL_MS);
  live.sort((a, b) => a[1].fetchedAt - b[1].fetchedAt); // oldest first
  const keep = live.slice(Math.max(0, live.length - (MAX_ENTRIES - 1)));
  return Object.fromEntries(keep);
}

/** Read through the cache. Returns the value plus whether it came from disk, so a caller can
 *  report honestly (the audit records `cached` — a receipt must never imply SII was consulted
 *  when it was not). A FAILED fetch is never stored. */
export async function cachedRead<T>(
  runtime: Runtime,
  key: CacheKey,
  options: CacheOptions,
  fetch: () => Promise<T>,
): Promise<{ value: T; fromCache: boolean }> {
  const version = options.version ?? 1;
  // An open period is fetched live and never written — rule 1, checked before anything else.
  if (!options.closed) return { value: await fetch(), fromCache: false };

  const now = runtime.clock.now().getTime();
  const file = await readFile(runtime.store);
  const hit = file[entryKey(key)];

  if (
    !options.refresh &&
    hit !== undefined &&
    hit.version === version &&
    now - hit.fetchedAt < TTL_MS
  ) {
    return { value: hit.value as T, fromCache: true };
  }

  // Fetch OUTSIDE any write, so a rejection propagates with nothing persisted.
  const value = await fetch();
  const pruned = prune(file, now);
  pruned[entryKey(key)] = { version, fetchedAt: now, scope: key.scope, value };
  await runtime.store.write(CACHE_KEY, pruned);
  return { value, fromCache: false };
}

export interface CacheStats {
  readonly entries: number;
  /** Distinct scopes held, for `sii cache` output and for tests. */
  readonly scopes: readonly string[];
  /** ISO timestamp of the oldest entry, or null when empty. */
  readonly oldest: string | null;
}

export async function readCacheStats(store: KeyValueStore): Promise<CacheStats> {
  const file = await readFile(store);
  const all = Object.values(file);
  const oldest = all.reduce<number | null>(
    (min, e) => (min === null || e.fetchedAt < min ? e.fetchedAt : min),
    null,
  );
  return {
    entries: all.length,
    scopes: all.map((e) => e.scope),
    oldest: oldest === null ? null : new Date(oldest).toISOString(),
  };
}

/** Drop every entry; returns how many were removed. The escape hatch after an amended
 *  declaration, when even a 30-day TTL is too long to wait. */
export async function clearCache(store: KeyValueStore): Promise<number> {
  const file = await readFile(store);
  const n = Object.keys(file).length;
  if (n > 0) await store.write(CACHE_KEY, {});
  return n;
}

/** Is `scope` a period strictly BEFORE the clock's current month? The helper behind rule 1.
 *  `scope` is `YYYYMM` (month) or `YYYY` (year); a year is closed once the calendar year is past. */
export function scopeIsClosed(scope: string, clock: Clock): boolean {
  const now = clock.now();
  if (/^\d{6}$/.test(scope)) {
    const year = Number(scope.slice(0, 4));
    const month = Number(scope.slice(4));
    return year < now.getFullYear() || (year === now.getFullYear() && month < now.getMonth() + 1);
  }
  if (/^\d{4}$/.test(scope)) return Number(scope) < now.getFullYear();
  return false; // unrecognised scope ⇒ treat as open (never cache what we cannot date)
}
