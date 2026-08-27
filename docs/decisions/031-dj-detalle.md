# ADR-031: DJ content — presentation history + the actual balance/RLI figures (DJ 1926)

## Status

Accepted — 2026-08-03. Extends ADR-030 (Estado de Declaraciones Juradas) with the CONTENT layer:
two more endpoints in the same `www2.sii.cl/app/djconsulta/` family. Closes
`docs/NEXT-SPIKES-PLAN.md` candidates 2 and 3 (DJ 1943 RLI + DJ 1926 balance 8 columnas) with ONE
facade — this taxpayer's real DJ list has no 1943 at all; **DJ 1926 alone carries both the RLI
breakdown and the balance** (its own SII title: "Sobre Base imponible de primera categoría y
datos contables balance").

## Context

`dj status` (ADR-030) tells us WHICH DJ exist and whether each año is Aceptada/Observada — it does
not expose what a DJ actually SAYS. For DJ 1926 that content is the taxpayer's Renta Líquida
Imponible breakdown and balance figures — exactly the "balance y EERR tributario" this project's
owner asked for by name.

A live, read-only spike (same session, same RUT) found the two missing pieces by reading the
`www2.sii.cl` djconsulta SPA's own JS bundle (a public static asset — `grep`-ing it for
`recurso/v1/` string literals is safe and non-interactive) and then confirming the real request
shapes by patching `window.fetch`/`XMLHttpRequest` via `session.evaluate` and clicking the actual
"DJ 1926 → Aceptada" link in the live UI:

1. **`getDjIntegralAnualDetalle`** — presentation history per DJ for one año (folio, fecha,
   estado, `tipoDeclaracion`, and critically the `key` needed by endpoint 2). Live-observed a REAL
   rectificatoria for this taxpayer's own DJ 1926 AT2025 (original folio 599626 anulada same day,
   re-filed as folio 599782).
2. **`detalle`** — the actual form content: NOT a flat `{codigo,valor}` array like F22, but a
   RENDER-ORIENTED nested table (sections → sub-tables → rows → cells), each cell carrying
   `value`/`colspan`/`rowspan`/`style`/`tipoCelda`/`contactoRut`. Confirmed live on the FIRST
   well-formed attempt (body shape decoded from the bundle): the real RLI breakdown for this
   taxpayer's AT2025, with real peso figures (e.g. `"221.784.466"`).

Full contract, including three DIFFERENT `periodo` string/number conventions across the three
endpoints now in this family (a genuine, confirmed, load-bearing inconsistency in SII's own API,
not a project error) and the `contactoRut` PII flag: `docs/sii-contract/dj-detalle.md`.

## Decision

1. **`getDjIntegralAnualDetalle` gets a thin facade function**, `fetchDjHistorialAnual`, returning
   the per-DJ presentation history (folio/key/estado/fecha/tipoDeclaracion/casos) for one año —
   `periodo` sent as a bare NUMBER (the endpoint's own convention, distinct from
   `getDjIntegralAnual`'s string requirement — cited inline, ADR-004).
2. **`detalle` gets a facade function**, `fetchDjDetalle`, that returns the nested table
   STRUCTURE FAITHFULLY — no semantic re-modeling into a flat `{codigo,valor}` shape. This is a
   deliberate "surface, don't assert" choice (ADR-004, same posture as F22's unmapped códigos):
   the column semantics (which position is "Monto del ajuste" vs. "Tipo de Ajuste") are ONLY
   knowable by reading the aligned header row's (`tipoCelda:"cabecera"`) cell labels, and those
   labels are OBSERVED TO DIFFER per DJ number (1926's columns are not 1948's). Building a
   per-DJ semantic parser today, for a form this codebase has seen exactly once, risks silently
   mis-attributing a peso figure to the wrong column — unacceptable for a tool whose stated bar is
   "balanced to the peso, zero errors." The curated shape preserves EVERY cell's `value` exactly
   as SII sent it, organized as a typed tree (not `unknown`), so a report-writer (human or LLM)
   can align data cells to header cells by column position with full confidence nothing was
   reinterpreted.
3. **`contactoRut: true` cells are redacted** (`value` dropped, the flag kept) — this is SII's OWN
   PII signal, not a denylist this project has to derive by hand. None fired for DJ 1926 (no
   counterparty RUTs in a balance form) but WILL for DJ 1948 (a per-socio distribution list) once
   that DJ is spiked — the redaction is generic across any DJ number, not hardcoded to 1926.
4. **`fetchDjDetalle` requires the CALLER to have already fetched `fetchDjHistorialAnual`** and
   supply its `key` — endpoint 1 is a required precedent, not an optional convenience (the wire
   doc's Open/TBD flags this as unconfirmed-but-assumed; revisit if a future observation shows
   `id` alone suffices).
5. **Only DJ 1926, ANUAL, `seccion=1`, `pagina=1`, `tipoConsulta=1` is live-validated.** The task
   layer's public API takes `dj` and `key` as explicit caller-supplied parameters (from a prior
   `dj historial` call) rather than hardcoding 1926 — the facade itself is DJ-number-agnostic (it
   does not interpret column semantics, so it has no reason to special-case a form number) — but
   the wire contract doc is explicit that behavior for a monthly DJ, a different `seccion`, or
   pagination beyond page 1 is UNCONFIRMED.

## Alternatives Considered

1. **Parse DJ 1926's table into a semantic `{montoAjuste, tipoAjuste, ...}` shape now.** Rejected
   — the risk of a silent column-misalignment bug producing a WRONG peso figure outweighs the
   convenience, for a form observed exactly once against one taxpayer. Revisit once the shape is
   confirmed stable across multiple real DJ 1926 filings (ideally from more than one taxpayer).
2. **Skip `detalle` entirely and ship only the presentation-history endpoint.** Rejected — the
   presentation history (folio/estado) is useful but does not deliver the actual "balance y EERR"
   ask; the whole point of this spike was the underlying figures, not just metadata about them.
3. **Guess `seccion`/`tipoConsulta` values without a live confirmation.** Rejected (ADR-004) — the
   first live attempt used the SPA's own decoded default (`seccion=1`) rather than an invented
   value, and succeeded; no further guessing was needed, but the doc is explicit that untested
   values remain untested.

## Consequences

- `dj detalle <periodo> <dj> [--seccion]` (CLI) / `dj_detalle` (MCP) become the first surfaces in
  this codebase to expose a genuinely UN-modeled, render-oriented SII response shape — a
  deliberate, documented exception to the "curated shape" norm elsewhere, justified by the
  accuracy risk of guessing at semantics this project has observed exactly once.
- A future spike on DJ 1948 (retiros/dividendos) can reuse `fetchDjHistorialAnual`/`fetchDjDetalle`
  as-is (both are DJ-number-agnostic) — only a NEW column-semantics understanding (documented,
  not coded) would be needed, plus confirming the `contactoRut` redaction actually fires for that
  form's per-socio rows.
- **Open follow-up**: once this shape is seen for a second real DJ 1926 filing (a different
  taxpayer or a different año), confirm the section/table structure is STABLE before ever
  considering a semantic parser on top of this faithful passthrough.
