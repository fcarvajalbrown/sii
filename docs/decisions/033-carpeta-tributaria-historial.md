# ADR-033: Carpeta Tributaria Regular (`carpeta historial`) — read-only historial of issued dossiers

## Status

Accepted — 2026-08-03. New read facade; closes candidate 5 of `docs/NEXT-SPIKES-PLAN.md`, the
last of the five original spike candidates.

## Context

`docs/ARCHITECTURE.md` listed "carpeta tributaria" as an unexplored part of "everything-not-DTE";
`docs/NEXT-SPIKES-PLAN.md` candidate 5 flagged real uncertainty about whether it would even be
viable as a structured facade ("puede que termine siendo generación de un PDF sin datos
estructurados detrás"). A live, read-only spike (a real taxpayer account, real session) found the actual
product is richer than that: **"Carpeta Tributaria Regular"**, the consolidated dossier SII issues
for credit applications, has a real REST JSON **historial** endpoint behind it — not just a PDF
generator. Full contract: `docs/sii-contract/carpeta-tributaria.md`.

The routing took several hops to find (Mi SII → a `www.sii.cl` services catalog page → a
three-way menu: "Carpeta Tributaria Regular (nueva versión)" / "versión anterior a octubre 2025"
/ "Carpeta por Mandato a Instituciones") before landing on the real app
(`www2.sii.cl/carpetatributaria/cteregular`), the SAME `www2.sii.cl` REST-JSON-with-RUT-in-path
family DJ already uses (ADR-030) — same bootstrap precondition (`goto` the UI page + pace before
any GET, or a bare HTTP 401), same `/app/session/status` infrastructure. The response is simpler
than DJ's: a bare JSON array, no wrapper envelope.

**This SII product also exposes real write actions on the same page**: generating a NEW dossier
("Generar Carpeta Tributaria Regular para Créditos"/"...Personalizada") and annulling an existing
vigente one ("Anular", visible directly on the historial page). Neither was ever touched — this
ADR covers ONLY the read-only historial (`buscar`), per the project's hard "solo lectura" rule for
this spike.

## Decision

1. **New facade `portal/carpeta.ts`**, `fetchCarpetaTributariaHistorial(session, {rut, anio?})` —
   GET `.../carpeta-tributaria/buscar` (optionally `?agno=<año>`; omitted = every año, the
   default). Reuses the EXISTING `requestJson` seam (no new primitive) with the SAME
   bootstrap-then-pace pattern DJ needed (`goto` the UI page, pace, then GET) — implemented
   locally in `carpeta.ts`, not by importing DJ's private helper (keeps facades self-contained,
   the existing convention).
2. **Response is a bare JSON array — no error envelope has ever been observed.** Unlike DJ (whose
   out-of-range case IS an error envelope) or Notificaciones (`{estado, glosa, ...}`), this
   endpoint returned only clean arrays (including `[]` for a filtered año with no matches) across
   every successful call. `CarpetaTributariaError` is raised only for a genuinely unparseable
   response — never asserting an interpretation for a business-error shape this session never saw.
3. **`carpParametros` (a JSON-encoded STRING on the wire) is parsed into a tolerant key/value bag**,
   not left opaque and not modeled as a closed shape — only `carpTipo: 1` ("Solicitar Credito")
   dossiers were observed, so the parser accepts any boolean/number/string/null field rather than
   asserting a fixed key set that might not hold for other tipos.
4. **Receptor fields (`carpNombreReceptor`/`carpRutReceptor`/`carpDvReceptor`) are surfaced, not
   dropped, with an explicit stated PII exposure at every surface (CLI help, MCP description)** —
   same posture as `peticiones_list` (ADR-020), not the BTE/BPST "drop entirely" posture. The
   receptor can be a genuine third party (observed live: a named bank contact person, own RUT,
   distinct from the taxpayer) — but unlike BTE/BPST's problem (own+counterparty PII
   indistinguishably mixed across many fields, forcing a full `raw` drop), here the exposure is
   exactly THREE well-bounded, clearly-labeled fields, so a full drop isn't necessary — declaring
   the exposure is enough, and it is the core audit value of this facade (who has a copy of your
   own tax dossier).
