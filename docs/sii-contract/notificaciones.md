# SII wire contract — Notificaciones / Correspondencia (Mi SII `CViewCarta.cgi`)

> **Ground truth (once built):** the authoritative source is the cited code in
> `packages/core/src/portal/notificaciones.ts` + the host in core config (ADR-004 inline
> `// observed …` citations). This doc is the curated synthesis. Values below are from a live
> capture, 2026-08-03, a real taxpayer account (Empresa A SpA) — the taxpayer's own
> real data, kept because it is the only live-observed example.

**Status:** first observation of this SII product in this codebase (ADR-032). Captured live,
read-only (no form submitted that mutates anything — every request below is `opc` in
`{40,41,42}`, all read/consulta operations).

## What this is

Mi SII's own inbox of **formal notifications** ("Mis Notificaciones Vigentes" — citaciones,
liquidaciones, resoluciones — anything the audit-motivating question "¿hay una citación Art. 63
vigente o reciente?" needs) and **informal correspondencia** (cartas, avisos, emails SII sent —
e.g. "Petición administrativa recibida"). This is the surface `docs/NEXT-SPIKES-PLAN.md`
candidate 4 targeted; it closes the audit gap `docs/audits/2026-07-29-empresa-a-bpst-fix.md`
and `f22 historial` left open ("no `fechaCitacion` in the F22 historial" is not proof no citación
exists via another channel).

## A SEVENTH wire shape — Mi SII's OWN legacy JSON CGI, distinct from all six already in this codebase

| # | Pattern | Host | Primitive |
| --- | --- | --- | --- |
| 1 | SDI-JSON (RCV/F22/F29) | `www4.sii.cl` | `requestJson` |
| 2 | Inline-JS-map (BTE/BHE) | `loa.sii.cl` | `goto`/`evaluate` |
| 3 | Form-POST → HTML (BPST) | `zeus.sii.cl` | `requestForm` |
| 4 | GWT-RPC (peticiones) | `www3.sii.cl` | `requestText` |
| 5 | Public HTML (DTE authorized) | `palena.sii.cl` | `requestPublic` |
| 6 | REST JSON, RUT-in-path (DJ) | `www2.sii.cl` | `requestJson` |
| 7 | **Form-POST → JSON (this doc)** | **`misiir.sii.cl`** | **`requestForm` — urlencoded `opc=<n>` request, JSON response, parsed by the facade (not `requestJson`, which expects a JSON REQUEST body)** |

The envelope (`{estado, glosa, data, metaData}`) is DISTINCT from every envelope already in this
codebase: not the SDI `respEstado` family, not DJ's flat `{data, errorMsg}`.

## Why this, not the GWT app at `corenoti1Internet` — a correction of a prior hypothesis

`docs/audits/2026-08-03-spike4-notificaciones-progress.md` (an earlier session) found that Mi
SII's `linkexterno(4)` resolves to `https://www4.sii.cl/corenoti1Internet/#menu`, a GWT-compiled
app (`.nocache.js` + `<hash>.cache.js`), and reasonably hypothesized this was the notifications
READ surface — the same technology `peticiones` (ADR-020) uses.

**This was wrong, and the correction is important enough to record precisely.** Reading Mi SII's
own `misii.min.js` (`https://misiir.sii.cl/misii/js/misii.min.js`, fetched live and grepped
2026-08-03) shows `linkexterno(4)`'s real trigger, verbatim:

```html
<a href='javascript:linkexterno(4)'
   title='Solicitar, actualizar o revocar correo para notificaciones.'>
```

"Solicitar, actualizar o revocar correo para notificaciones" — that GWT app manages **which email
address receives notification alerts**. It is a WRITE/configuration flow, unrelated to reading
notification content. The actual READ surface for "Mis Notificaciones Vigentes" is a plain link in
the SAME page firing `call_option(201)`:

```html
<span><a href='javascript:call_option(201)' target='_self'>Mis Notificaciones Vigentes</a></span>
<span>Notificaciones de Caracter formal que el SII le ha enviado</span>
```

`call_option(201)` → `callajaxJson(params, opt)` with `opt=201` → the `case 201:` branch (source:
`misii.min.js`, function containing the switch, ~line 4156) POSTs `opc=41&VIEW=1` to
`CViewCarta.cgi`. **No GWT decoder was needed.** The decoder machinery built for `peticiones`
(ADR-020, `portal/gwt.ts` + `gwt-schema.ts`) is NOT reused here — this module has nothing to do
with GWT-RPC.

## Endpoints

Base: `https://misiir.sii.cl/cgi_misii/CViewCarta.cgi` (same host as `HOSTS.miSii`, which serves
`siihome.cgi` — the two live under the same `misiir.sii.cl` origin, same session cookie).

