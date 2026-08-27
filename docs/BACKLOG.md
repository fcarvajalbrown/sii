# Engineering backlog

Detailed, per-item view of what is **left to build**, with what is already known, what
blocks it, and where the observed facts live.

> **This file is subordinate to [`ROADMAP.md`](ROADMAP.md).** The roadmap remains the single
> source of truth for "is this shipped?" (one row per user-facing surface, ✅ on merge). This
> file carries the engineering detail the roadmap deliberately keeps out: spike plans, blocking
> decisions, unobserved contracts, and known limitations. When an item ships, tick the roadmap
> row and delete the entry here.

Last updated 2026-07-26, after the first live validation of the composite surfaces.

---

## 1. Blocked on a decision only the maintainer can make

### 1.1 Unattended `monitor` scheduling — needs its own ADR

`monitor` works, but must be invoked by hand. A scheduled sweep needs a live session, and only
`login` mints one with a human-typed Clave (ADR-006). Two paths, both real:

| Option | Cost |
|---|---|
| **Keyring** — implement the declared-but-unbuilt `SecretStore` Node adapter so `consoleLogin` can run unattended | A genuine loosening of ADR-006. Needs its own ADR + a new dependency (`keytar` / `@napi-rs/keyring`) |
| **Prompted daily run** | No posture change, but not truly unattended |

Also needed once decided: a `Notifier` seam (email/webhook). Deliberately not built yet — ADR-024
rejected it as speculative with no consumer.

**Nothing else in this file is blocked on this.**

---

## 2. Needs a live observation spike before any code (ADR-004)

### 2.1 `notificaciones` — citaciones Art. 63, liquidaciones (was P0)

**Routing is SOLVED** (spike 2026-07-25/26). Read from Mi SII's own `linkexterno()` table, not
guessed:

| Purpose | URL | Status |
|---|---|---|
| Notificaciones | `https://www4.sii.cl/corenoti1Internet/` | path **verified valid**, payload uncaptured |
| Expediente Electrónico (SEE) | `https://www4.sii.cl/seeui/see/internet` | path **verified valid**, payload uncaptured |
| Carta PDF | `https://www3.sii.cl/Coreca1Internet/MuestraPdf?codCarta=<n>` | **PROBADO EN VIVO 2026-08-06 (ADR-042) — FALLÓ.** `sii carta pdf` está construido (seam `requestBinary` + fachada + tarea + CLI), pero 3 `codCarta` reales devolvieron HTTP 500 (error genérico del framework, no "parámetro faltante"). La URL era una hipótesis desde `jwscarta`, nunca confirmada capturando el enlace real. Recapturar el enlace real (clic en una carta real desde Mi SII) antes de confiar en este comando. |

Facts established:

- `emin.sii.cl` in SII's link table is an **internal alias that does not resolve publicly**. The
  public host is `www4.sii.cl` — proven because the same table lists `propuestaf29ui` under
  `emin` while the working `portal/f29.ts` reaches that app on `www4`.
- Both target paths were **echoed back by the login wall as post-login destinations**, which a
  bogus path would not do.
- Mi SII's own `CViewCarta.cgi` (POST `opc=<n>`) is a **fifth wire shape**: `application/json`
  with a `{codigoError, descripcionError, sysdate, …}` envelope — *not* the SDI `respEstado` one.
  Needs its own zod schema; cannot reuse `rcv.ts`. Eight `opc` codes mapped (22 = régimen
  tributario, 33 = avisos, 112 = full contribuyente profile, 118 = compliance requirements,
  119 = carpeta tributaria, 28/27/114 = misc).
- Mi SII's Notificaciones accordion (`collapseComu01`) renders **empty** and fires no XHR — it is
  a stub, not the data source.
- The F22 historial's `codCarta` (`000406`, `000484`) is very likely the retrieval key for
  `MuestraPdf` — an observed link between two live surfaces.

**Remaining:** capture the `corenoti1Internet` payload, classify the shape, determine
body-RUT vs session-keyed **by testing, not assuming**, write `docs/sii-contract/notificaciones.md`,
then TDD the facade → task → surfaces.

