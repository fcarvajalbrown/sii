# SII wire contract — Detalle de una Declaración Jurada (DJ 1926 balance/RLI, and generically any DJ)

> Extends `docs/sii-contract/dj-status.md` (ADR-030) — read that first for the host, the
> bootstrap+pace requirement (applies here too), and the `www2.sii.cl/app/djconsulta/` REST family.
> This doc covers TWO further endpoints in the SAME family, captured live 2026-08-03,
> a real taxpayer account, DJ 1926 ("Sobre Base imponible de primera categoría y datos contables
> balance" — this is the taxpayer's real form title; it is what SII itself calls the RLI+balance
> form. `NEXT-SPIKES-PLAN.md`'s original candidates 2/3 assumed separate "DJ 1943" and "DJ 1926"
> forms — DJ 1943 does NOT appear in this taxpayer's DJ list at all; **1926 alone carries both the
> RLI breakdown and the 8-column balance**, closing both candidates with one facade).

## Discovery method

Endpoint NAMES were found by fetching the SPA's own JS bundle
(`www2.sii.cl/djconsulta/assets/index-*.js`, a public static asset) and grepping it for
`recurso/v1/` string literals — safe, read-only, no login-wall risk. The exact REQUEST SHAPE for
the two endpoints below was then confirmed by patching `window.fetch`/`XMLHttpRequest.prototype`
via `session.evaluate` (capturing the SPA's own real outgoing requests) and clicking the real "DJ
1926 → Aceptada" link in the live UI — NOT by guessing from the minified bundle alone. The `detalle`
endpoint's exact body was inferred from the minified bundle's call site then confirmed live by
sending it directly and getting a real, complete, structured response on the first attempt.

## Endpoint 1 — `getDjIntegralAnualDetalle`: presentation history per DJ for one año

```
POST https://www2.sii.cl/app/djconsulta/<rut>/recurso/v1/dj/getDjIntegralAnualDetalle
Content-Type: application/json
Referer: https://www2.sii.cl/djconsulta/consultaddjjs

{"periodo": 2025}
```

**`periodo` here is a NUMBER, not a string** — the OPPOSITE convention from
`getDjIntegralAnual` (ADR-030), which requires a string. Confirmed live by capturing the SPA's own
real request body. Cite this contrast explicitly — it is exactly the kind of silent, easy mistake
this project's wire-contract docs exist to prevent.

Response: one entry per DJ the taxpayer has ANY history for in that año (not just the ones with a
CURRENT filing — anuladas/superseded folios appear too, each as a `result[]` entry):

```json
{
  "data": [
    {
      "id": 122399351,
      "titulo": "Sobre Base imponible de primera categoría y datos contables balance",
      "dj": 1926,
      "result": [
        {
          "key": 122399351,
          "codEstado": 2,
          "estado": "Aceptada",
          "fecha": "2025-05-07T20:37:16",
          "mes": null,
          "mesNombre": null,
          "folio": 599782,
          "medioPresentacion": "Formulario Electrónico",
          "tipoDeclaracion": "Rectificatoria",
          "casos": 0
        },
        {
          "key": 122399187,
          "codEstado": 3,
          "estado": "Anulada",
          "fecha": "2025-05-07T20:28:03",
          "mes": null,
          "mesNombre": null,
          "folio": 599626,
          "medioPresentacion": "Formulario Electrónico",
          "tipoDeclaracion": "Original",
          "casos": 0
        }
      ]
    }
  ],
  "errorMsg": null
}
```

This is a REAL, live-observed rectificatoria: DJ 1926 for AT2025 (this taxpayer) was originally
filed (folio 599626), then ANULADA the same day and re-filed as folio 599782 (`tipoDeclaracion:
"Rectificatoria"`), both timestamped 2025-05-07. `key` is the identifier `getDjDetalle`/`detalle`
(endpoint 2) needs to fetch that SPECIFIC presentation's content — it is NOT the same across
`result[]` entries for the same DJ (contrast the DJ-family-level `id`, which IS stable). `estado`
values observed: `"Aceptada"`, `"Anulada"` (plus `"Observada"` from `dj-status.md`) — `codEstado`
is a small integer code alongside it (2=Aceptada, 3=Anulada observed) — pass both through
verbatim, no closed enum asserted for either. `mes`/`mesNombre` are null for this ANUAL DJ; likely
populated for a mensual one (`getDjIntegralMensualDetalle`, NOT captured — same family, not yet
built).

## Endpoint 2 — `detalle`: the actual form CONTENT (the balance/RLI figures themselves)

```
POST https://www2.sii.cl/app/djconsulta/<rut>/recurso/v1/dj/detalle
Content-Type: application/json
Referer: https://www2.sii.cl/djconsulta/consultaddjjs

{
  "periodo": "202500",
  "dj": 1926,
  "key": 122399351,
  "pagina": 1,
  "seccion": 1,
  "tipoConsulta": 1,
  "rut": "77777777",
  "dv": "7"
}
```

Field notes (decoded from the SPA's minified client + confirmed live):

- **`periodo` for an ANUAL DJ is `<año>` + `"00"`** as a STRING (e.g. año 2025 → `"202500"`) — A
  THIRD distinct `periodo` convention in this same endpoint family (contrast endpoint 1's bare
  number, and `dj-status.md`'s plain 4-digit string). The SPA's client code branches on
  `mensual`/`anual` mode: mensual sends `<año><mes 01-12>`, anual sends `<año>00`. Only the ANUAL
  form was exercised live.
- **`key`**: the SPECIFIC presentation's key from endpoint 1's `result[].key` — NOT the
  DJ-family-level `id`. For a taxpayer with no rectificatoria, `key` and `id` will likely be
  identical (unconfirmed — this taxpayer's only observed case had a rectificatoria, where they
  legitimately differ: `id:122399351` = family, `key:122399351` = the CURRENT vigente
  presentation in this instance, coincidentally equal here; the ANULADA sibling has its own
  `key:122399187`).
- **`pagina`**: 1-based (matches `dj-status.md`'s sibling endpoints' convention, NOT BPST's).
  Only page 1 was exercised — pagination behavior beyond page 1 is UNCONFIRMED.
- **`seccion`**: the SPA's own code defaults this to `1` when unset
  (`(k.value==null||k.value=="")&&(k.value=1)`, decoded from the bundle). Sending `1` returned
  ALL THREE of this DJ's named sections in one response (see below) — so `seccion` may select a
  different agrupación the UI shows one-at-a-time client-side rather than a server-side filter;
  UNCONFIRMED whether a different `seccion` value changes the response at all. Treat `1` as the
  only value needed until proven otherwise.
- **`tipoConsulta`**: sent as `1`; semantics unconfirmed (possibly "propia" vs. "de terceros" —
  mirroring the "Consulta Estado de terceros" menu item found during the Spike 1 exploration, per
  `NEXT-SPIKES-PLAN.md`). Only `1` was exercised.
- **`rut`/`dv`**: sent SPLIT (unlike the URL path's combined form) — `"77777777"` + `"7"`.

### Response shape — a RENDER-ORIENTED nested table, not a flat códigos array

```json
{
  "data": {
    "listDetalle": {
      "<nombre de sección, e.g. \"Seccion B\">": {
        "<nombre de tabla, e.g. \"detalle2\">": {
          "tabla": {
            "<fila índice, e.g. \"02\">": {
              "fila": {
                "<columna índice, e.g. \"04\">": {
                  "colspan": 1,
                  "rowspan": 1,
                  "value": "221.784.466",
                  "conBordeSuperior": true,
                  "esParteDeSpan": false,
                  "ancho": { "tipoAncho": "px", "valor": 100 },
                  "largoColumna": 50,
                  "style": "fw-valorCampo",
                  "contactoRut": false
                }
              },
              "tipoCelda": "dato",
              "ultimaCelda": 6
            }
          }
        }
      }
    }
  },
  "errorMsg": null
}
```

**This is SII's own UI-rendering table description, not a semantic data model.** There is no
`{codigo, valor}` shape to parse — instead, a tree of named sections → named sub-tables → indexed
rows → indexed cells, where EVERY cell (header or data) carries the same shape. Rows are
classified by `tipoCelda`: `"cabecera"` (a header/label row — its cells' `value`s are COLUMN
LABELS, e.g. `"Monto del ajuste"`, `"Tipo de Ajuste"`, `"Estado"`) vs. `"dato"` (an actual data
row — its cells' `value`s are the real figures, aligned by column position to the nearest
preceding `"cabecera"` row in the SAME table). Montos are Chilean dot-formatted strings (e.g.
`"221.784.466"`) exactly like F22/BTE/BPST — parse es-CL, but ONLY where the caller has confirmed
(by reading the aligned header label) that a given column IS a monto; other columns hold codes,
descriptions, or free text and must NOT be blindly coerced to a number.

**Live example, DJ 1926 "Seccion B" (`B: DETERMINACIÓN DE LA BASE IMPONIBLE DE PRIMERA
CATEGORÍA`), this taxpayer, AT2025** — header row (`tipoCelda:"cabecera"`) columns:
`N°, Conceptos y/o Partidas que componen la RLI, Id. Cuentas según Clasificador de cuentas,
Descripción del ajuste practicado, Monto del ajuste, Tipo de Ajuste` (+ a 6th, `Estado`, decoded
separately per the group's own header cell). First two `"dato"` rows observed:

| N° | Concepto/Partida | Id. Cuenta | Descripción del ajuste | Monto del ajuste | Tipo | Estado |
|---|---|---|---|---|---|---|
| 1 | 0 | (blank) | (blank) | 221.784.466 | 9 | No Observada |
| 2 | 1.678 | 5.01.12.00 | PAGO IMPUESTO A LA RENTA | 125.630.198 | 1 | No Observada |

Three sections observed for THIS DJ (1926): `"Folio Renta Líquida Imponible o Pérdida
Tributaria"` (1 sub-table, 2 rows — the headline RLI/pérdida folio figure), `"Seccion B"` (the RLI
determination breakdown above, 12 rows), `"Seccion C"` (3 rows, content NOT individually
inspected in this capture — same table shape, presumably the balance's own columns). Total
response size for this taxpayer/año: 24.4 KB.

### `contactoRut` — SII's own PII flag, honor it

Every cell carries a `contactoRut: boolean` field. **None were `true`** in this taxpayer's DJ 1926
capture (a pure balance/RLI form has no counterparty RUTs to show) — but DJ 1948 (retiros,
remesas, dividendos — a per-socio distribution list) almost certainly will, given its content.
**The facade MUST redact (drop `value`, keep the flag) any cell where `contactoRut: true`** —
this is SII's OWN signal for exactly the kind of PII this codebase already denylists by hand
elsewhere (F22 identity códigos, BTE/BPST own-identity fields); here SII hands us the flag
directly, so honor it rather than re-deriving an equivalent denylist.

## Error envelope

Not captured for a failure case in this spike (every call succeeded on a well-formed request) —
inherit the SAME envelope shape as `getDjIntegralAnual` (`docs/sii-contract/dj-status.md`:
`errorMsg`-keyed business error, or a DIFFERENT `error`-keyed malformed-request shape) until a
live failure is observed for these two endpoints specifically. Treat any envelope shape this
project has not seen as an unrecognized-envelope `DjError`, same posture as endpoint 1.

## Open / TBD

- **`pagina` beyond `1` — CONFIRMED real (2026-08-05, DJ 1887 AT2025, this taxpayer).**
  `pagina:2` returns a genuinely DIFFERENT slice of rows (verified: the row identifier at column
  `00` and every monto differ from página 1 — not a repeat). `dj detalle` already exposes
  `--pagina`; nothing to build, just confirming the CLI flag reaches real, distinct data.
- **`seccion:2` also returns different content from `seccion:1`** for DJ 1887 (same live check) —
  contrary to the earlier hedge ("may be a client-side filter"). Still unconfirmed whether `2` is
  the LAST meaningful value or whether the sequence continues; not exhaustively paginated in this
  check.
- **DJ 1879 (honorarios, Art. 42 N°2/48) and DJ 1887 (sueldos, Art. 42 N°1) — LIVE-VALIDATED
  2026-08-05, this taxpayer, AT2025.** Both render with the SAME faithful nested-table shape as DJ
  1926, each with its OWN distinct column layout, confirming the design note below was correct to
  not hardcode DJ 1926's columns:
  - DJ 1879 headers observed: `Rut Receptor De La Renta`, `Monto Retenido Anual Actualizado`,
    `Honorarios Y Otros (Art.42 N° 2)`, `Remuneracion de Directores (Art. 48)`, month columns
    ABR–DIC, tasa columns (`13.75%`/`10%`/`35%`).
  - DJ 1887 headers observed: `Rut De La Persona A Quién Se Le Pago La Renta (Trabajador)`,
    `Renta Total Neta Pagada (Art.42 N°1, LIR)`, `Impuesto Único de Segunda Categoría Retenido`,
    `Horas semanales pactadas...`, monthly income columns Enero–Diciembre.
  - **Despite both DJs having a header column literally named "Rut Receptor…"/"Rut De La
    Persona…", every observed data cell in that column for THIS taxpayer's submission held only
    `"X"` or `""` (a category marker), never an actual RUT — and `contactoRut` was `false` on
    EVERY cell in both DJs' full response (0 `true` out of 230 / 380 cells checked).** This
    appears to be an aggregated/summary reporting shape (by month + tasa/tramo) for this
    taxpayer, not a literal per-worker row list — `casos` in `dj historial` (4 for 1879, 84 for
    1887) does NOT mean 84 individual rows are returned here. Do not assume `contactoRut` is
    "broken" from this observation alone — it correctly reflects THIS shape; a taxpayer whose
    informante software submits literal per-worker rows (or a different `pagina`/`seccion`) may
    still show `contactoRut:true` and must still be redacted. This closes the honorarios/sueldos
    piece of `docs/ESTADO-CONSOLIDADO.md` §1.1 item **E**.
- **`key` vs. `id` divergence**: only observed to differ when a rectificatoria exists. Unconfirmed
  whether `id` alone (without first calling endpoint 1 for the real `key`) would work — TREAT
  ENDPOINT 1 AS A REQUIRED PRECEDING CALL until proven unnecessary.
- **Monthly DJ (`getDjIntegralMensualDetalle`)**: same family, same likely shape, NOT captured.
- **Column semantics per DJ number**: OBSERVED now for DJ 1926, 1879, 1887 — three different
  layouts confirmed, validating the rule below. A DJ not yet observed (1948, …) may still differ;
  the facade must not assume any of these three layouts applies elsewhere; read each DJ's own
  header row at call time.
