# ADR-029: BPST — Boleta de Prestación de Servicios de Terceros Electrónica, and its role in `honorarios`

## Status

Accepted — 2026-07-29. New read facade + wire contract (first observation of this SII product in
this codebase), plus an additive fix to `honorarios` (ADR-023).

## Context

`honorarios` (ADR-023) reconciles BHE recibidas retención against F29 código 151. For
Empresa A SpA (a real taxpayer account), that reconciliation showed a persistent,
one-directional gap across three commercial years (2023: −$6.029.885 · 2024: −$1.655.738 · 2025:
−$1.209.506) — código 151 always larger than BHE recibidas, never the reverse. A code audit
(`docs/audits/2026-07-29-empresa-a-code-verification.md`) ruled out a summing/parsing bug:
both sides were read and totalled correctly.

The company's accountant identified the missing piece: **Boleta de Prestación de Servicios de
Terceros Electrónica (BPST)** — a distinct SII product where a PAYING company emits a boleta
*on behalf of* a low-skilled/informal worker (agrícola, bodega, reparto — anyone who cannot
operate the SII portal themselves) who cannot emit their own BHE. The company is the technical
"emisor" of record, but economically it is paying the worker and withholding on their income —
the same tax substance as a standard BHE recibida, just a different product with its own portal
section, its own host, and its own wire contract.

A live, read-only spike (a real taxpayer account, real session, GET/POST-form navigation only) confirmed
this is exactly the missing side, with exact-match precision:

- **2023-09**: BHE recibidas retención $162.457 + BPST emitidas retenido $164.368 = **$326.825**,
  exactly the F29 código 151 declared that month.
- **2023-03**: BHE recibidas retención $196.494 + BPST emitidas retenido (both result pages,
  $862.125 + $692.066) = **$1.750.685**, exactly the F29 código 151 declared that month.

Confirmed via SII's own **Mi SII** menu: `Servicios online → Boletas de honorarios electrónicas →
Boleta de prestación de servicios de terceros electrónica` (SII's own name for what it abbreviates
"BTE" in ITS OWN UI — see the naming-collision note below).

### Wire contract (observed live, 2026-07-29, a real taxpayer account)

- **Host:** `zeus.sii.cl` (a THIRD legacy CGI family, distinct from `loa.sii.cl` used by the
  existing `portal/bte.ts` and from the `www4.sii.cl` SDI-JSON facades).
- **Bootstrap GET** (mints the query form + session context): `GET
  https://zeus.sii.cl/cvc_cgi/bte/bte_indiv_cons?{1|2}` — `1` = EMITIDAS, `2` = RECIBIDAS.
- **Query POST**: `POST https://zeus.sii.cl/cvc_cgi/bte/bte_indiv_cons2`,
  `application/x-www-form-urlencoded`, fields: `TIPO=mensual`, `CNTR={1|2}`,
  `AUTEN=RUTCLAVE`, `PAGINA=<n, 1-based>`, `MESM=<01-12>`, `ANOM=<YYYY>`. (The form also supports
  `TIPO=anual`/`TIPO=diario` with `ANOA` / `DIA+MESD+ANOD` — NOT used here; this project's
  `Periodo` type is monthly, matching every other read surface.)
- **Response**: `text/html; charset=iso-8859-1` (NOT JSON, NOT the `loa.sii.cl` inline-JS-map
  pattern — a plain HTML table). **PAGINATED, and the `(*)Totales` row is PER-PAGE, not per
  month** — confirmed live: 2023-03 EMITIDAS totalled $862.125 retenido on page 1 alone, but
  $1.554.191 across both pages. A `NEXT` button (`<input type="button" name="NEXT" ...
  onClick="cambiapag(...)">`, absent/disabled on the last page) is the pagination signal — walk it
  the same way `portal/bte.ts` walks `loa.sii.cl` pages, but SUM every page's totals rather than
  trusting a single page-0 total (the opposite of the `loa.sii.cl` pattern, where page 0's meta
  already carries the full-month sum — cite this contrast explicitly in the facade).
- **Row shape (EMITIDAS, `CNTR=1`, one `<tr>` per boleta):** Ver (link icon, ignored), N° (folio),
  Estado (an `<a>` whose text is a short code — only `VIG` observed live; `overlib(...)` carries
  the human label, e.g. `'Vigente'` — NO anulada example was captured live, so the facade must
  NOT hardcode a closed VIG/ANU enum; read the code AND the tooltip label verbatim, tolerant of an
  unobserved third value), Fecha (boleta date, `DD-MM-YYYY`), Rut/Nombre (the company itself —
  "Emisión" group), a second Fecha (same value observed both times — kept, not asserted as
  distinct semantics), Rut/Nombre (the WORKER — "Receptor" group, the counterparty that matters),
  Brutos/Retenidos/Pagado (the three montos, es-CL dot-formatted).
- **Row shape (RECIBIDAS, `CNTR=2`):** header-only observed (Boleta ×4, Emisor ×3 [Rut/Nombre/
  Fecha], Honorarios ×3 = 10 cols) — every sampled month for this RUT had ZERO recibidas boletas,
  so **no real data row was captured for this side**. The facade implements it symmetrically
  (same column-family pattern as EMITIDAS, mirrored) but this is NOT live-revalidated with real
  rows — flagged in `docs/sii-contract/bpst.md` for follow-up once a taxpayer with recibidas BPST
  activity is available.
- **Session-keyed** (ADR-005): `AUTEN=RUTCLAVE` ties the query to the session principal; no RUT is
  submitted in the form. Mirrors `bte`/`f22`/`f29` — reads self only, rejects a representing
  operate pointer up front.

### Naming collision — read carefully before touching `bte.ts`

