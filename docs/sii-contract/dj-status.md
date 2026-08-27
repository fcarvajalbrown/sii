# SII wire contract — Estado de Declaraciones Juradas (DJ)

> **Ground truth (once built):** the authoritative source is the cited code in
> `packages/core/src/portal/dj.ts` + the host in core config (ADR-004 inline `// observed …`
> citations). This doc is the curated synthesis. Values below are from a live capture,
> 2026-08-03 (system clock; the taxpayer session showed "hoy" as within año tributario 2026),
> a real taxpayer account — the taxpayer's own real DJ estado, kept because it is the only live-observed
> example.

**Status:** first observation of this SII product in this codebase (ADR-030). Captured live,
read-only (GET/POST navigation only, no form submitted), same session used throughout the prior
BPST spike (ADR-029).

## What this is

The consolidated "estado de declaraciones juradas" view — SII's own summary of which
Declaraciones Juradas (DJ) a taxpayer must file, and whether each one was accepted, observed, or
not yet presented, per año tributario. This is the DJ-equivalent of what `f22 status` already does
for the annual renta declaration, and is foundational for reading any specific DJ's CONTENT (e.g.
DJ 1926 — Balance Tributario 8 columnas, or DJ 1948 — retiros/remesas/dividendos): those spikes
need to know a folio/id first, which this endpoint already returns.

## A SIXTH wire shape — distinct from all five already in this codebase

| # | Pattern | Host | Primitive |
| --- | --- | --- | --- |
| 1 | SDI-JSON (RCV/F22/F29) | `www4.sii.cl` | `requestJson` |
| 2 | Inline-JS-map (BTE/BHE) | `loa.sii.cl` | `goto`/`evaluate` |
| 3 | Form-POST → HTML (BPST) | `zeus.sii.cl` | `requestForm` |
| 4 | GWT-RPC (peticiones) | `www3.sii.cl` | `requestText` |
| 5 | Public HTML (DTE authorized) | `palena.sii.cl` | `requestPublic` |
| 6 | **REST JSON, RUT-in-path (this doc)** | **`www2.sii.cl`** | **`requestJson`, but a plain REST body — no SDI envelope, no `facadeAdapterService` namespace** |

This is the cleanest wire shape observed so far in the project: no SDI envelope, no
`respEstado`/`metaData.errors` wrapper — a flat `{ data, errorMsg }` object.

## Reach — RUT embedded in the URL path (unconfirmed for represented empresas)

Unlike F22/F29/BTE/BPST (session-keyed, no RUT parameter at all), this endpoint's URL is
`.../djconsulta/<RUT>/recurso/v1/dj/...` — the RUT of the subject taxpayer is a PATH SEGMENT, not
implicit from the session. This LOOKS like it could be body-RUT (RCV-style: a representing persona
reaching a represented empresa's DJ by substituting the RUT), but **this was not empirically
confirmed** — the test session (an empresa account, which per ADR-005 cannot represent anyone) had
no represented RUT to substitute and verify against. **Treat as session-keyed / self-only until a
live spike confirms otherwise** (same caution `ARCHITECTURE.md`'s "Reach" section already
documents for F22/F29/BTE — this is an open item, not an assumption to build on).

## Endpoints

Base: `https://www2.sii.cl/app/djconsulta/<rut8dv>/recurso/v1/dj/` (note: `<rut8dv>` is the FULL
canonical RUT string with hyphen and DV, e.g. `a real taxpayer account` — observed verbatim in the URL, not
split into body+dv like the legacy CGIs).

### ⚠️ Load-bearing: a bootstrap navigation + a brief wait is REQUIRED before any POST

Confirmed live, twice, the hard way: `getDjIntegralAnual` **rejects a direct POST with a bare
HTTP 401** (no JSON body at all, even with a fresh session, the correct `Referer`, and correct
body shape) unless the caller FIRST navigates to the UI page
(`GET https://www2.sii.cl/djconsulta/consultaddjjs`) **and waits** before POSTing. The `www2.sii.cl`
djconsulta SPA does its OWN async session bootstrap on load (its network trace shows it pinging
`www2.sii.cl/app/session/status`) that the REST API silently depends on — a `goto` alone is not
enough because that bootstrap is asynchronous relative to the page load event.

Confirmed empirically: 0ms wait after `goto` → 401 every time; 500ms → succeeds consistently. The
production facade paces at the project's standard interval (1000ms @ 1 req/s default) for margin,
reusing the existing `Clock`-backed `pace()` primitive rather than a bespoke constant. This is the
SAME "bootstrap GET before the real call" shape BPST needed (ADR-029), but with an added TIMING
requirement no other facade in this codebase has needed before this one.

### `getPeriodo` — GET, no params

```
GET https://www2.sii.cl/app/djconsulta/<rut>/recurso/v1/dj/getPeriodo
```

Response: a bare JSON number (NOT an object) — the current año tributario, e.g. `2026`. Useful as
the default upper bound for `getDjIntegralAnual` below; not otherwise load-bearing.

### `getDjIntegralAnual` — POST, JSON body `{"periodo": "<YYYY>"}` (STRING, not number)

```
POST https://www2.sii.cl/app/djconsulta/<rut>/recurso/v1/dj/getDjIntegralAnual
Content-Type: application/json
Referer: https://www2.sii.cl/djconsulta/consultaddjjs   (sent; not confirmed required)

{"periodo": "2026"}
```

**The body field MUST be a JSON string, not a number** — `{"periodo": 2026}` (bare number) and
every other body shape tried (`[2026]`, bare `2026`, `{"anio":2026}`, `{"periodoAnual":2026}`)
returned `{"error":"Error en el formato del cuerpo de la solicitud. Verifique los tipos de datos
enviados."}`. Only `{"periodo": "2026"}` (string) succeeded. Cite this exact detail in the facade
— it is the single easiest thing to get wrong and silently fail on.

**Response, success:**

```json
{
  "data": [
    {
      "id": 134384543,
      "titulo": "Sobre Bienes Raíces Arrendados",
      "dj": 1835,
      "estados": { "2025": "Observada", "2026": "Aceptada" }
    }
  ],
  "errorMsg": null
}
```

- `data`: array, one entry per DJ FORM NUMBER the taxpayer has ANY obligation/history for within
  the 3-year window (see below) — NOT one entry per año. Each entry's `estados` map holds
  EVERY año tributario in the window that has a result; an año with NO obligation/filing for that
  DJ is simply ABSENT from the map (never a null value, never a zero-filled placeholder) — same
  "absence is not an error" posture as every other facade in this codebase.
- `estados` values observed live: `"Aceptada"` and `"Observada"`. **No third value observed** —
  do not assume a closed enum; a status string this codebase has not seen (e.g. a hypothetical
  "Rechazada" or "No Presentada") must pass through verbatim (ADR-004).
- `id`: an internal numeric identifier for the DJ-form-family row (NOT a folio of a specific
  presentation — it stayed constant across different `periodo` queries in testing). Its exact
  semantics are not confirmed; surface it verbatim, do not treat it as a folio.
- `dj`: the DJ form number (1835, 1847, 1879, 1887, 1926, 1948 observed live for this taxpayer) —
  this is the number a contador recognizes and searches by.
- `titulo`: SII's own glosa for the DJ, verbatim (includes trailing whitespace in at least one
  observed row — do not trim aggressively in a way that could mask a real SII typo/format quirk;
  a light `.trim()` for display is fine, but keep the original in mind if ever needed for
  matching).