**Priority note:** originally P0 to decide whether Art. 200 prescription was interrupted on
AT2019. The F22 historial already answers that indirectly — `fechaCitacion` is null on every
event of every filed year, and `idCarta` is null. Live validation then surfaced **three entirely
unfiled F22 years**, which are current, actionable exposures. So this is now a *confirmatory*
check rather than the critical path.

### 2.2 `dj` — Declaraciones Juradas 1943 / 1947 / 1948

**No endpoint observed. Spike required from zero.**

- Root cause of the open **F121** observación ("CONTROL DE LA PRESENTACION DE FORMULARIOS 1943"),
  so this is the module that explains an existing finding rather than producing a new one.
- **DJ 1948** (retiros, remesas, dividendos) is what would explain a capital-propio movement.
- Starting points: Mi SII links to `www.sii.cl/servicios_online/1043-*`; the `linkexterno()`
  technique from 2.1 is the proven way to resolve the real app URL from SII's own JS.
- Expect SDI-JSON (template `rcv.ts`) or GWT-RPC (template `peticiones.ts` + `gwt.ts`).
- **PII posture is non-trivial:** DJ 1948 carries partner/shareholder RUTs and per-person
  amounts. Follow the F22/BTE rule — **no `raw`**, tight allowlist.
- Almost certainly session-keyed. Confirm live.

---

## 3. Known contract gaps — code is correct but incomplete because SII was not observed

### 3.1 F29 débito component código — blocks half of `iva` (INVESTIGATED 2026-08-05, still open)

`iva` falls back to código **511** for crédito (observed live: it matched the RCV crédito
exactly). **Update (P3, 2026-08-05):** re-investigated live against six real months WITH
substantial ventas (a real taxpayer account, 2026-01 through 2026-06 — thousands of facturas/month; the
earlier "zero ventas in every period probed" note was stale). **538 is absent in every single one
of them regardless of ventas volume** — it is not a zero-sales artifact, this propuesta type
simply never sends it.

A candidate WAS found: código **502** matched código-33 (Factura Electrónica) ventas IVA EXACTLY
in two independent months (168.332.278 in 2026-06, 171.725.880 in 2026-05). But it is the **RAW**
figure — unlike 511 (already netted by SII on the crédito side), 502 does NOT subtract Notas de
Crédito emitidas. No código in the observed set reliably supplies that subtrahend: código `510`
looked plausible (same order of magnitude as the NC ventas IVA) but was off by 199.507 in June and
6.883 in May — close, not equal, so NOT the same figure. This taxpayer has ventas-side NC every
month observed, so there is no clean period to isolate `510`'s real meaning further.

