# ADR-032: Notificaciones / Correspondencia (`notificaciones list`/`detalle`) — closing the citación-visibility gap

## Status

Accepted — 2026-08-03. New read facade; closes candidate 4 of `docs/NEXT-SPIKES-PLAN.md`.
Supersedes the GWT-app hypothesis recorded in
`docs/audits/2026-08-03-spike4-notificaciones-progress.md` (a prior session's partial progress).

## Context

The project could only say "no `fechaCitacion` in F22 historial" about a possible Art. 63
citación — not a real confirmation that none exists via another channel. A citación interrupts
the Art. 200 prescription clock, so this is a real audit gap with legal weight, first raised
during the Empresa A audit (`docs/audits/2026-07-29-empresa-a-bpst-fix.md` context) and
tracked as candidate 4 in `docs/NEXT-SPIKES-PLAN.md`.

A prior session's spike found Mi SII's `linkexterno(4)` resolves to a GWT-compiled app
(`corenoti1Internet`, `.nocache.js` + `<hash>.cache.js` signature) and reasonably guessed this was
the read surface — the same technology `peticiones` already uses (ADR-020) — then deliberately
stopped short of building a GWT decoder rather than rush one at the end of a long session (see the
progress log for the reasoning).

**This session's live exploration found that hypothesis was wrong.** Reading Mi SII's own
`misii.min.js` (fetched live via the authenticated session, `requestForm` — no separate tooling)
shows `linkexterno(4)`'s real tooltip verbatim: *"Solicitar, actualizar o revocar correo para
notificaciones"* — that GWT app configures WHICH EMAIL receives notification alerts. It is a
write/configuration flow, unrelated to reading notification content.

The actual read surface — the plain link labeled **"Mis Notificaciones Vigentes"** / *"Notificaciones
de Carácter formal que el SII le ha enviado"* right next to it in the same page — fires
`call_option(201)`, which POSTs `opc=41&VIEW=1` to Mi SII's own legacy `CViewCarta.cgi`
(`misiir.sii.cl`), a plain form-POST → JSON endpoint, fully readable in the client's own
unobfuscated JS (variable names, comments, and all). **No GWT decoding was needed.** Full contract:
`docs/sii-contract/notificaciones.md`.

This same CGI also serves informal **correspondencia** (`opc=40`/`42`, cartas/avisos/correos) —
the same envelope shape, a superset of what a taxpayer sees in the "Correspondencia" panel.

## Decision

1. **New facade `portal/notificaciones.ts`** — `fetchComunicacionesList(session, {categoria})` and
   `fetchComunicacionDetalle(session, {categoria, id, tipo})`, where `categoria` selects
   `FORMAL` (opc 41/43) or `CORRESPONDENCIA` (opc 40/42). Reached via the EXISTING `requestForm`
   seam (ADR-017) — no new primitive. **No bootstrap `goto` is required** (unlike DJ, ADR-030): a
   cold POST works directly, confirmed live by removing every prior navigation and re-testing.
2. **New envelope, parsed + validated with zod at the boundary (ADR-011)**: `{estado, glosa, data,
   metaData}`, distinct from every envelope already in this codebase. `estado: 0` = success;
   `estado: 1403` (`glosa: "No existen registros"`) = a LEGITIMATE empty result, never an error —
   consistent with this codebase's "absence is not an error" convention. Any other `estado` raises
   `NotificacionesError` with SII's `glosa` verbatim (ADR-004) — no other value has been observed
   live, so nothing else is assumed benign.
3. **`tipo` passes through verbatim, no decode table.** The wire doc records every `tipo` code
   seen (`"2"`, `"4"`, `"8"`, `"9"`), but this codebase has not observed SII's own authoritative
   meaning for each — asserting one would violate ADR-004. `tipoNotificacion`/`descTipo` (SII's own
   human labels) are the reliable human-readable signal instead.
4. **Detail exposes the letter's HTML `body` deliberately, drops attachment/certificate binary
   payloads deliberately.** The `body` field is the actual value of this module — e.g. what a
   citación literally says — and carries the taxpayer's OWN identity (razón social, contact
   email), not third-party PII; this is the same category as `whoami`'s own-identity exposure, not
   the BTE/BPST own+counterparty mixing problem that forces those modules to drop `raw` entirely.
   Surfaced with an explicit stated exposure, same posture as `whoami`. Base64 attachment/
   certificate content is dropped — not a PII decision, a payload-size/relevance one (an LLM tool
   result is the wrong place for an embedded PDF blob); curated to `{ nombre }[]` + a boolean flag.
