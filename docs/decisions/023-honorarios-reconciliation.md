# ADR-023: Honorarios & retenciones reconciliation (`honorarios`) — BHE ↔ F29, F22 surfaced

## Status

Accepted — 2026-07-25. The third composite read, following the pattern ADR-022 established
(facade-level join inside ONE `withSession`, paced, session-keyed). Motivated by a live
observación. No new SII endpoint and no new wire contract — every leg rides an observed facade.

## Context

A real, open F22 observación on this taxpayer reads:

> **B92** — CONTROL DE LOS HONORARIOS DECLARADOS EN EL COD. 1412 DEL F22 CONTRIBUYENTES
> ACOGIDOS AL RÉGIMEN DEL N°3 DE LA LETRA D ART. 14.

That is, by construction, a **mismatch between what the taxpayer declared and what SII
independently observes** about honorarios. Resolving it today means manually cross-referencing
three separate commands across twelve months. Any operation that runs on contractors —
agronomists, harvest crews, transport — carries the same withholding exposure, invisible until
SII flags it.

Three facts shape the design, and two of them are traps.

**1. Only ONE side of a BHE is ours to declare.** `portal/bte.ts` exposes `retencionEmisor` and
`retencionReceptor` as separate fields. On boletas **recibidas** we are the receptor: when the
retención was withheld by us (`retencionReceptor`) it is ours to declare in the F29; when the
emisor withheld their own (`retencionEmisor`) it is not. **Summing both would manufacture a
false mismatch.** The split is the whole point of the reconciliation.

**2. The F29 side has an exact código, and a near neighbour that is NOT it.** Observed in
`portal/f29-codigos.ts`:

- **`151`** — "Retención de Impuesto con tasa del 10% sobre las rentas del Art. 42 Nº 2, según
  Art. 74 Nº 2 LIR" ← honorarios. This is the one.
- `153` — "…rentas del Art. 48, según Art. 74 Nº 3 LIR" — participaciones de directorio.
  Adjacent, frequently confused, and **not** honorarios.

**3. Código 1412 is not in our F22 taxonomy.** `f22-codigos.ts` maps honorarios códigos
`110, 461, 467, 492, 545`; `1412` appears in none of them. We have **no first-hand observation
of 1412's semantics** — only SII's B92 glosa naming it. Under ADR-004 we do not get to invent
what it means.

## Decision

Add `honorariosAnual(runtime, { anio })` under these rules:

- **`anio` is the COMMERCIAL year**, not the año tributario — honorarios are paid and withheld
  monthly, so the commercial year is the natural unit. The F22 leg reads año tributario
  `anio + 1`. Both are echoed in the result (`anioComercial`, `anioTributario`) and asserted in
  tests, so the offset cannot drift. (Note this differs deliberately from `renta`, which takes
  the año tributario; each takes the unit its own data is keyed by.)
- **Reconcile `retencionReceptor` against F29 código `151`, per month and in total.** Never the
  emisor side, never their sum. `153` is explicitly out of scope and documented as such.
- **The F22 leg SURFACES, it does not assert.** We report the honorarios-related códigos found
  in the F22 grid — the five mapped ones plus **`1412`**, which is included because SII's own
  B92 glosa names it — each with SII's inline glosa and its value, and a flag
  `enTaxonomia:false` for any código our taxonomy does not map. **We compute no delta against
  the F22.** Doing so would require asserting 1412's semantics, which we have not observed.
  The user compares; the tool does not guess. This is the anti-allowlist rule (CONVENTIONS)
  applied to a composite: surface the unmapped código, never hide it, never invent its meaning.
- **One `withSession`, facade calls inside** — `fetchBteMensual` ×12, `fetchF29Propuesta` ×12,
  `fetchF22Declaraciones` + `fetchF22Grid`. Composing the existing tasks would launch ~26
  Chromium instances (ADR-022's finding).
- **Session-keyed, self only.** BHE, F29 and F22 are all session-keyed, so a representing
  operate pointer is rejected before any session opens. No `--rut`.
- **Per-month resilience.** A single month's `BteError` or `F29Error` is captured in
  `mesesConError` (SII's message verbatim) and the rest of the year still returns — the
  `f22Historial` / `rcvListAll` precedent. A session-level failure still aborts. Never retried.
- **`null` is never coerced to `0` in the DATA — but the VERDICT treats absent as "nothing".**
  This distinction was forced by the tests and is load-bearing. `delta` stays honestly `null`
  whenever a side is missing (we cannot compute a real difference from a missing side). The
  *verdict* (`mesCuadra`) is separate: both sides absent ⇒ balances (an empty month is not a
  discrepancy); one absent and the other `0` ⇒ balances; **one absent and the other non-zero ⇒
  discrepancy** (retención declared with no boletas behind it, or withheld with no propuesta —
  indeterminable, but precisely what the user must see); both present ⇒ balances iff equal.
  The naive rule "null delta ⇒ mismatch" flags all twelve months for any taxpayer with a quiet
  year, burying the real discrepancies in noise. The annual `cuadra` is derived from the months,
  not from the annual delta, which is `null` whenever any month was absent even though every
  month reconciles.
- **Paced** at `1000/rateLimitRps` between every POST. The BHE leg paginates internally, so the
  real POST count is ~26 plus pages — pacing is not optional here.
- **Audit:** one receipt with `rut`, `period`, month count and whether it balanced. Never a
  monto, never a counterparty (ADR-006).

## Alternatives Considered

- **Reconcile the F22 código 1412 too, computing a delta.** Rejected — we would be asserting a
  tax rule we have not observed first-hand (ADR-004). A wrong reconciliation delivered
  confidently is worse than no reconciliation; the taxpayer would act on it. Surfacing the
  código with its verbatim glosa gives the user everything they need to judge it.
- **Sum `retencionEmisor + retencionReceptor`.** Rejected — see Context 1. This is the single
  most likely way to produce a false B92-shaped mismatch.
- **Make it monthly (`honorarios <periodo>`), mirroring `iva`.** Rejected as the primary shape:
  the F22 side is annual, so a monthly command cannot close the loop that motivates the
  feature. The per-month breakdown is retained *inside* the annual result, which gives the same
  drill-down without a second command.
- **Reuse `bteList`/`f29Formulario` tasks.** Rejected on ADR-022's grounds (one browser per
  task).
- **Include código `153` (Art. 48) in the retención total.** Rejected — different article,
  different withholding. It would silently inflate the declared side.

## Consequences

- A contador can answer "does what we withheld match what we declared?" for a whole year in one
  command, and see exactly *which months* diverge — the actionable part.
- Directly addresses the open B92 by assembling its three inputs side by side, without
  pretending to adjudicate código 1412.
- **Cost:** the heaviest read in the codebase (~26 POSTs plus BHE pagination). Acceptable for a
  once-a-year reconciliation, but it makes the caching work (roadmap) more valuable, and it
  should never be run in a loop.
- **Limitation carried forward:** the F29 leg reads the **propuesta**, not the filed form
  (ADR-013 Fase 2 still deferred), so a month the taxpayer filed differently from SII's
  suggestion will show a delta that is real but explained by the filing, not by an error. The
  `fuente:'propuesta'` field and the CLI/MCP help state this, exactly as `iva` does.
- If 1412's semantics are later observed first-hand, adding a computed F22 delta is a
  backward-compatible extension — the código is already in the payload.