**Consequence:** for any taxpayer whose propuesta lacks código 538, the débito verdict stays
`null` (indeterminable) rather than compared. **`COD_DEBITO_FALLBACK` stays deliberately EMPTY** —
wiring `502` alone would silently under-net every month by the NC IVA amount, reproducing on
débito the exact raw-vs-netted bug §3.5 fixed on crédito. Pinned by a test in `iva.test.ts` ("does
NOT fall back to código 502").

**To close:** either (a) a taxpayer/período where 538 IS actually observed, or (b) an unambiguous
NC-ventas-IVA componente código — ideally from a month with NO ventas-side NC, so `502` alone can
be checked against the (then trivially un-netted) RCV figure to confirm its meaning beyond doubt.

### 3.2 F22 código 1412 semantics — blocks the `honorarios` F22 delta

`1412` is named by observación **B92** and is **absent from `f22-codigos.ts`**. `honorarios`
surfaces it verbatim with `enTaxonomia:false` and deliberately computes **no delta** (ADR-023) —
asserting an unobserved rule is forbidden.

Live data point worth keeping: for commercial 2023, BHE recibidas totalled **408.067** honorarios
with retención **52.529**, the F29 código 151 total was **52.529** (exact match), while F22 código
1412 read **2.000.000**. The retención corroborates the boletas, not the 1412 figure — but the
tool must keep not adjudicating that until 1412 is observed.

**To close:** first-hand observation of what 1412 means (SII form definition / ayuda PDF for B92),
then add it to the taxonomy and compute the delta. Backward-compatible: the código is already in
the payload.

### 3.5 RCV crédito/débito must NET reversing DTE types before comparing to F29 (FIXED 2026-07-28)

**Status: fixed** — kept here because the shape of the bug is worth not re-discovering in a
future surface that sums RCV resumen rows.

A read-only audit against a real taxpayer (Empresa C SpA, a second real taxpayer account) found `cuadraCredito:
false` in 15 of 16 real months (2025-03 to 2026-06), with **no SII observación, no rejection,
and nothing wrong in the taxpayer's books**. The delta was, in every single month, EXACTLY 2×
that month's Nota de Crédito Electrónica (DTE type `61`) IVA received in compras — including the
one month with zero NC in compras, where the delta was exactly zero.

Root cause: `ladoFrom` in `tasks/iva.ts` summed every RCV resumen row's `montoIva` (and
`montoNeto`/`montoExento`/`montoTotal`) straight across all DTE types. A Nota de Crédito
**recibida** reverses part of a prior purchase — it should SUBTRACT from the side's total, not
add to it. SII's own F29 propuesta componente (código `511`, "IVA por documentos electrónicos
recibidos") already nets NC out before publishing it, so the straight RCV sum was structurally
guaranteed to disagree with 511 by exactly the NC's contribution, twice over (once for adding it
where it should subtract, once because the correct figure never included it).

**Fix:** `ladoFrom` now nets a `TIPOS_REVERSA` set (currently `{'61'}`, cited from this same live
audit) out of the monetary columns, while leaving the per-`porTipo` breakdown and the document
COUNT at their raw magnitude — a contador needs to SEE the reversing document, and it is still
one real document received. See ADR-022's Revisions section and `tasks/iva.test.ts`'s "Notas de
Crédito netting" test block.

**Open question, NOT yet observed:** the fix applies `TIPOS_REVERSA` (NC, tipo `61`) to BOTH
sides — compras (crédito) AND ventas (débito) — but only the crédito side was actually verified
against a real SII figure (código 511). The ventas-side netting rests on the same accounting
fact (a Nota de Crédito emitida reduces a prior sale) and is believed correct, but it has NOT
been isolated against a real F29 código 538 or an unambiguous componente (§3.1 was re-investigated
2026-08-05 against six real months with ventas — 538 still never appears, and the one plausible
componente, `502`, is itself unnetted, so it cannot serve as that check either). Whether Notas de
Débito (DTE type `56`) need analogous treatment is a separate, also-unobserved question (an ND
increases a sale, so the current straight-add is believed correct, but untested). Revisit both
once §3.1 closes.

### 3.3 F29 Fase 2 — the *filed* form (ADR-013, deferred)

Everything today reconciles against SII's **propuesta**, not what was actually filed. Live
validation made this more important than it looked: the propuesta does **not** carry the computed
totals (`totales` came back empty), and its component códigos are themselves derived from the RCV
— so reconciling against it is closer to validating our own parsing than to auditing a return.

**Path:** `rfiInternet` GWT-RPC. Mapped in the original spike; the `gwt.ts` codec and
schema-extraction machinery already exist from `peticiones`. Needs a live capture + a headless
PoC. Would add `fuente:'presentada'` plus a computed `resumen`, with no change to the result shape.

### 3.4 `profile` — domicilio (CLOSED 2026-08-05, ADR-041)

**Status: closed.** Built `profile` (`tasks/profile.ts`) reusing the SAME `opc=112` call
`situacion` already makes, projected into a fuller `PerfilCompleto` (`portal/situacion.ts`). Own
domicilio (calle/comuna/región/tipo/teléfono) is always exposed; socios/representantes/
`rutPropietario` (the landlord — a third party) require `incluirTerceros: true`, mirroring
`situacion`'s existing conteo-only default. Live-validated: 3 real socios (33.33% each) and 1
representante, invisible without the flag, exact with it.