**No bootstrap `goto` is required** (unlike DJ, ADR-030): a cold `requestForm` POST — with no
prior navigation on the session at all — returned a real result on the first call, verified live
by removing every prior `goto` from the reproduction script and re-running it. `misiir.sii.cl`
already carries the `.sii.cl` SSO cookie from `withSession`'s restore.

### List — `opc=41` (Notificaciones formales) / `opc=40` (Correspondencia)

```
POST https://misiir.sii.cl/cgi_misii/CViewCarta.cgi
Content-Type: application/x-www-form-urlencoded

opc=41&VIEW=1     (formal notifications — "Mis Notificaciones Vigentes")
opc=40&VIEW=1     (informal correspondencia — cartas/avisos/correos)
```

**Response, empty (observed live, `opc=41`, this taxpayer has none):**

```json
{ "estado": 1403, "glosa": "No existen registros", "data": [], "metaData": null }
```

`estado: 1403` + `glosa: "No existen registros"` is a **legitimate absence**, not an error — same
"absence is not an error" posture as every other facade in this codebase. This result itself
answers the audit's core question for this taxpayer: **no formal notification is on file.**

**Response, success with rows (observed live, `opc=40`, 14 real rows):**

```json
{
  "estado": 0,
  "glosa": "OK",
  "data": [
    {
      "id": "5790241",
      "descripcion": "Petición administrativa recibida",
      "fecha": 1629864000000,
      "periodo": null,
      "tipo": "4",
      "descTipo": "MAQUINA",
      "origen": "EMAIL",
      "tipoNotificacion": "Correo Electrónico"
    }
  ],
  "metaData": {
    "conversationId": "DQEJG40U6IUYV",
    "transactionId": "250",
    "namespace": "cl.sii.sdi.lob.comun.ancoarsii.data.impl.AncoArsiiApplicationService/getCorrespondencia",
    "info": null,
    "errors": null,
    "page": { "fullSize": 14, "currentPageIndex": 1, "pageSize": 1000, "lastPageIndex": 1 },
    "sorts": [{ "sortColumn": 3, "sortDirection": "ASC" }]
  }
}
```

- `id`: a numeric id AS A STRING in the list response (contrast the detail request below, where
  the SAME value is sent back as `repoId`). Facade converts to number for the curated type; kept
  as the SII-observed string in this doc.
- `fecha`: **epoch milliseconds** (client-side JS does `format(array[i].fecha, "dd/MM/yyyy")`) —
  pass through verbatim as a number (CONVENTIONS: "no human formatting" in the core; the CLI
  `--human` renderer converts for display).
- `tipo`: a small SII-internal code (`"2"`, `"4"`, `"8"`, `"9"` seen referenced in the client JS
  controlling icon choice / pagination behavior). **No decode table is asserted** — this
  codebase has not observed SII's own meaning for every code, so `tipo` passes through verbatim
  (ADR-004; do not invent a mapping).
- `tipoNotificacion` / `descTipo`: SII's own human labels, self-describing, pass through verbatim.
- `origen`, `periodo`: observed present (correspondencia) but `null` in every real row seen; kept
  in the curated shape for forward compatibility, not asserted meaningful.
- `metaData.page`: pagination info — `pageSize: 1000` in the observed capture covered all 14 rows
  in one call; **pagination beyond one page has NOT been observed live** (this taxpayer has under
  1000 rows of either kind). If `page.currentPageIndex < page.lastPageIndex`, more pages likely
  exist — not yet confirmed how to request page 2 (no page/offset param observed in the client JS
  for this specific call; `ShowGrid2Pages`/other generic grid helpers in `misii.min.js` may apply
  but were not exercised). **Open item**, flagged in the facade's result shape (`masPaginas`) not
  silently assumed complete.

### Detail — `opc=43` (Notificación formal) / `opc=42` (Correspondencia)

```
POST https://misiir.sii.cl/cgi_misii/CViewCarta.cgi
Content-Type: application/x-www-form-urlencoded

opc=42&MODE=<tipo>&repoId=<id>&rnd=<random-float>     (correspondencia detail)
opc=43&MODE=<tipo>&repoId=<id>&rnd=<random-float>     (notificación formal detail)
```

`MODE` = the row's `tipo` value (as a bare string/number, not the key name `tipo`); `repoId` = the
row's `id`; `rnd` = `Math.random()` client-side — cache-busting only, any value works (SII does
not appear to validate it; kept as a random float for parity with the observed client, but not
confirmed load-bearing).

**Response, success (observed live, `opc=42`, id=5790241, tipo=4):**