SII's OWN UI abbreviates "Boleta de prestación de servicios de Terceros Electrónica" as **"BTE"**
(see the menu literal: "Emitir BTE por contribuyente", "Consulta de BTE's recibidas/emitidas").
This project's EXISTING `portal/bte.ts` / `tasks/bte.ts` (landed #20, ADR unnamed, live-validated
2026-06-30) uses "BTE" as shorthand for the GENERIC "Boletas [de] Honorarios Electrónicas" (BHE) —
a real, correctly-implemented, different product, on a different host (`loa.sii.cl`). **The two
are unrelated systems that happen to share an acronym by coincidence of the original developers'
naming choice, not because SII's BPST and the standard BHE system are the same thing.** This ADR
deliberately does NOT rename or touch the existing `bte.ts`/`bte-emit.ts` (a working, tested,
live-validated write surface — renaming it is out of scope, high-risk, and unrelated to this fix).
The new module is named `bpst.ts` throughout (portal + task + CLI + MCP) specifically to avoid
deepening the collision.

## Decision

1. **New facade `portal/bpst.ts`**, `fetchBpstMensual(session, {rut, periodo, side}, pace)`,
   modelled on `portal/bte.ts`'s shape (curated `BpstBoleta[]` + `BpstTotales`, no `raw` — the row
   mixes the company's own identity with the worker's, same live-BUG-1-shaped reasoning as BTE/BHE)
   but with its OWN pagination strategy (sum every page, not read page-1 alone) per the wire
   contract above. `estado` carries BOTH the short code and the tooltip label verbatim, no
   hardcoded enum. Wire contract cited in `docs/sii-contract/bpst.md`.
2. **New task `tasks/bpst.ts`**, `bpstList(runtime, {periodo, side})` — a thin read mirroring
   `bteList`, session-keyed, own CLI (`bpst list <periodo> [--emitidas|--recibidas]`) and MCP
   tool (`bpst_list`) per module (CONVENTIONS: "domain read surfaces own a per-module file + a
   register fn").
3. **`honorarios` (ADR-023) is EXTENDED, additively, to include BPST EMITIDAS retenido.** Per
   month, `readMes` now ALSO calls `fetchBpstMensual(..., side: 'EMITIDAS')` and adds its
   `retenidos` total to the reconciled "what we withheld" figure — `HonorariosMes` gains
   `bpstBrutos`/`bpstRetenido` (surfaced separately, never silently merged into the old field) and
   the reconciliation compares `retencionReceptor + bpstRetenido` (not `retencionReceptor` alone)
   against F29 código 151. `HONORARIOS_CACHE_VERSION` bumps `1 → 2` (ADR-027: shape changed, stale
   cache entries must self-invalidate, never silently serve the old under-counted total).
   **Additive only** — a taxpayer with zero BPST activity (the overwhelming majority) sees
   `bpstBrutos`/`bpstRetenido` as `0`/`null` and the reconciliation is numerically UNCHANGED from
   before this ADR; nothing about the existing BHE-recibidas leg, the F22 leg, or any other
   composite task (`iva`, `renta`) is touched.
4. **RECIBIDAS side of BPST is exposed for parity via `bpst list`/`bpst_list` but is NOT wired
   into `honorarios`'s reconciliation** — the economics of BPST recibidas (company as beneficiary
   of a service billed via BPST) do not correspond to a retención the company itself declares in
   código 151, mirroring why `retencionEmisor` on standard BHE is excluded (ADR-023 trap #1). Only
   EMITIDAS retenido is the company's own withholding obligation.

## Alternatives Considered

1. **Fold BPST reading directly into `bte.ts`/`bte-emit.ts` as a third `side`.** Rejected — a
   different host, different wire shape (per-page totals vs. page-0 month totals), different form
   fields, and folding it in would deepen the exact naming collision this ADR flags. A clean new
   module is safer and matches the project's per-module-file convention.
2. **Trust only page 1's totals (matching `loa.sii.cl`'s pattern).** Rejected — proven wrong live:
   2023-03 page 1 alone underreports retenido by $692.066 (a 44% undercount for that month). The
   facade MUST paginate and sum.
3. **Compute a delta against BPST RECIBIDAS too.** Rejected for now — no live data to validate the
   column mapping against (every sampled month was zero rows), and the tax substance doesn't map
   to código 151 the way EMITIDAS does. Revisit once real recibidas data exists for some taxpayer.
4. **Rename the existing `bte.ts` to something unambiguous now that the real "BTE" meaning is
   known.** Rejected — high blast radius (live CLI verb `bte`, live MCP tools, ADR-017 write
   surface, existing tests) for a purely cosmetic fix; the naming collision is now documented
   instead, which is sufficient to prevent future confusion.

## Consequences

- Closes the honorarios reconciliation gap for any taxpayer that uses BPST (common — construction,
  agriculture, retail/distribution with informal warehouse or delivery labor) without touching the
  reconciliation for taxpayers that do not (numerically inert for them).
- `honorarios` becomes marginally heavier (one more paginated fetch per month, EMITIDAS side only)
  — acceptable, same "heaviest read in the repo, run rarely" profile as before (ADR-023).
- **Live-revalidation gap carried forward:** BPST RECIBIDAS row parsing is header-observed only,
  not data-row-validated. `bpst list --recibidas` should be treated as unconfirmed until a real
  non-empty month is captured; `bpst list --emitidas` and its role inside `honorarios` ARE
  data-validated (two real months, exact-match arithmetic against F29).
- The `bte`/`BTE` naming collision is now a documented, permanent footnote (this ADR +
  `docs/CONVENTIONS.md`) rather than a silent trap for the next person who reads SII's own UI and
  wonders why the codebase's `bte.ts` doesn't match what SII calls "BTE".
