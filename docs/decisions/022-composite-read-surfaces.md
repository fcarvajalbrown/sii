# ADR-022: Composite read surfaces (`iva`, `renta`) — facade-level joins inside one session

## Status

Accepted — 2026-07-25. The first surfaces that COMBINE existing facades rather than wrap a new
SII endpoint. Builds on ADR-003 (surfaces call tasks only; the fan-out belongs in the library),
ADR-005 (body-RUT vs session-keyed), ADR-004 (pacing, never retry) and ADR-012 (JSON default).
No new SII endpoint, no new wire contract — everything here rides observed facades.

## Context

`ROADMAP.md` has carried `sii iva` / `sii renta` as 📋 "composite contador summaries derived
from the surfaces above" since the beginning. The underlying reads all landed (RCV #17/#77,
F29 Fase 1 #18, F22 #19/#26/#27/#28), so the data is reachable — but only as separate
commands whose outputs the user joins by hand every month.

Two facts make the naive implementation wrong, and they are why this needs an ADR rather
than just a PR.

**1. Every existing task opens its own session.** `rcvSummary`, `f29Formulario`, `f22Status`
and `f29Status` each call `withSession` internally, and `withSession` does
`portal.restore(cookies)` → work → `session.close()`, where the Node driver's `close()` tears
down a whole Chromium instance. So a composite written as

```ts
const compras = await rcvSummary(runtime, { periodo, side: 'COMPRA' });
const ventas  = await rcvSummary(runtime, { periodo, side: 'VENTA'  });
const f29     = await f29Formulario(runtime, { periodo });
```

launches and destroys **three browsers** for one `sii iva 2025-06`. `renta` would launch
**fourteen** (F22 declaraciones + F22 grid + twelve F29 months). That is precisely the
anti-pattern `rcvListAll` was built to avoid — its own docstring states the motivation: "A
consumer gets one flat table without opening N browser sessions (the whole motivation —
ADR-003: the fan-out belongs in the library, not the caller)."

**2. The two halves of `iva` have DIFFERENT authorization models (ADR-005).** RCV is
**body-RUT**: it carries the operating RUT in the request body, so `operate`/`--rut` reaches a
represented empresa. F29 and F22 are **session-keyed**: they authorize by the session
principal and ignore the operate pointer entirely. A composite that joined them while a
persona operated as a represented empresa would splice **the empresa's ledger onto the
persona's own tax return** and present the delta as a reconciliation. That is not a cosmetic
bug — it is a wrong accounting figure delivered with confidence, which is worse than an error.

## Decision

Add two composite tasks, `ivaMensual` and `rentaAnual`, under these rules:

- **One `withSession`, facade calls inside.** Each composite opens a single session and calls
  the PORTAL FACADES (`fetchRcvResumen`, `fetchF29Propuesta`, `fetchF29Estado`,
  `fetchF22Declaraciones`, `fetchF22Grid`) directly, exactly as `rcvListAll` and `f22Status`
  already do. Composites are the ONE place in `tasks/` that may call several facades, and they
  remain inside `tasks/` — the ADR-003 boundary (surfaces never reach past the task layer) is
  untouched. Surfaces still see one task call.
- **Session-keyed, self only.** Both composites `assertSelfOperating` BEFORE opening a session
  and read the session principal for every leg, including the RCV leg. They take **no `--rut`**.
  Rationale: a composite is only as reachable as its most restrictive member, and F29/F22 are
  session-keyed. Reading the empresa's RCV under a persona's F29 is the error described above,
  so we forbid the whole operation rather than silently mixing. The error message says to
  `logout` and log in as the empresa — the same wording `bteList` and `f29Formulario` use.
- **Reconcile on SII's own total códigos, never on a recomputed figure.** The F29 side of the
  IVA reconciliation reads **código 538 (`TOTAL DÉBITOS`)** and **código 537 (`TOTAL CRÉDITOS`)**
  from the propuesta — both observed in `portal/f29-codigos.ts` with a `'='` sign, i.e. SII's
  own totals. We do NOT re-derive them by summing member códigos. The RCV side sums
  `montoIva` across the resumen rows, which is the ledger's own per-type aggregate. The delta
  is then RCV-minus-F29 on each side, and `cuadra` is true only when both deltas are exactly 0.
- **A missing leg is data, not an error.** No propuesta for the month (`tienePropuesta:false`),
  an RCV month with no movement (SII code 3), or a year with no F22 are all legitimate
  outcomes: the corresponding figures are `null`, `cuadra` is `false`, and the result still
  returns. Only a session-level failure aborts. `null` is never coerced to `0` — "SII returned
  nothing" and "SII returned zero" are different facts to a contador.