---

## 4. Features, unblocked and ready to build

| Item | Notes |
|---|---|
| **`rcv match`** — folio reconciliation | Deferred since #17. Now cheap: `rcvListAll` already returns every document tagged by type. Needs one decision from the user: the external ledger's format (CSV columns) and what counts as a match (folio+RUT+monto, with what tolerance). |
| **Document vault** — PDF download | **La seam existe (ADR-042, `requestBinary`) y `sii carta pdf` está construido**, pero la verificación en vivo 2026-08-06 falló (HTTP 500 en 3 `codCarta` reales) — la URL exacta necesita recapturarse desde el enlace real de la UI, no desde la hipótesis previa. Ver ROADMAP.md y ADR-042. |
| **`carpeta ver <codigo> <clave>`** — Carpeta Tributaria Regular RECIBIDA | **Investigado en vivo 2026-08-06 (spike H) — la premisa original estaba equivocada.** `www2.sii.cl/carpetatributaria/cterevisar` NO es un historial listable (a diferencia de ADR-033, que sí lo es para las EMITIDAS) — es un formulario de BÚSQUEDA que exige el "Código de Carpeta Tributaria Electrónica" y su "Clave", ambos entregados FUERA DE BANDA por quien emitió la carpeta (no algo que SII exponga proactivamente, como un número de seguimiento de un paquete). No se construyó ningún facade — no había un código+clave reales contra los que verificar, y construir ciegamente contra fakes sería inverificable (mismo riesgo silencioso que el proyecto evita en todas partes). Si en el futuro un cliente recibe una carpeta de un tercero (banco, etc.) y comparte el código+clave, es una fachada de una sola consulta (GET/POST con esos dos valores), no un `historial`. Ver `docs/audits/2026-08-06-dia5-g-h.md`. |
| **`sii audit`** — read the receipt | `~/.sii/audit.jsonl` is write-only. A reader gives durations by surface, failure rates, and early warning that a scraper is degrading. Small. |
| **Multi-period trend / counterparty rollup** | Unblocked by ADR-027's cache. A 12-month series is now practical (4.0 s cold → 0.3 s warm, no browser). |
| **Cache more surfaces** | Only `iva`/`renta`/`honorarios` are opted in. `rcvSummary`/`rcvList` are the obvious next; `monitor` must stay **uncached** by design. |
| **MCP Prompts** | "revisar IVA del mes", "preparar renta". Safer default entry point than leaving a model to pick among 20+ tools. |
| **Aligned tables** in `renta`/`honorarios` `--human` | Currently line-per-row. Columns + a totals row would make output client-presentable. |
| **Spike: "Consulta Integral de Informe F29"** | See §7 — a user-reported SII surface that may already cross-check crédito fiscal against the filed form, TurboTax-style. Locate it live, capture the wire contract, evaluate against `iva`/Fase 2 before building more approximation logic on the propuesta. |

---

## 5. Write surfaces (each needs its own ADR for legal weight)

| Item | Blocker |
|---|---|
| `bte emit` **ISSUE** step live validation | Preview is live-validated; the issue step is coded to the 2026-07-02 capture but never run against a real (needed) boleta. Must not be validated with a throwaway document. |
| `bte anular` | Needs its own live capture; validating means annulling a real boleta. |
| `f29 submit` / `f22 submit` | No observed submit contract. "Done" means filing a real return — the maintainer's signature, not the tool's. |
| `dte emit` / `dte accept` | Hard-blocked on a subsystem that does not exist: certificate loading (`.pfx`/`.p12`), XML canonicalisation, XMLDSig, SOAP, CAF folio management. Weeks, and needs the owner's real certificate. |

---

## 6. Infrastructure & quality debt

