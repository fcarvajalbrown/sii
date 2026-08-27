# ADR-027: Local read-through cache — closed periods only, bounded staleness

## Status

Accepted — 2026-07-25. The first performance-motivated decision, and the enabler the roadmap's
multi-period reporting has been waiting on. Extends ADR-024's on-disk state rather than adding a
second mechanism, per that ADR's own instruction. Builds on ADR-003 (`KeyValueStore` seam),
ADR-012 (tasks return plain JSON) and ADR-025 (the directory is ACL-hardened on Windows).

## Context

Every read re-fetches. `withSession` restores a cookie jar into a **fresh Chromium**, works, and
tears it down — so cost is dominated by the browser, not the POST. Consequences today:

- A twelve-month trend means twelve browser launches, so nobody runs one. The analysis features
  the roadmap wants are technically available and practically unusable.
- `honorariosAnual` is ~26 POSTs plus BHE pagination — the heaviest read in the repo (ADR-023),
  and re-running it to look at one more month repeats all of it.
- Re-reading closed periods puts avoidable load on SII, against ADR-004's posture.

Two facts make this more than a standard cache.

**1. Tax data is not reliably immutable, even for a closed period.** The tempting rule
"a past month never changes" is false: documents can be registered late into the RCV, and an F22
can be superseded by a rectificatoria years later — this taxpayer's own AT2019 sat with an open
observación for seven years, precisely the window in which something could change. A cache that
treats closed as permanent will eventually serve a confidently wrong figure, which is worse than
being slow.

**2. Caching results writes counterparty PII to disk.** ADR-024 went out of its way to keep SII
free text *out* of `monitor.json`, storing only fingerprints. A result cache is the opposite: it
stores whole task payloads, and `RcvDetalleDoc` still carries `raw` — the complete ~50-field row
including counterparty identity (finding F-03, still open). This ADR cannot pretend that is
neutral.

## Decision

Add a read-through cache over the existing `KeyValueStore`, with these rules.

- **The current and future periods are NEVER cached — not even briefly.** An open month's F29 or
  an unfiled F22 is live data by definition. The caller declares the period's `scope`, and the
  helper compares it against the injected `Clock`; anything not strictly in the past is fetched
  and **not written**. This is the invariant that keeps the cache from lying about the present.
- **Closed periods get a bounded TTL, not permanence** — 30 days by default. That is the honest
  encoding of Context 1: long enough to make repeated analysis cheap, short enough that a late
  document or rectificatoria surfaces within a billing cycle. "Immutable forever" is rejected.
- **`--refresh` / `refresh: true` bypasses AND repopulates**, so there is always a one-flag way
  to get ground truth. Every cached surface exposes it.
- **Entries carry a schema `version` stamp.** A curated shape changing (a new alias, a new
  código) invalidates old entries automatically rather than silently mixing shapes.
- **Opt-in per task, not automatic.** A task author must pass a `CacheSpec`; nothing is cached by
  reflex. This increment opts in the three composites (`iva`, `renta`, `honorarios`) because they
  are the expensive ones and the motivation. Single-surface reads stay uncached for now.
- **One map under the `cache` key**, not a file per entry: it keeps `sii cache` (inspect/clear)
  possible without adding directory enumeration to the `KeyValueStore` seam. Bounded to 200
  entries, evicting oldest-fetched first. Accepted limitation: a whole-file rewrite per write and
  no cross-process locking — fine for a single-user CLI, and stated so nobody assumes otherwise.
- **`sii cache` / `sii cache --clear`** ships with it. A cache you cannot inspect or purge is a
  liability, and after an amended declaration the user needs a way to drop everything.
- **PII posture, explicit:** cached payloads are the taxpayer's own tax data, in a directory now
  ACL-restricted on Windows (ADR-025) and `0700` on POSIX. That is the same trust level as the
  session jar already there. It is nonetheless a **larger** on-disk footprint than before, and it
  makes finding **F-03** (RCV `raw` shipped by default) materially more urgent: caching turns a
  transient over-exposure into a persistent one. F-03 should land next.
- **The audit records cache hits** (`cached: true`) so the receipt never implies SII was consulted
  when it was not. Misreporting that would undermine the log's whole purpose.

## Alternatives Considered

- **Cache per-POST inside the facades.** Rejected: the dominant cost is the browser, and a
  facade-level cache still opens a session to serve a fully-cached read. Caching the task RESULT
  means a warm `honorarios` opens no browser at all.
- **Treat closed periods as permanently immutable.** Rejected — see Context 1. This is the
  seductive wrong answer, and its failure mode is a stale figure presented with confidence.
- **A dedicated `Cache` seam.** Rejected as premature: `KeyValueStore` already abstracts local
  persistence and the fakes already substitute it, so a new seam would add a boundary without
  adding capability.
- **One `KeyValueStore` key per entry.** Cleaner writes and natural per-entry atomicity, but
  `sii cache --clear` and any listing would need directory enumeration added to the seam. Revisit
  if entry volume ever justifies it.
- **Cache the F22 aggressively** (it is the slowest per-year read). Rejected at this TTL: an F22
  is the single most rectification-prone surface, and `monitor` exists to notice exactly those
  changes. It is cached under the same 30-day bound as everything else, no special case.
- **Cache `monitor` itself.** Rejected outright — a compliance sweep whose job is detecting change
  must always read live. `monitorSweep` calls facades directly and is deliberately left uncached.

## Consequences

- Multi-period analysis becomes practical: a warm twelve-month series costs no browser launches.
  This unblocks the trend/rollup features the roadmap lists.
- Load on SII drops for repeated work, consistent with ADR-004.
- **Staleness is now possible, bounded at 30 days**, and every result says whether it came from
  cache. Users doing something consequential (filing, responding to SII) should pass `--refresh`;
  the CLI help says so.
- `~/.sii/cache.json` is a new, larger on-disk artifact holding tax payloads. It raises the value
  of the F-03 fix and of the eventual keyring migration.
- `monitor` and the cache are deliberately independent: the sweep always reads live, so enabling
  the cache cannot blind the early-warning system.