**`periodo` is the END year of a ROLLING 3-YEAR WINDOW, not a single año filter** — confirmed
live by sweeping the parameter:

| `periodo` sent | años tributarios returned |
| --- | --- |
| `"2026"` | 2024, 2025, 2026 |
| `"2025"` | 2023, 2024, 2025 |
| `"2024"` | 2022, 2023, 2024 |
| `"2023"` | 2021, 2022, 2023 |
| `"2022"` | 2020, 2021, 2022 |
| `"2021"` | **ERROR** — `{"data":null,"errorMsg":"Se ha generado un error en getDjIntegralAnual"}` |

**A `periodo` below the backend's supported floor (observed: 2022 works, 2021 fails) returns an
ERROR, not an empty/clean result.** This is the load-bearing trap for this endpoint: unlike the
rest of this codebase's "empty is legitimate, never an error" convention, going OUT OF RANGE here
IS an error envelope (`data: null`, `errorMsg` set) — a caller that fans out over many years (as
`f22 status --years N` does) MUST catch this per-call and decide whether to treat it as "no data
this far back" (a soft stop) rather than surface it as a hard failure — cite this exact boundary
in the task and revisit if a future observation finds the true floor is earlier/later than 2022
(this may reflect SII's own DJ system data retention window, not a fixed constant — treat 2022 as
an OBSERVED floor for THIS capture date, 2026-08-03, not an assumed permanent constant).

### Error envelope

| Condition | Signal |
| --- | --- |
| Success, some DJ history in window | `data`: array (possibly listing DJ with only historical, non-current-year entries); `errorMsg: null` |
| `periodo` out of the backend's supported range | `data: null`, `errorMsg: "Se ha generado un error en getDjIntegralAnual"` |
| Malformed body (wrong type) | HTTP 200 (!) with `{"error": "Error en el formato del cuerpo de la solicitud. Verifique los tipos de datos enviados."}` — NOTE the field is `error`, not `errorMsg`, in this specific failure mode; a strict schema must tolerate both shapes or treat an unrecognized shape as a `DjError` (ADR-004: fail loud on an unrecognized envelope, never guess). |
| Path with a trailing extra segment (e.g. `/getDjIntegralAnual/2026`) | Falls through to a raw Spring-Boot 404 JSON (`{"timestamp","status":404,"error":"Not Found","path":"/djconsulta-ms/..."}`) — confirms the real backend service is named `djconsulta-ms`, reverse-proxied at `www2.sii.cl/app/djconsulta/`. Not a shape to build against; noted for context only. |

### PII posture

No counterparty PII in this payload at all — every field is either the taxpayer's OWN DJ
metadata (`dj`, `titulo`, `estados`) or an opaque internal `id`. No denylist/curation trade-off
like F22/BTE/BPST; the full row can be surfaced as-is. No `raw` needed (there is nothing extra to
drop).

## Open / TBD

- **Represented-empresa reach via the RUT-in-path**: not confirmed. Treat as session-keyed/self
  until a live spike with an operable represented empresa proves otherwise.
- **The `periodo` floor (2022 in this capture)**: may drift; re-observe if a future read hits the
  error for a `periodo` this doc currently expects to succeed.
- **`estados` values beyond `"Aceptada"`/`"Observada"`**: not observed. Extend documentation (not
  a closed enum in code) when a new value is seen.
- **`id`'s exact semantics**: appears stable per DJ-form-family across periods in this capture;
  not proven to be a folio of a specific presentation. Do not build a "consulta detalle de folio"
  facade on top of it without re-confirming live.