| Item | Detail |
|---|---|
| **`fetch`-based driver** | Three of five primitives (`requestJson`, `requestForm`, `requestText`) are cookie-authenticated HTTP merely *issued through* Playwright's request context. A driver replaying the jar with `fetch` would drop the browser for everything except `login` and the BHE `goto`/`evaluate` read — ~300 MB and most per-command latency. The seam boundary already makes this contained. |
| **Keyring `SecretStore`** | Declared interface, no Node adapter. Closes the residual half of ADR-025 (ACLs do not protect against code running as the same user) *and* unblocks item 1.1. |
| **Windows CI** | Not in the matrix. ADR-025's platform paths are covered by unit tests over pure helpers, not end-to-end — and two Windows-only defects (POSIX modes, `rm -rf` in `prepack`) shipped before being caught. |
| **Coverage measurement** | `vitest.config.ts` sets no provider and no thresholds. 412 tests across 65 files, but coverage is unmeasured either way. |
| **Cache storage shape** | Single `cache` key holding a map: whole-file rewrite per write, no cross-process locking. Fine for a single-user CLI. Per-entry keys would need directory enumeration added to `KeyValueStore`. |
| **GWT schema regeneration** | `gwt-schema.ts` (109 classes) is regenerable via `docs/sii-contract/peticiones-schema-extract.py`. Re-run when SISPAD is recompiled and a class fails to resolve. |

---

## 7. Live-observed facts worth not re-discovering

- **Session lifetime ≈ 10–12 h.** A jar minted 14:32 was live at 11:25 next morning, rejected by
  00:51. `sessionTtlMinutes` is set to 12 h from this observation and enforced by `withSession`.
- **`sii auth status` does not prove liveness** — it reads the local cookie. The first real
  request is the test; exit 2 means expired.
- **No CAPTCHA anywhere observed.** RCV's `tokenRecaptcha` is the literal sentinel
  `t-o-k-e-n-web` and the SPA never loads Google's SDK. Plan effort around **session lifetime**,
  not anti-bot defences.
- **RCV electronic records start `201705`.** Earlier periods are rejected verbatim by SII.
- **`raw` on an RCV detalle row is 67 fields**, not the ~50 long assumed — which is why ADR-028
  made it opt-in.
- **The F29 propuesta carries no totals.** `totales` is empty; components (511 = IVA de
  documentos electrónicos recibidos, 562 = exento, 519/584 = document counts) are present and
  SII-derived from the RCV.
- **RCV resumen rows are NOT pre-netted by SII** — a Nota de Crédito Electrónica (tipo `61`)
  comes back as a positive magnitude like any other row; the CONSUMER must know it reverses a
  prior document and subtract it. See §3.5 (fixed 2026-07-28, cost a real audit a false
  "descuadre" finding until traced to this).
- **"Consulta Integral F29" — INVESTIGADA A FONDO (2026-08-05, spike G2b, ver
  `docs/audits/2026-08-05-dia3-g2-g2b-f29-presentado.md`).** Es la MISMA clase de riesgo que
  `rfiInternet` (§3.3): otra app GWT protocolo 7 (`sifmConsulta.web.client.*`), confirmado
  interceptando tráfico real — su endpoint `getInfoIntegral` devuelve tokens ofuscados
  (`'lzBDG'`, `'xUW'`...) sin esquema derivado. **No decodificar a ciegas.** PERO su UI renderiza
  limpio (patrón ADR-034): buscando por Período → Consultar da una tabla resumen (redundante con
  Fase 1, mismo monto verificado exacto) y el botón "Ver" abre un "CONSULTA DE ESTADO" con un
  **Historial de Eventos** que incluye el **Cruce IVA Mensual** ("sin observaciones") — la señal
  de auditoría que HOY ningún módulo expone. Candidato concreto y de bajo riesgo: un facade que
  lea ese DOM (no el GWT), multi-paso (Buscar Formulario → Período → Consultar → Ver). ⛔
  "Rectificar Declaración" vive en esa misma vista — nueva superficie de escritura, catalogada en
  `ESTADO-CONSOLIDADO.md` §4.3. "Formulario Compacto" (posible desglose completo de códigos) y
  "Certificado Solemne" quedan SIN investigar — el primero no navegó visiblemente en el spike, el
  segundo no se tocó por sonar a emisión de documento, no lectura.
