# ADR-028: RCV `raw` becomes opt-in — the last surface shipping uncurated rows

## Status

Accepted — 2026-07-25. Closes finding **F-03** of the internal code review. Narrows the
curated+`raw` posture ADR-004 established, for RCV specifically. Related: ADR-027 (a cached
payload persists whatever it holds) and ADR-026 (what reaches an LLM context is an attack
surface, not just a privacy question).

## Context

`RcvDetalleDoc` carries `raw: Record<string, unknown>` — the complete SDI row, roughly fifty
fields — alongside eleven curated ones. It is populated unconditionally in `portal/rcv.ts` and
flows out through `rcv_list` and `rcv_all`.

**RCV is now the only surface that does this.** Every other rich payload dropped `raw` after
looking at what was actually in it:

- **F22** — uncurated fields are pure identity/bank PII, every tax código is curated → no `raw`.
- **BTE/BHE** — a row mixes counterparty data with the taxpayer's OWN identity on both sides and
  the own-identity field set is not provably enumerable (live BUG-1) → no `raw`.
- **F29** — identity PII sits in a separate `listCodBase` array that is simply never read.
- **peticiones** — PII-dense on every side → no `raw`, tight allowlist.

CONVENTIONS already draws the conclusion: *"Prefer dropping `raw` over a denylist whenever the
own-PII field set can't be proven complete."* RCV was left as the template that predates that
rule rather than an exception justified by it.

Two things make it worth fixing now rather than later.

**1. `rcv_all` multiplies it.** The fan-out returns every document of every DTE type in a period,
each with fifty uncurated fields. For a working farm that is hundreds of rows of third-party
identity data entering an LLM context in a single call — a privacy exposure and a substantial
token cost at once.

**2. `raw` is an injection carrier, not just data.** ADR-026 established that untrusted
counterparty text reaching the context window is the input half of a prompt-injection chain. A
curated projection exposes eleven known fields; `raw` exposes every field SII sends, including any
free-text one we have never looked at. Shrinking that to eleven named fields is a real reduction
in attackable surface, independent of the privacy argument.

**Why the obvious alternative is unavailable:** the clean fix would be promoting the tax-special
fields into the curated shape so `raw` could disappear entirely, as F22 did. But
`docs/sii-contract/rcv.md` states plainly that those fields — activo fijo, IVA uso común, Ley
18211, tabaco, vehículos — are **not curated and their wire names are not observed**. Under
ADR-004 we do not get to guess field names. So they must stay reachable somehow.

## Decision

**`raw` becomes opt-in and defaults to OFF on every surface.**

- `RcvDetalleDoc.raw` is now **optional**, present only when the caller asked. The curated eleven
  fields are unchanged, so no existing consumer of curated data is affected.
- `fetchRcvDetalle` takes `raw?: boolean`; `rcvList` / `rcvListAll` take `raw?: boolean`,
  defaulting to `false`.
- **CLI:** `sii rcv list --raw` / `sii rcv all --raw`. A human asking for it in a terminal is the
  case `raw` exists to serve.
- **MCP:** `rcv_list` / `rcv_all` accept `raw`, default false, and the tool **description declares
  the exposure** — the pattern `whoami` and `peticiones_list` already use, so a model is told what
  it is asking for rather than discovering it. Capability is preserved; the default is safe.
- **The audit records whether `raw` was surfaced** (`raw: true|false`). Surfacing the wide payload
  is a privacy-relevant act, and the receipt should show when it happened. The values are never
  logged — only the fact.
- **`docs/sii-contract/rcv.md` is corrected** so the sentence "they remain in `raw`" no longer
  implies `raw` is always there.

## Alternatives Considered

- **Drop `raw` outright, matching F22/BTE/peticiones.** The most consistent option, and rejected
  only because the tax-special fields have no observed names to promote: removing `raw` would make
  activo fijo / IVA uso común / Ley 18211 permanently unreachable, breaking real edge cases for
  taxpayers who have them. Opt-in keeps them reachable while making the safe path the default.
  **If those field names are ever captured live, dropping `raw` becomes the correct follow-up.**
- **Denylist known-PII fields inside `raw`.** Rejected by CONVENTIONS and by the BTE precedent:
  the field set is not provably enumerable, so a denylist would be silently incomplete — the exact
  failure mode that leaked a RUT through F22's `9306`/`9920`/`8809` before that set was completed.
- **Keep `raw` on by default and only gate it on MCP.** Rejected: the CLI's JSON output is
  routinely piped into files and other tools, so "on by default" persists the same data by another
  route. One default, safe everywhere, is easier to reason about than a per-surface split.
- **Truncate `raw` to the first N fields.** Rejected as incoherent — it neither guarantees privacy
  nor guarantees the tax-special field you needed is present.

## Consequences

- **Breaking for anyone reading `doc.raw` without asking for it:** the field is now absent unless
  `raw: true` / `--raw`. Deliberate, and the failure mode is a missing field rather than silently
  wrong data. Correct for 0.x.
- Default `rcv_all` payloads shrink dramatically, which cuts both PII exposure and token cost.
- RCV joins the rest of the codebase's posture: curated by default, wide only on request.
- The prospective concern raised in ADR-027 is defused rather than realised: if an RCV detalle read
  is ever opted into the cache, the default entry holds curated fields only.
- **Not addressed here:** `razonSocial` remains curated and present. Counterparty identity is
  intrinsic to a purchase ledger — you cannot reconcile suppliers without knowing who they are.
  This ADR removes the *uncurated bulk*, not the ledger's purpose.
