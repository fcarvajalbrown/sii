# ADR-030: Estado de Declaraciones Juradas (`dj status`) — the first read of the DJ system

## Status

Accepted — 2026-08-03. New read facade, first observation of this SII product in this codebase.
Foundational for future DJ-content spikes (e.g. DJ 1926 — Balance Tributario 8 columnas, DJ
1948 — retiros/remesas/dividendos) proposed in `docs/NEXT-SPIKES-PLAN.md`.

## Context

The project has NO visibility into Declaraciones Juradas (DJ) at all — `docs/ROADMAP.md` lists
`sii dj` as `📋` planned, blocked on a spike. This is a real, load-bearing gap: DJ 1926/1943-family
forms carry the taxpayer's balance and estado de resultados tributario, and a missing or observed
DJ is exactly the kind of finding an audit like the one run for Empresa A SpA
(a real taxpayer account) needs to catch — the same way `f22 status`/`f29 overview` already catch missing
renta/IVA declarations.

A live, read-only spike (same RUT, real session) found the real endpoint: **NOT** the SDI-JSON
family (`www4.sii.cl/facadeAdapterService/...`) despite F22/F29/RCV all living there — this is a
sixth, distinct wire shape: a plain REST JSON API on `www2.sii.cl/app/djconsulta/<rut>/recurso/v1/dj/`,
with the subject RUT embedded directly in the URL path. Full contract:
`docs/sii-contract/dj-status.md`.

Three traps, all load-bearing and encoded here:

1. **The request body's `periodo` field MUST be a JSON string** (`{"periodo": "2026"}`), not a
   number. Every other shape tried (bare number, array, `anio`/`periodoAnual` keys) returned a
   generic "formato del cuerpo" error. Silent and easy to get wrong.
2. **`periodo` is the END of a rolling 3-year window**, not a single-año filter — sending `"2026"`
   returns 2024/2025/2026 combined; sending `"2025"` returns 2023/2024/2025 (one year of overlap).
   A `periodo` below the observed floor (2022 worked; 2021 failed) returns an ERROR envelope
   (`data: null`, `errorMsg` set) — the ONLY facade in this codebase where "out of range" is an
   error rather than a clean empty result. A multi-year sweep (`dj status --years N`) MUST
   de-duplicate overlapping years across calls and MUST treat the "out of range" error as a soft
   stop (no more history available), not a hard failure to propagate.

## Decision

1. **New facade `portal/dj.ts`**, `fetchDjEstado(session, {rut, periodo})` — one POST per call,
   returns the curated row list verbatim (no PII to curate, see the wire doc). `periodo` is an
   `Anio` (año tributario), sent as `String(periodo.canonical)` per the trap above.
2. **New task `tasks/dj.ts`**, `djStatus(runtime, {years})` — mirrors `f22Status`'s
   `--years N` shape: fans out `ceil(N / 3)` calls (`periodo = currentYear, currentYear - 3,
   currentYear - 6, …`) since each call already covers 3 years, merging rows by `dj` number and
   de-duplicating overlapping años (last-call-wins is fine — the data is the same underlying
   truth, not a moving target). Paced via `Clock.sleep` between calls, same as every other
   fan-out in this codebase (ADR-004).
3. **The out-of-range error is a SOFT STOP, not a propagated failure.** When a call for the
   OLDEST `periodo` in the requested window returns `errorMsg: "Se ha generado un error en
   getDjIntegralAnual"` with `data: null`, the task stops sweeping further back and returns
   whatever years it already collected, flagging in the result how far back real data actually
   reached (mirrors `monitor.ts`'s anchor-on-earliest-evidence convention, ADR-024/CONVENTIONS —
   never assert an omission for a window the taxpayer's history doesn't cover). A call for a
   MIDDLE `periodo` returning that same error is NOT assumed benign — it propagates as `DjError`
   (ADR-004: only the specific, understood shape of "ran off the front of history" is treated as
   soft; an unexplained mid-range failure is surfaced, never silently swallowed).
4. **A direct POST to `getDjIntegralAnual` fails with a bare HTTP 401** — confirmed live, TWICE
   (the first production run against the real taxpayer failed this exact way before the fix
   landed, even with a fresh session and a correct Referer). The `www2.sii.cl` djconsulta SPA does
   an async session bootstrap on load that the REST API depends on; `fetchDjEstadoAnual` must
   `goto` the UI page (`www2.sii.cl/djconsulta/consultaddjjs`) and `pace()` BEFORE the POST. 0ms
   wait fails every time; 500ms succeeds consistently — the facade paces at the project standard
   (1000ms) for margin. Full detail: `docs/sii-contract/dj-status.md`.
5. **Session-keyed, self only, for now.** The RUT-in-path reach for a represented empresa was NOT
   confirmed live (no operable represented RUT available in the test session) — the task reads
   `ctx.sessionRut` only and does NOT accept `--rut`, exactly like F22/F29/BTE/BPST. Revisit once a
   live spike with a representing persona + represented empresa confirms (or refutes) body-RUT
   reach — flagged as an open item in the wire doc, not assumed either way.
5. **No PII curation trade-off.** Every field (`dj`, `titulo`, `estados`, `id`) is either the
   taxpayer's own metadata or an opaque internal id — no denylist, no `raw` needed (unlike
   F22/BTE/BPST). The full row is the curated shape.
6. **`estados` values pass through verbatim, no closed enum.** Only `"Aceptada"`/`"Observada"`
   observed live; a third value must not be silently coerced or dropped (ADR-004).

## Alternatives Considered

1. **Guess the endpoint from the SDI-JSON pattern (`www4.sii.cl/djXxxUi/services/...`).**
   Rejected — the live spike found the real thing is a completely different, simpler REST API on
   `www2.sii.cl`; guessing would have produced a confidently-wrong facade against a URL that
   either 404s or (worse) silently returns something unrelated.
2. **Treat any `errorMsg` as a clean "no data".** Rejected — conflates a genuine out-of-range
   boundary with an unexplained SII-side failure; the former is expected and informative (anchor
   point for how far back this taxpayer's DJ history goes), the latter must surface loudly.
3. **Accept `--rut` optimistically, assuming RCV-style body-RUT reach.** Rejected — would be
   asserting a capability never observed live (ADR-004). Self-only until confirmed.

## Consequences

- Unblocks the two highest-value follow-up spikes in `docs/NEXT-SPIKES-PLAN.md` (DJ 1926 balance,
  DJ 1948 retiros/dividendos) — both need a folio/id from this endpoint before their own content
  can be read.
- A future audit report gains a genuine "missing/observed DJ" finding category, parallel to the
  existing F22/F29 "sin declaración" findings — but ONLY once `monitor.ts` (or the report-writing
  process) is extended to read it; this ADR ships the raw read surface, not the audit judgment
  layer (same split already established for F22/F29 vs. `monitor`).
- **Open follow-up:** confirm or refute represented-empresa reach via the RUT-in-path with a live
  spike once an operable represented RUT is available in a test session.
