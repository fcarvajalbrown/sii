# SII wire contract — Carpeta Tributaria Regular (historial)

> **Ground truth (once built):** the authoritative source is the cited code in
> `packages/core/src/portal/carpeta.ts` + the host in core config (ADR-004 inline `// observed …`
> citations). This doc is the curated synthesis. Values below are from live captures, 2026-08-03,
> a real taxpayer account (Empresa A SpA) — the taxpayer's own real historial, kept
> because it is the only live-observed example.

**Status:** first observation of this SII product in this codebase (ADR-033). Captured live,
read-only — every request below is a GET; no `generarcteregular`/`anular` form was ever
submitted (see "What was deliberately NOT touched" below).

## What this is

"Carpeta Tributaria Regular" is the consolidated dossier SII generates for a taxpayer — the
document banks and institutions request for credit applications, combining a snapshot of
identity, representación, sucursales, boletas, declaraciones juradas, and more into one PDF. This
facade reads the **historial of dossiers already issued** ("Revisar Historial de Carpetas
Tributarias Regulares Emitidas") — which ones exist, when, valid until when, addressed to whom,
still vigente or anulada, and — via `carpParametros` — exactly what sections each one disclosed.
It does **not** generate a new dossier or annul an existing one; those are separate, explicit
write actions on the same SII product (see below).

## Routing — how this was found

Mi SII's sidebar link "Carpeta tributaria electrónica" → `https://www.sii.cl/servicios_online/1047-1702.html`
→ (a generic services catalog page) → three sub-sections:

1. **"Carpeta Tributaria Regular (nueva versión)"** — `Generar Carpeta Tributaria Regular para
   Créditos` / `Generar Carpeta Tributaria Regular Personalizada` (both **WRITE — generation**,
   `www2.sii.cl/carpetatributaria/generarcteregular` / `generarctepersonalizada`, never touched)
   and **`Revisar Historial de Carpetas Tributarias Regulares Emitidas`**
   (`www2.sii.cl/carpetatributaria/cteregular` — **the surface this facade reads**) and
   `Revisar Carpeta Tributaria Regular Recibida` (`www2.sii.cl/carpetatributaria/cterevisar` —
   dossiers ADDRESSED TO this taxpayer by someone else; **not built, follow-up item**).
2. **"Consulta Carpetas Tributarias Electrónicas (versión anterior a octubre 2025)"** — legacy
   `zeus.sii.cl/dii_cgi/carpeta_tributaria/…` CGIs, explicitly marked as the OLD version;
   superseded by (1), not investigated.
3. **"Carpeta por Mandato a Instituciones"** — `www4.sii.cl/cteInternet/` (authorizing an
   institution to pull your carpeta automatically); a separate feature, not investigated.

## An EIGHTH wire shape — but the SAME FAMILY as DJ (#6)

| # | Pattern | Host | Primitive |
| --- | --- | --- | --- |
| 6 | REST JSON, RUT-in-path (DJ) | `www2.sii.cl` | `requestJson`, bootstrap `goto` + pace required |
| 7 | Form-POST → JSON (Notificaciones) | `misiir.sii.cl` | `requestForm`, no bootstrap |
| 8 | **REST JSON, RUT-in-path (this doc)** | **`www2.sii.cl`** | **`requestJson`, SAME bootstrap requirement as #6 — but a BARE ARRAY response, no wrapper envelope at all** |

This is the SAME `www2.sii.cl` app-session infrastructure as `dj.ts` (both ping
`/app/session/status`; both require a `goto` to the product's own UI page before any API call
succeeds) — reusing the *pattern*, not the code (each facade stays self-contained per this
codebase's convention). The response shape is the simplest yet: a **bare JSON array** of rows, no
`{estado,...}`/`{data,...}` wrapper at all.

## ⚠️ Load-bearing: the SAME bootstrap precondition as DJ (ADR-030) — confirmed, AND observed to
## be LESS reliable than DJ's

Confirmed live: a direct `GET .../buscar` — even with a fresh session and no prior navigation —
returns a bare HTTP 401 (no JSON body). The fix is the SAME as DJ's: `goto` the product's own UI
page (`https://www2.sii.cl/carpetatributaria/cteregular`) **then pace** before the GET. This
succeeded 3 times independently during the initial exploration (once via a real Playwright-driven
browser click on "Consultar" in the actual UI, twice via direct `requestJson` calls with 500ms and
1000ms pacing).

**However**, after roughly 10 requests against this same endpoint within a ~20-minute window
(exploration + the final pre-close live verification), the SAME bootstrap sequence — including one
attempt with a deliberately generous 3000ms pace — started failing with the identical bare-401
shape, consistently, across two separate fresh sessions. Per this project's hard rule (never retry
against a possible rate-limit/block), the retries stopped there rather than escalate further.

**Open question, NOT resolved in this session:** whether this is (a) a genuine per-account/
per-IP soft rate-limit specific to the `carpetatributaria` product (its landing page loads
`queueclient.min.js`/`queueconfigloader.min.js` — Queue-It virtual-waiting-room scripts — which no
other facade in this codebase has observed on its target host, suggesting this SII product may be
more aggressively load-managed than DJ/RCV/F22/etc.), or (b) an unrelated transient SII-side issue
that would have cleared with a longer cool-down than this session had time to test. **Re-verify
live in a future session, spaced out over a longer window (not back-to-back calls), before relying
on this facade for a time-sensitive audit.** The wire contract itself (below) is NOT in doubt — it
was captured cleanly 3 times before the failures started — only the endpoint's tolerance for
repeated calls in a short window is unconfirmed.

## Endpoints (all GET, read-only)

Base: `https://www2.sii.cl/app/cte-api-carpetatributaria/<rut8dv>/recurso/v2/carpeta-tributaria/`
(RUT is the full canonical string, e.g. `a real taxpayer account`, a URL path segment — same convention as DJ).

### `filtros` — GET, no params

```
GET https://www2.sii.cl/app/cte-api-carpetatributaria/<rut>/recurso/v2/carpeta-tributaria/filtros
```

Response (observed live):

```json
{
  "instituciones": [
    { "enfinCodigo": "016", "enfinDescripcion": "BCI - BANCO DE CREDITO E INVERSIONES", "enfinAbreviacion": "BANCO BCI" },
    { "enfinCodigo": "009", "enfinDescripcion": "BANCO INTERNACIONAL", "enfinAbreviacion": "BANCO INTERNACIONAL" },
    { "enfinCodigo": "000", "enfinDescripcion": "OTRA INSTITUCIÓN", "enfinAbreviacion": "OTRA INSTITUCIÓN" }
  ],
  "agnos": [ { "id": 1, "value": "2026" }, { "id": 2, "value": "2025" } ],
  "nombreCn": "Empresa A SpA"
}
```

**Not built into the facade** — this is UI metadata (which years/institutions HAVE data, own
name) rather than the historial itself; low standalone audit value. The `agnos` list is
redundant with what a caller can already see by reading `buscar`'s own `carpFechaGeneracion`
values. Flagged as a possible follow-up if institución-filtering (see below) is ever added.

### `buscar` — GET, optional `agno` query param

```
GET .../carpeta-tributaria/buscar               → EVERY año (14 rows observed for this taxpayer)
GET .../carpeta-tributaria/buscar?agno=2026      → one año (10 rows observed)
GET .../carpeta-tributaria/buscar?agno=2025      → one año (4 rows observed)
```

**Omitting `agno` returns every año** — confirmed live (14 = 10 + 4, matching the per-year
counts). The facade defaults to this (the full historial) rather than requiring a year.

An **`institucion` filter is NOT modeled** — the UI's institución `<select>` binds to a
Vue-managed object (not a plain string value observable via native DOM inspection in the time
available), so the exact query param name/value for institución filtering was **not confirmed
live** and is therefore not implemented (ADR-004: no inventing an unobserved param). `agno` alone
already returns the full row set; a caller can filter by institución client-side.

**Response — a BARE JSON ARRAY**, one entry per issued dossier:

```json
[
  {
    "carpetaTributaria": {
      "carpRutContribuyente": 77777777, "carpDvContribuyente": "7",
      "carpCodigoRepositorio": 30000001, "carpClaveCarpeta": "XXXXXXXXXX", "carpCodigoBarras": " ",
      "carpFechaGeneracion": "2026-01-20", "carpNombreArchivo": "Carpeta_77026694.pdf",
      "carpNombreReceptor": "Empresa A SpA",
      "carpRutReceptor": 77777777, "carpDvReceptor": "7",
      "carpEstado": 1, "carpTipo": 1, "enfinCodigo": "000",
      "carpCodigoXml": 0, "carpComentario": null,
      "carpUnidadFuncionario": null, "carpRutFuncionario": 0, "carpDvFuncionario": null,
      "carpFechaAnulacion": null,
      "carpOtraInstitucion": "1", "carpNombreOtraInstitucion": "1",
      "carpFechaVencimiento": "2027-01-20",
      "carpParametros": "{\"representanteLegal\":true,\"conformacionSociedad\":true,\"participacionSociedad\":true,\"sucursales\":true,\"ultimosDocumentosTimbrados\":true,\"observacionesTributarias\":true,\"anotacionesVigentes\":true,\"propiedadesYbienesRaices\":true,\"boletaHonorarios\":true,\"boletaTerceros\":true,\"periodoFormulario29\":36,\"periodoFormulario22\":3,\"periodoBte\":12,\"periodoBhe\":12,\"declaracionesJuradas\":1,\"agentesRetenedores\":1,\"periodoCarpetaTributaria\":365}",
      "dlInicioVigencia": "2026-01-20", "dlUltimaModificacionVigencia": "2026-01-20", "dlFinVigencia": null
    },
    "enfinDescripcion": "OTRA INSTITUCIÓN", "enfinAbreviacion": "OTRA INSTITUCIÓN",
    "revCantidad": 0, "revFechaUltimaRevision": null
  }
]
```

- **`carpNombreReceptor`/`carpRutReceptor`/`carpDvReceptor` can be a THIRD PARTY** — observed
  live: several rows addressed to "MARTHA INDIRA PULIDO MENDEZ" (a natural person's own RUT and
  full name), not the taxpayer, presumably a bank contact the dossier was generated for. This is
  genuine third-party PII and is surfaced explicitly (declared at every surface — CLI help, MCP
  tool description), the same posture as `peticiones_list`, NOT dropped: knowing who has a copy
  of your own tax dossier is the core audit value of this facade.
- **`carpEstado`**: only `1` and `3` observed live (no authoritative label found for either in
  this session — the UI shows a "Vigente"/"No Vigente" toggle over the same list, suggesting `1`
  = Vigente, but this was NOT confirmed by reading an authoritative code table, so it is passed
  through verbatim, no closed enum, no label attached (ADR-004)).
  - One row observed with `carpEstado: 3` also had `carpFechaAnulacion` SET (a real date) —
    consistent with `3` meaning "anulada", but again not asserted as a rule.
- **`carpParametros`** is a **JSON-ENCODED STRING**, not a nested object — the facade parses it.
  Only observed for `carpTipo: 1` ("Solicitar Credito" per the UI); the key set for other tipos
  (e.g. "Personalizada") is unconfirmed, so parsing is tolerant (any boolean/number/string/null
  value under any key), not a closed shape.
- **`carpCodigoRepositorio`** is what the UI labels "Código Carpeta"; **`carpClaveCarpeta`** is
  "Clave Carpeta" — two different identifiers, both kept.
- **`carpUnidadFuncionario`/`carpRutFuncionario`/`carpDvFuncionario`** (an SII staff member, if
  one touched the record) were `null`/`0` in every observed row — kept verbatim, unconfirmed with
  a populated value.
- No `errorMsg`/`error`/`estado` wrapper field was ever observed — the response is JUST the array.
  **No business-error envelope shape is known for this endpoint.** A caller whose GET returns
  something other than a JSON array gets a generic `CarpetaTributariaError`, never a specific
  business-error interpretation (nothing to interpret was ever observed).

## What was deliberately NOT touched (hard rule: solo lectura)

- `Generar Carpeta Tributaria Regular para Créditos` / `Generar … Personalizada` — creates a NEW
  dossier. A write action with real-world consequence (an official document is issued, likely
  counted against some usage/quota). Never submitted.
- The "Anular" action visible on the historial page itself (the page's own text: *"Podrás anular
  aquellas carpetas tributarias regulares que se encuentren en estado vigente"*) — never clicked,
  never any request sent toward whatever endpoint backs it.
- `Revisar Carpeta Tributaria Regular Recibida` (`cterevisar`) — a DIFFERENT read (dossiers
  received FROM someone else) — not explored this session, flagged as a follow-up.
- "Ver PDF inicial" / "Ver en Línea" links on the historial rows — likely PDF downloads; this
  project has no binary-response seam yet (`docs/BACKLOG.md` §4 already notes this as a general
  gap, not specific to this facade) — not investigated.

## PII posture

Own-identity fields (`carpRutContribuyente`/`carpDvContribuyente`) are dropped as redundant with
the task's own `rut` result field (always the session principal, same convention as DJ). Receptor
fields (`carpNombreReceptor`/`carpRutReceptor`/`carpDvReceptor`) are a genuine third-party PII
exposure when the dossier was addressed to an institution contact rather than the taxpayer itself
— surfaced deliberately with an explicit stated exposure at every surface (CLI help text, MCP tool
description), same posture as `peticiones_list`. No `raw` — every observed field is curated by
name; nothing extra to drop.

## Open / TBD

- **Endpoint reliability under repeated calls**: see the load-bearing section above — re-verify
  live, spaced out, before depending on this facade for time-sensitive work.
- **Institución filtering**: query param name/shape unconfirmed (Vue-object-bound select).
- **`carpEstado` code meanings**: `1`/`3` observed, no authoritative label confirmed.
- **`Revisar Carpeta Tributaria Regular Recibida`** (dossiers received, not issued): not built.
- **Represented-empresa reach**: not tested (same caution as DJ/F22/F29/BTE/BPST/Notificaciones).
- **`carpParametros` key set for `carpTipo` other than `1`**: unconfirmed.