- **`renta <año>` spans the año tributario AND its commercial year.** F22 for año tributario
  `N` declares the income of commercial year `N-1`, so `rentaAnual(N)` pairs the **F22 of AT N**
  with the **twelve F29 months of `N-1`**. This is the domain rule that makes the two halves
  comparable; it is asserted in tests so a future refactor cannot quietly shift it by a year.
- **Paced like every other fan-out.** Every POST after the first sleeps `1000/rateLimitRps` ms
  through the `Clock` seam. `renta` is 14 POSTs, so pacing is not optional. Never retried.
- **Audit: one receipt per composite**, carrying `rut`, `period`, `durationMs` and whether the
  reconciliation balanced — never a monto, never a counterparty (ADR-006).

## Alternatives Considered

- **Compose the existing tasks and accept N browsers.** Rejected: three Chromium launches for
  `iva` and fourteen for `renta` makes `renta` take minutes and hammers SII with N session
  restores, violating ADR-004's pacing posture. It would also make the composite slower than
  running the commands by hand, defeating its purpose.
- **Refactor `withSession` to accept an externally-supplied session so tasks can nest.**
  Rejected for now — it is the cleaner long-term shape, but it changes the signature of every
  existing task and its "authentication is an explicit verb" guarantee (ported sii-py ADR-019).
  That is a separate, larger ADR; calling facades from a composite achieves the same result
  today with no change to existing tasks. Revisit if a third composite lands.
- **Let `iva` accept `--rut` and reconcile a represented empresa's RCV against whatever F29 the
  session returns.** Rejected outright: it produces a confidently-wrong number. See Context.
- **Recompute débito/crédito by summing the member códigos** instead of reading 537/538.
  Rejected per ADR-004 (pass SII's own data through): our sum could disagree with SII's total
  for reasons that are correct (a código we haven't observed), and then the tool would report a
  reconciliation failure that does not exist.
- **Emit a single flat "IVA position" number.** Rejected: a contador needs both sides and the
  per-type breakdown to find WHERE a mismatch is. One number hides the actionable part.

## Consequences

- A farm/contador gets `sii iva <periodo>` — the monthly VAT reconciliation that previously
  meant three commands and manual arithmetic — and `sii renta <año>` for the annual pack, each
  in a single session.
- Composites are now a recognised task shape: `tasks/` may hold facade-level joins, and the
  rule "one composite = one session = paced fan-out" is the pattern for `rcv match` later.
- **Cost:** the composites duplicate a little grouping logic that also lives in
  `f29Formulario` / `f22Status` (the `agrupar` / `groupCodigos` calls). Accepted for now — the
  alternative is exporting internals purely for reuse. If a third consumer appears, extract.
- **Limitation carried forward:** the F29 leg reads the **propuesta**, not the filed form,
  because Fase 2 (`rfiInternet` GWT-RPC) is still deferred (ADR-013). So `iva` reconciles the
  ledger against SII's *suggestion*. This is stated in the CLI help, the MCP description and
  the `fuente` field of the result, so no caller can mistake it. When Fase 2 lands, `iva`
  gains a `presentada` source with no change to its shape.
- Both composites are **read-only** and touch no write path, so ADR-017's confirm-gating does
  not apply.

## Revisions

**2026-07-28 — RCV side must net Notas de Crédito, not sum them straight.** A read-only audit
of a real taxpayer (Empresa C SpA, a second real taxpayer account) found `cuadraCredito:false` in 15 of 16 real
months, every single time by EXACTLY 2× that month's Nota de Crédito Electrónica (DTE type
`61`) IVA received in compras — including the one month with zero NC, where the delta was
exactly zero. Root cause: `ladoFrom` (`tasks/iva.ts`) summed EVERY resumen row's monto straight,
including reversal documents. A Nota de Crédito recibida reduces a prior purchase (so it should
SUBTRACT from `compras.iva`); SII's own propuesta componente (código `511`) already nets it out
before publishing it, so comparing a straight RCV sum against 511 double-counted the NC's effect
— once by adding it where it should have subtracted, once more because the correct figure never
had it in the first place. The bullet "The RCV side sums `montoIva` across the resumen rows,
which is the ledger's own per-type aggregate" above is corrected by this revision: it nets a
`TIPOS_REVERSA` set (currently just `61`) OUT of `neto`/`exento`/`iva`/`total`, while the
per-`porTipo` breakdown and the document COUNT stay at their raw, un-netted value (a contador
needs to see the reversing document, and it is still one real document received). This was not
an SII discrepancy, an observación, or a books problem — it was this tool computing its own
"ledger" figure wrong before comparing it to SII's number. See `docs/BACKLOG.md` §3.5 for the
full write-up and `tasks/iva.test.ts`'s "Notas de Crédito netting" block for the regression
tests. `IVA_CACHE_VERSION` was bumped (1→2) so periods cached under the old computation
self-invalidate rather than serving stale figures (ADR-027).
