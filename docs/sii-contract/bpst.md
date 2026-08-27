# SII wire contract — BPST (Boleta de Prestación de Servicios de Terceros Electrónica)

> **Ground truth (once built):** the authoritative source is the cited code in
> `packages/core/src/portal/bpst.ts` + the `zeus.sii.cl` host in core config (ADR-004 inline
> `// observed …` citations). This doc is the curated synthesis. RUTs/names below from the live
> capture are the REAL taxpayer's own boletas to its own contractors, kept because they are the
> only live-observed example — no third-party PII beyond what the taxpayer's own account exposes.

**Status:** first observation of this SII product in this codebase (ADR-029). Captured live
2026-07-29, read-only (GET navigation + one non-mutating `POST` per "Consultar" query — same
consulta pattern as every other read facade), a real taxpayer account (Empresa A SpA,
empresa session). **EMITIDAS side is data-row-validated (2 real, non-empty months, exact-match
arithmetic against F29 código 151). RECIBIDAS side is header-only observed — every sampled month
for this RUT had zero recibidas boletas, so no real data row exists to validate the row-parsing
against.**

## What BPST actually is (and why it matters for `honorarios`)

A company that pays a low-skilled/informal worker (agrícola, bodega, reparto — anyone unable to
operate the SII portal) can EMIT the boleta *on the worker's behalf* via this distinct product.
The company is the technical "emisor" of record, but economically it is the payer withholding on
the worker's income — the same substance as a standard BHE recibida (ADR-023), just filed through
a different SII system with its own portal section, host, and wire shape. See ADR-029 for the full
naming-collision note (SII's own UI calls this product "BTE", colliding with this codebase's
EXISTING and UNRELATED `bte.ts`/`bte-emit.ts` module for standard Boletas de Honorarios
Electrónicas).

## Reach — session-keyed (by construction, not yet independently spiked)

No RUT field is submitted in the consulta form — only `AUTEN=RUTCLAVE`, tying the query to
whichever RUT is currently authenticated. This mirrors BTE/F22/F29 (ADR-005): the facade reads
self only and rejects a representing operate pointer up front. Not separately live-spiked against
a represented empresa (low priority — the pattern is consistent across every other legacy CGI in
this codebase).

## Architecture — a THIRD wire shape, distinct from both existing legacy patterns

| Existing pattern | Host | Shape |
| --- | --- | --- |
| SDI-JSON (RCV/F22/F29) | `www4.sii.cl` | JSON envelope, `PortalSession.requestJson` |
| Inline-JS-map (BTE/BHE) | `loa.sii.cl` | HTML skeleton + JS global maps, `goto`/`evaluate` |
| **BPST (this doc)** | **`zeus.sii.cl`** | **Plain HTML table, form-POST query, `requestForm`** |

BPST is closest to the ADR-017 write-flow pattern (`requestForm`, authenticated
`x-www-form-urlencoded` POST, HTML response) — it is a READ, but the wire shape (form-POST, HTML
back) is the same primitive, not `requestJson` and not `goto`/`evaluate`-on-inline-maps.

## Anti-bot / captcha posture

None observed on the consulta flow (no `grecaptcha`/`recaptchaService` markers in the pages hit
during the spike).

## Endpoints

Base: `https://zeus.sii.cl/cvc_cgi/bte/`.

### Bootstrap — `GET bte_indiv_cons?{1|2}`

`GET https://zeus.sii.cl/cvc_cgi/bte/bte_indiv_cons?1` (EMITIDAS) or `?2` (RECIBIDAS). Mints the
query form context (session cookie carries — same `.sii.cl` cookie as every other surface). A
`PortalSession.goto` call; response is the blank query form (Anual/Mensual/Diario radio-equivalent
sections sharing one `<form name="form1">`). Landing on `zeusr.sii.cl` ⇒ dead session →
`SessionExpiredError` (same URL-based detection as every other surface).

### Query — `POST bte_indiv_cons2`

`POST https://zeus.sii.cl/cvc_cgi/bte/bte_indiv_cons2`, `application/x-www-form-urlencoded`:

```
TIPO=mensual            # anual | mensual | diario — this project only uses mensual (Periodo)
CNTR=1|2                # 1 = EMITIDAS, 2 = RECIBIDAS
AUTEN=RUTCLAVE          # constant — session-keyed, no RUT param
PAGINA=<n>              # 1-based (NOT 0-based like loa.sii.cl)
MESM=<01-12>            # zero-padded month
ANOM=<YYYY>
```

Response: `text/html`, `charset=iso-8859-1` (observed in `<meta http-equiv>`; NOT JSON). Title
`"Boleta de Prestación de Servicios de Terceros Electrónica"`; body heading `INFORME BTE's
EMITIDAS` / `INFORME BTE's RECIBIDAS`.

## Row shape (EMITIDAS, `CNTR=1`) — data-row-validated live

One `<tr>` per boleta inside the results `<table>`. Column groups (observed via the header
`<td>`s): **Boleta** (Ver-link icon [ignored], N° [folio], Estado, Fecha) → **Emisión** (Rut,
Nombre, Fecha — the COMPANY's own identity; own-PII, never surfaced) → **Receptor** (Rut, Nombre —
the WORKER, the counterparty that matters) → **Honorarios** (Brutos, Retenidos, Pagado).

Live example row (2023-09, folio 344):

```
Ver: <a href="/cvc_cgi/bte/bte_indiv_cons3?C7702669400344B89B0BA">...</a>  (detail-view link, ignored)
N°: 344
Estado: <a onmouseover="overlib('Vigente', ...)">VIG</a>   ← short code "VIG" + tooltip label "Vigente"
Fecha: 04-09-2023            (DD-MM-YYYY)
Rut (Emisión): a real taxpayer account    (the company itself — OWN PII, drop)
Nombre (Emisión): Empresa A SpA   (OWN PII, drop)
Fecha (2nd): 04-09-2023      (same value observed both times in every sampled row — kept as a
                               second date field, semantics beyond "duplicate of the first" NOT
                               asserted; do not collapse the two fields into one without further
                               observation)
Rut (Receptor): 11111111-1    (the WORKER — curate as contraparteRut)
Nombre (Receptor): ROGER ROGERS LILLO   (curate as contraparteNombre)
Brutos: 804.598
Retenidos: 104.598
Pagado: 700.000
```

**`estado`: only `VIG` (vigente) observed live.** NO anulada example was captured — do NOT
hardcode a closed `VIG | ANUL` enum. Read the anchor's text verbatim as the code, AND extract the
`overlib('<label>', ...)` argument verbatim as the human label; treat any code other than `VIG` as
an unmapped-but-passed-through value (ADR-004: never assert an unobserved state).

Montos (`Brutos`/`Retenidos`/`Pagado`) are **Chilean dot-formatted** (`"804.598"`) — parse es-CL
(cf. F22/BTE).

## Row shape (RECIBIDAS, `CNTR=2`) — HEADER ONLY, no data row observed

Every month sampled for a real taxpayer account returned **zero** recibidas boletas (`Total Boletas : 0`
in the summary line, and the `(*)Totales` row all-zero). The header groups differ slightly from
EMITIDAS: **Boleta** (Ver, N°, Estado, Fecha) → **Emisor** (Rut, Nombre, Fecha — the COUNTERPARTY
who issued the boleta TO the taxpayer) → **Honorarios** (Brutos, Retenidos, Pagado) — 10 columns
total (vs. 12 for EMITIDAS, since there is no separate "Emisión = self" group to skip: the
taxpayer IS the receptor by construction of this query side). **The facade implements this
symmetrically with EMITIDAS's parser (mirrored group), but the mapping is UNCONFIRMED against a
real row** — flag any live RECIBIDAS data encountered as a priority to re-validate this section.

## Pagination — PER-PAGE totals, must be summed (the load-bearing trap)

**The `(*)Totales` row at the bottom of each page sums ONLY that page**, not the whole month —
confirmed live and load-bearing:

| Período | Página | Brutos | Retenidos | Pagado |
| --- | --- | --- | --- | --- |
| 2023-03 EMITIDAS | 1 | 6.631.725 | 862.125 | 5.769.600 |
| 2023-03 EMITIDAS | 2 (last) | 5.323.580 | 692.066 | 4.631.514 |
| **2023-03 EMITIDAS TOTAL** | — | **11.955.305** | **1.554.191** | **10.401.114** |