```json
{
  "estado": 0,
  "glosa": "OK",
  "data": {
    "from": null,
    "to": "admin@empresa-a.example",
    "asunto": "Petición administrativa recibida",
    "adjunto": [],
    "body": "<html>...</html>"
  },
  "metaData": {
    "conversationId": "DQEJG40U6IUYV",
    "transactionId": "250",
    "namespace": "cl.sii.sdi.lob.comun.ancoarsii.data.impl.AncoArsiiApplicationService/obtenerDetCorr",
    "info": null, "errors": null, "page": null, "sorts": null
  }
}
```

- `body`: the full HTML of the letter SII sent — for the observed row, a rendered "hemos recibido
  su solicitud…" template EMBEDDING THE TAXPAYER'S OWN razón social ("DISTRIBUIDORA Empresa A
  SPA") and the destination email (`to`). This is OWN-identity PII, not counterparty PII — same
  category as `whoami`'s razón social/email exposure, not the BTE/BPST own+counterparty mixing
  problem. Surfaced with an explicit opt-in name and a stated exposure (mirroring `whoami`'s
  posture), not dropped — the letter body IS the value of this module (e.g. reading what a
  citación actually says).
- `adjunto`: an array of `{data, name}` where `data` is a BASE64-encoded file (the client renders
  it as a PDF `<embed>`/download link). **The facade does NOT surface the base64 payload** — it is
  arbitrarily large binary content, unsuited to a JSON tool result / LLM context, and not needed
  to answer "does a citación exist / what does it say" (the `body` HTML already carries the text).
  Curated to `{ nombre: string | null }[]` (count + names only) plus a `tieneAdjuntos: boolean`.
- `certificado`: observed ABSENT (not merely `null`) in every captured response — the client code
  checks `data.certificado` (note: TOP-LEVEL of the envelope, sibling to `data`/`estado`, NOT
  nested under `data.data`) but no real capture exercised a row that has one. Modeled as an
  optional top-level base64 string in the schema (tolerant `.loose()`), same non-surfacing
  decision as `adjunto` if ever populated — recorded here so a future observation with a real
  `certificado` does not require re-deriving this from scratch.
- **`opc=43` (notificación formal detail) was NOT captured with real data** — this taxpayer has
  zero rows in the formal-notifications list, so there is nothing to request a detail for. The
  facade assumes the identical envelope/field shape (same `viewComunicaciones()` client function
  handles both `noti=1` (formal, opc 43) and `noti=2` (correspondencia, opc 42) with the SAME
  success handler in `misii.min.js` — high confidence, not blind guessing) but this is flagged as
  **unconfirmed with real data** — re-observe live the first time a real formal notification is
  available for any taxpayer.

### Error envelope

| Condition | Signal |
| --- | --- |
| Success, rows present | `estado: 0`, `glosa: "OK"`, `data`: array (list) or object (detail) |
| Success, legitimately empty | `estado: 1403`, `glosa: "No existen registros"`, `data: []` |
| Anything else | **Not observed live.** Treated as `NotificacionesError` with SII's `glosa` verbatim (ADR-004: fail loud on an unrecognized envelope, never guess a meaning for an unobserved `estado` code). |

### PII posture

The list rows carry only own-account metadata (id, fecha, descripción, tipo codes) — no
counterparty PII, no denylist/curation trade-off, full row surfaced (same posture as DJ). The
DETAIL body is different: it is the taxpayer's OWN identity embedded in an HTML letter (own razón
social, own contact email) — surfaced deliberately (that content IS the point of this module),
with the base64 attachment/certificate payloads deliberately dropped (size/relevance, not a PII
concern). No `raw` — the curated shape already carries every field SII sends except the base64
blobs.

## Open / TBD

- **`opc=43` (formal notification detail) response shape**: inferred from shared client code, not
  observed with real data (this taxpayer has no formal notifications). Re-verify the first time a
  real one is available.
- **Pagination beyond one page** (`metaData.page.lastPageIndex > 1`): not observed; the facade
  surfaces `masPaginas: boolean` from the metadata rather than silently truncating, but does not
  yet know how to request page 2.
- **Represented-empresa reach**: not tested — this session was an empresa account (cannot
  represent anyone, ADR-005). Treat as session-keyed/self-only until confirmed otherwise, same
  caution as F22/F29/BTE/BPST/DJ.
- **`tipo` code meanings**: only the numeric codes are observed, not an authoritative decode
  table. `tipoNotificacion`/`descTipo` (SII's own human labels) are the reliable human-readable
  signal; `tipo` is kept verbatim for anyone matching against a future authoritative list.