5. **`opc=43` (formal notification detail) is unconfirmed with real data.** This taxpayer has zero
   rows in the formal list — `estado: 1403` itself is informative (no citación on file for this
   RUT, as of 2026-08-03) but leaves the detail endpoint's exact shape inferred from the SAME
   client-side handler that serves `opc=42` (`viewComunicaciones()` branches on a `noti` flag but
   shares one success callback) rather than independently observed. Flagged in the wire doc;
   re-verify the first time a real formal notification is available for any taxpayer.
6. **Session-keyed, self only, for now** — same caution as F22/F29/BTE/BPST/DJ: no represented-RUT
   parameter was observed in the request shape, and the test session (an empresa account) cannot
   represent anyone (ADR-005) to test reach either way.
7. **Pagination beyond one page is not yet handled** — `metaData.page` carries `fullSize`/
   `currentPageIndex`/`lastPageIndex`, all consistent with a single page in every observed capture
   (max 14 rows, `pageSize: 1000`). The task surfaces `masPaginas: boolean` computed from that
   metadata rather than silently truncating a taxpayer with more than 1000 items of one kind, but
   does not yet know the request shape for page 2 (unobserved, open item).

## Alternatives Considered

1. **Build the GWT decoder for `corenoti1Internet` as originally planned.** Rejected — the live
   read of `misii.min.js` proved that app is a write/configuration flow (managing the alert email
   address), not the read surface this spike needs. Building it would have spent the exact
   high-risk, high-effort work ADR-020 already paid for on a target that does not answer the
   audit's question.
2. **Reuse `portal/gwt.ts` / `gwt-schema.ts` in any form.** Rejected — not applicable; this module
   is plain form-POST → JSON, unrelated to GWT-RPC.
3. **Treat any non-zero `estado` as a hard error, including 1403.** Rejected — `1403` with
   `"No existen registros"` is SII's own documented "nothing here" signal, load-bearing for the
   exact audit answer this spike exists to provide ("no citación on file").
4. **Surface the full `adjunto`/`certificado` base64 payloads.** Rejected — unbounded binary
   content in a JSON result serves neither the CLI human reader nor an LLM tool caller; the letter
   `body` HTML already carries the substantive text.

## Consequences

- Closes `docs/NEXT-SPIKES-PLAN.md` candidate 4. Candidate 5 (Carpeta Tributaria Electrónica)
  remains open.
- `honorarios`/`monitor`/audit reports gain a genuine answer to "is there a pending formal
  notification (citación, liquidación, resolución)" — today a manual `notificaciones list`
  read, not yet wired into `monitor.ts`'s automated findings (future follow-up, same split already
  established for other raw-read-vs-judgment-layer facades in this codebase).
- **Open follow-up:** confirm `opc=43`'s exact shape live once a taxpayer with a real formal
  notification is available. Confirm or refute represented-empresa reach. Determine the page-2
  request shape if a taxpayer with >1000 rows of one category is ever observed.
- Corrects `docs/audits/2026-08-03-spike4-notificaciones-progress.md`'s working hypothesis for any
  future reader — that log is left in place (historical record of the exploration path) but this
  ADR is the authoritative account of what the read surface actually is.