The month's TRUE total retenido ($1.554.191) exactly closes the honorarios gap for that month
(BHE recibidas $196.494 + BPST $1.554.191 = F29 código 151 $1.750.685) — reading page 1 alone
would have under-counted by 44.5%. **The facade MUST walk every page and sum, unlike `loa.sii.cl`
(BTE/BHE), where page 0's meta already IS the full-month total.**

Pagination signal: a `<input type="button" name="NEXT" ... onClick="cambiapag(document.form1,
<next-page>);">` present and NOT `disabled`. On the last page, `NEXT` carries the `disabled`
attribute (observed: `PREV` is `disabled` on page 1; by symmetry `NEXT` is `disabled` on the last
page — confirmed live for 2023-03's page 2, which had no further `NEXT`/`cambiapag` reference).
Increment `PAGINA` and re-POST until `NEXT` is absent/disabled, or a `_MAX_PAGINAS` cap (ADR-004
non-advancing-loop backstop, same pattern as BTE/BHE).

Also present in the summary line above the table: `Total Boletas : <n>`, `Boletas Vigentes : <n>`,
`Boletas Anuladas : <n>`, `Página <p> de <n>` — useful as a page-count hint, but the facade should
still walk pages via the `NEXT` signal rather than trust `Página X de Y` as authoritative (not yet
cross-checked against a month with >2 pages).

## Error envelope

No JSON/structured envelope — HTML throughout.

| Condition | Signal |
| --- | --- |
| Report page (with or without rows) | Title `Boleta de Prestación de Servicios de Terceros Electrónica`; `(*)Totales` row present (possibly all-zero). |
| Empty month | `Total Boletas : 0`, `(*)Totales` row all-zero — a legitimate empty result, NOT an error (same posture as every other read surface). |
| Session bounce | `session.requestForm`'s login-wall check is URL-based (landing on `LOGIN_HOST`), per ADR-017's `requestForm` primitive — an HTML body is expected here, so it cannot be used as the auth signal. |

## Field semantics

| Field | Format |
| --- | --- |
| período | `MESM=<01-12>` + `ANOM=<YYYY>` (mensual only, this project) |
| paginación | `PAGINA=<n>`, **1-based** (contrast `loa.sii.cl`'s 0-based `pagina_solicitada`) |
| montos | Chilean dot-formatted (`"804.598"`) — parse es-CL |
| fecha | `DD-MM-YYYY` (hyphens, not slashes — contrast BTE/BHE's `DD/MM/YYYY`) — kept verbatim |
| `estado` | short code from the `<a>` text (`VIG` observed) + human label from `overlib('<label>', ...)` — no closed enum |

## PII posture — NO `raw`, same reasoning as BTE/BHE (live BUG-1 precedent)

Each EMITIDAS row mixes the taxpayer's OWN identity (Rut/Nombre under "Emisión") with the WORKER's
identity (Rut/Nombre under "Receptor") — the exact live-BUG-1 shape already established for
standard BTE/BHE (CONVENTIONS: drop `raw` when the non-curated data is PII, own-identity field set
not provably enumerable). `portal/bpst.ts` exposes **NO `raw`**: curated fields only (`folio`,
`estado`, `estadoLabel`, `fecha`, `contraparteRut`, `contraparteNombre`, `brutos`, `retenidos`,
`pagado`) — the taxpayer's own Rut/Nombre (`Emisión` group on EMITIDAS rows) is read internally
for row-shape parsing but never surfaced.

## Open / TBD

- **RECIBIDAS row shape**: header-observed only, zero real rows seen. Re-validate against a
  taxpayer with actual BPST-recibidas activity before trusting `bpst list --recibidas` output.
- **`estado` beyond `VIG`**: no anulada example captured. Extend the human-label mapping + cite
  when one is observed (the code already reads the tooltip verbatim, so no code change is needed
  when it happens — just a documentation update).
- **`Página X de Y` vs. the `NEXT` button** as the authoritative pagination-continue signal: only
  cross-checked against a 2-page month. A month with 3+ pages would strengthen confidence that
  walking via `NEXT` (not trusting the page-count string) is the right primitive.
- **TIPO=anual / TIPO=diario**: form fields observed (`ANOA`; `DIA`+`MESD`+`ANOD`) but never
  queried — this project's `Periodo` type is monthly only, matching every other read surface.