5. **`carpEstado`/`carpTipo` pass through verbatim, no closed enum, no inferred label.** Only `1`
   and `3` were observed for `carpEstado`; the UI's own "Vigente"/"No Vigente" toggle over this
   same data suggests a mapping, but no authoritative code table was read live, so none is
   asserted (ADR-004).
6. **`filtros` and `institucion`-based filtering are NOT built.** `filtros` is low-value UI
   metadata (redundant with what `buscar`'s own rows already show); the institución `<select>`'s
   real query parameter was not confirmed live (a Vue-object-bound value, not inspectable via
   plain DOM reads in the time available) — building it would mean guessing an unobserved param
   name, which ADR-004 forbids.
7. **Session-keyed, self only, for now** — same caution as F22/F29/BTE/BPST/DJ/Notificaciones: no
   represented-empresa reach was observed or testable (the test session is an empresa account,
   which per ADR-005 cannot represent anyone).
8. **A genuine reliability open item, recorded rather than hidden**: the endpoint answered 3
   independent calls cleanly during exploration (once via a real browser click, twice via direct
   API calls at 500ms/1000ms pacing), but then started failing with the same bare-401 shape,
   consistently, after roughly 10 total requests within a ~20-minute window — including one retry
   at a deliberately generous 3000ms pace. Per this project's hard "never retry against a possible
   block" rule, further attempts were NOT made. The wire contract itself is not in doubt (captured
   cleanly 3 times); what's unconfirmed is this specific endpoint's tolerance for repeated calls
   in a short window — its landing page uniquely loads Queue-It virtual-waiting-room scripts among
   every facade in this codebase, suggesting it may be more aggressively load-managed than DJ.
   **The final pre-close live verification of the BUILT facade did not succeed** — re-verify in a
   future session, spaced out over time, before relying on this facade for time-sensitive work.

## Alternatives Considered

1. **Build a PDF-only `carpeta descargar <rut>` instead of a structured facade** (the fallback
   `NEXT-SPIKES-PLAN.md` suggested if the product turned out to be PDF-only). Rejected — the
   product turned out to have a real, clean, structured JSON historial; a PDF-download-only
   facade would have thrown away the higher-value, already-available structured data.
2. **Guess the `institucion` query parameter from the visible `<select>` values.** Rejected — the
   values are Vue-managed objects, not plain strings observable without deeper reverse-engineering
   than this session's time budget allowed; ADR-004 forbids asserting an unobserved param.
3. **Assert `carpEstado: 1` = "Vigente" / `3` = "No Vigente" as a closed enum with labels.**
   Rejected — plausible from the UI's toggle, but not confirmed by reading an authoritative code
   table; asserting it risks silently mislabeling a future third value.
4. **Keep retrying the final live verification with even longer pacing until it succeeded.**
   Rejected — directly against the project's hard "never retry against a possible block" rule;
   honest reporting of an inconclusive final check is the correct outcome, not a manufactured
   success.
5. **Also build `cterevisar` (carpetas received) in the same pass.** Deferred — a genuinely
   different read (this taxpayer as RECIPIENT, not issuer) with its own routing/wire contract to
   confirm; scoping this ADR to the historial-of-issued surface keeps the change reviewable, same
   split already used elsewhere in this project (e.g. DJ status vs. DJ detalle, ADR-030/031).

## Consequences

- Closes `docs/NEXT-SPIKES-PLAN.md` candidate 5 — all five original candidates are now closed.
- A new audit angle: "has this taxpayer issued a credit dossier, to whom, when, still valid, and
  exactly what did it disclose (via `carpParametros`)" — not previously answerable by any surface
  in this codebase.
- **Open follow-up**: re-verify live reliability spaced over time (not this session); confirm or
  refute represented-empresa reach; determine the `institucion` filter's real parameter if ever
  needed; consider `cterevisar` (received dossiers) as a follow-up spike; confirm `carpEstado`'s
  authoritative labels if an official code table is ever found.
