# Conventions

This file grows as real work surfaces patterns (ADR-007: corrections become
conventions). It starts with the load-bearing rules ported from the proven
Python `sii-cli`, adapted to TypeScript.

## Code style

- TypeScript `strict` everywhere, plus `noUncheckedIndexedAccess` and
  `exactOptionalPropertyTypes`. No `any` without an inline justification; prefer
  `unknown` + narrowing at boundaries.
- ESLint + Prettier are authoritative. Format before commit.
- Comments explain WHY, not WHAT — non-obvious constraints, SII quirks, subtle
  invariants. Never restate the code.
- ESM only (`"type": "module"`). Named exports; avoid default exports.
- **NodeNext modules: relative imports end in `.js`** (e.g. `from './rut/index.js'`)
  so the compiled output runs directly on Node; bare specifiers (`@dostertags/sii-core`,
  `commander`) stay extensionless. `tsc` errors on a missing extension. (ADR-009)

## Architecture patterns

- **Single-env (prod) is the contract.** No `SII_ENV` switch. Hostnames are
  constants in `@dostertags/sii-core` config; never hard-code a SII hostname anywhere else.
- **Surfaces call `@dostertags/sii-core` tasks only.** CLI and MCP never reach past the
  task layer into a portal/DTE facade — that bypasses throttling, audit log, and
  credential handling. (ADR-003)
- **The core is the data layer; surfaces present. JSON is the default output.**
  `@dostertags/sii-core` tasks return plain, JSON-serializable objects (no `Date`/`Map`/`Set`,
  no human formatting) — that is the library/integration contract. The MCP surface
  emits `JSON.stringify`; the CLI emits JSON by DEFAULT (`--human` for the readable
  rendering, `--json` is the explicit default). A command computes its result object
  ONCE and renders it through the shared `emit(data, humanFn)` — never bare `out()`
  for a result. STDOUT carries only the result (JSON pipeable to `jq`); the
  `operating as:` header + diagnostics go to STDERR and are human-mode-only. (ADR-012)
- **External dependencies sit behind injectable seams.** `PortalDriver`,
  `SecretStore`, `SessionStore`, `AuditSink`, `Clock` are interfaces in
  `@dostertags/sii-core` with Node default implementations; tests inject fakes so they
  never touch the real SII / keyring / clock. The core is otherwise a normal
  Node library (it may use Node APIs directly). (ADR-003)
- **Authentication is an explicit verb, not a side-effect.** Domain tasks never
  mint a session; they consume a valid one or raise `NotAuthenticated`. Only the
  login task mints. (ported sii-py ADR-019)
- **Domain tasks reach SII through `withSession`, never a bespoke restore.** The
  `auth/session.ts` primitive restores the cookies-only session into a live
  `PortalSession`, resolves the operating/body RUT (override > pointer > self — a
  `--rut` override is validated against the operable set HERE, the single
  enforcement point, via the same `resolveOperableTarget` the `operate` command
  uses), hands both to the callback, and always closes the session — raising
  `NotAuthenticated` when there is none. It does NOT eagerly probe liveness — the
  first SDI POST IS the liveness test: the `requestJson` seam detects the login-wall
  response (a dead jar bounced to HTML / `LOGIN_HOST`) and raises `SessionExpiredError`
  (actionable "re-login"), so facades must let `NotAuthenticated` propagate instead of
  wrapping it as their domain error. NEVER retries after a block. New read surfaces
  (rcv/f29/bte) wrap their facade call in it. (ADR-003 / ADR-005)
- **Identity is single-account + operate-centric.** One live session at a time;
  switch accounts by logout→login. Within a session, a persona's `operate`
  pointer chooses which RUT it acts as (self by default, or a represented
  empresa). `operate` SELECTS, never mints, and is validated against the cached
  operable set. Empresa accounts have no operate capability. The active operating
  RUT is ALWAYS visible (status + an `operating as:` header). (ADR-005)
- **Per-call `--rut` overrides the operate pointer** for one operation; it is the
  same value-domain (the operable set), not a separate concept.
- **Validate external inputs at the boundary with `zod` (ADR-011).** MCP tool
  inputs (the SDK derives the protocol JSON Schema from the zod shape) and, later,
  SII wire payloads in `@dostertags/sii-core`. Validation stays at the boundary — internal
  domain invariants are plain TypeScript types, never zod.

## SII domain rules

- **No third-party SII libraries.** Every selector, endpoint, and payload
  constant is derived from first-hand observation of the live SII source (HTML,
  JS, WSDL, official PDFs) and cited in a code comment, e.g.
  `// observed at <URL> on <YYYY-MM-DD>`. (ADR-004)
- **Prefer inline structured data over DOM scraping.** Where the portal ships a
  JS object (e.g. `DatosCntrNow`) or an inline data map, read THAT, not the
  rendered DOM. Cite the variable name and observation source.
- **Portal session detection is URL-based, not DOM-based.** Landing on
  `zeusr.sii.cl` means not authenticated; any other host means we reached the
  destination. URL is part of the auth contract; DOM markers are a guess.
- **Wire contracts are documented under `docs/sii-contract/`** per surface, with
  the request shape, response shape, and observation date. (ported sii-py ADR-020)
- **Authenticated SPA-JSON facades go through `PortalSession.requestJson`.** The
  `www4.sii.cl` SDI endpoints (RCV, representación, …) are reached via the seam's
  authenticated JSON POST (the session cookies ride along), never a bespoke HTTP
  client. Cite the endpoint + observation date; surface the `respEstado` error
  envelope verbatim; curated + `raw`. (ADR-003 / ADR-004)
- **Inline-JS-map facades (legacy CGIs) go through `PortalSession.goto` + `evaluate`,
  NOT `requestJson`.** Some surfaces (BHE/BTE on `loa.sii.cl/cgi_IMT/`) serve an HTML
  skeleton whose tables are filled client-side from global JS maps (`xml_values`,
  `arr_informe_mensual`). Navigate with `goto` (the `.sii.cl` session cookie SSO-carries;
  detect a dead jar by a `LOGIN_HOST` landing → `SessionExpiredError`) and read the map
  with `evaluate("…Object.fromEntries(Object.entries(V))…")` — the `Object.entries`
  wrapper is REQUIRED (the maps are JS Arrays with string keys a bare read would drop).
  NEVER scrape the rendered DOM (the cells still hold the filling JS). Cite the CGI +
  observation date; pace pagination via `Clock.sleep`. (ADR-003 / ADR-004)
- **Unauthenticated public consultas go through `PortalDriver.requestPublic`.** A
  login-free CGI (DTE-authorized) is a cold, session-less, browser-free HTTP request
  (Node `fetch`, charset-aware) — not a `PortalSession`. Still a task + seam (audited),
  never a bespoke client in the facade. (ADR-014)
- **Authenticated HTML form-POST write flows go through `PortalSession.requestForm`.** The
  legacy `loa.sii.cl/cgi_IMT/` `TMBECN_*` CGIs (BHE emission) take `x-www-form-urlencoded`
  POSTs and return HTML, so they use `requestForm` (authenticated peer of `requestPublic.form`),
  NOT `requestJson` (JSON-only, treats HTML as a login wall). The login-wall check is URL-based
  (landing on `LOGIN_HOST`) since an HTML body is expected. Parse the response's inline
  `xml_values` with in-house helpers (single- AND double-quoted; `formatMiles("<n>")` amounts);
  read JS-built `<select>` values from their backing map (`iddir1`), never from the static HTML.
  (ADR-017)
- **Authenticated GWT-RPC read facades go through `PortalSession.requestText` (a cold replay),
  NOT `requestJson` (ADR-020).** The legacy GWT apps (`www3.sii.cl/sispadinternet` — peticiones
  administrativas; F29 Fase 2 later) speak GWT-RPC: a `text/x-gwt-rpc` POST (`5|0|7|…`) returning a
  `//OK[…]` object graph — neither JSON nor HTML. Reach them by a **cold authenticated POST** (never
  by driving the SPA — that is the F29-Fase-2 fragility): `requestText` (authenticated raw GET/POST
  → text, the peer of `requestPublic`) replays the call; the `.sii.cl` cookie authorizes, no warm-up
  needed. The GWT **token arg is NOT validated** (send a constant placeholder; auth is by cookie +
  the RUT param). The **policy hash IS validated** and rotates on redeploy → source it at runtime by
  a `requestText` GET of the permutation JS, cache it, and **self-heal** (re-fetch + re-probe) on a
  deserialization failure. Build the request + decode `//OK[…]` in an in-house `portal/gwt.ts`
  (stdlib only, no third-party GWT lib); `//EX[…]` business message ⇒ **verbatim** (ADR-004),
  `LOGIN_HOST` bounce ⇒ `SessionExpiredError`, changed shape ⇒ "scraper roto". The decoder is
  **schema-directed** — the per-type field layout is **derived from the compiled permutation's
  deserializers** (`gwt-schema.ts`, regenerated by `docs/sii-contract/*-schema-extract.py`), NOT
  reverse-engineered from response samples (which can't be complete — different rows expose
  different types). Key the schema by **class name** (the per-type CRC rotates on recompile; the
  layout does not). Body-RUT (validate `--rut` vs the operable set, like RCV). PII-dense (own +
  functionary + third-party) ⇒ NO `raw`, tight allowlist. (ADR-020)
- **Write surfaces are two-phase, session-keyed, confirm-gated, PII-free in the audit (ADR-017).**
  A state-changing op (first: `bte emit`) exposes a non-mutating PREVIEW (server computes the
  result without committing) split from the ISSUE step. The CLI defaults to the preview; the real
  write needs an explicit `--confirm <echo>` (double-entry of a load-bearing value, e.g. the gross
  total). The MCP `*_emit` tool carries `destructiveHint: true` + an explicit `confirmar` + amount
  echo, with an honest "issues a legally-binding document" description. Audit every attempt with
  the result id (folio) only — never the counterparty / amount / free-text (PII/business data).
  **Never retry a write after a SII error.** Server-computed values (retención rate) are READ from
  the form, never hardcoded. Live-validate the ISSUE path against a real (needed) document — never
  a throwaway.
- **Wire parsing is zod-at-the-boundary + alias-tolerant rows (ADR-011 / ADR-004).**
  Validate the SDI ENVELOPE with zod (`respEstado` block + the `data[]` array; use
  `.loose()` so unobserved fields survive into `raw`). Project each row into the
  curated shape with an **alias-tolerant** lookup (an ordered tuple per logical
  field, OBSERVED NAME FIRST; extend with a `// observed …` citation when SII serves
  a new key). Empty `data[]` is a legitimate "no rows", never an error. zod stays at
  the boundary only — curated domain types are plain TypeScript. `representacion.ts`
  predates this (hand-rolled, pre-zod) and may be migrated; `rcv.ts` is the template.
- **Domain read surfaces own a per-module file + a register fn (no barrel churn).**
  Each module ships `cli/src/commands/<mod>.ts` (`register<Mod>(program, runtime)`)
  and `mcp/src/tools/<mod>.ts` (`register<Mod>Tools(server, runtime)`); `program.ts`
  / `server.ts` call it from ONE append-only line. This keeps the shared command tree
  conflict-free across parallel module worktrees (ADR-007). `rcv` sets the pattern.
- **Curated + raw for rich payloads.** When SII returns 30+ fields per row,
  expose a curated typed shape (~10–15 fields) plus a `raw` carrying the full
  payload for tax-special edge cases. **Exception: drop `raw` when the
  non-curated data is PII, not tax detail.** F22's uncurated fields are pure
  identity/bank PII (RUT, dirección, email, número de cuenta) — every tax código
  IS curated — so F22 exposes NO `raw` at all, keeping that PII off every surface
  / the LLM / the audit log. **BTE/BHE joins this no-`raw` camp (live BUG-1):** a
  boleta ROW mixes counterparty data with the taxpayer's OWN identity on both sides
  (emitidas `usuemisor` = self emitter, recibidas `nombre_receptor` = self receptor),
  and the own-identity field set is not provably enumerable — so a per-field denylist
  is unsafe; curate the named tax fields and expose NO `raw`. **Prefer dropping `raw`
  over a denylist whenever the own-PII field set can't be proven complete.** (ADR-004)
- **Curate PII-dense code grids by DENYLISTING the (bounded) PII, not allowlisting
  the tax códigos.** When a grid interleaves tax códigos with identity/bank PII
  (F22), drop ONLY the PII códigos and surface everything else. The PII set is small,
  fixed, and authoritative (F22's `codigosFormato.codigosCabecera` = the form header
  section, + the bank códigos) — so a denylist stays comprehensive. The tax códigos,
  by contrast, are many and taxpayer-specific: an **allowlist of tax códigos was
  tried for F22 `--full` (#27) and REJECTED** because it silently HID real
  honorarios/retenciones/deducciones lines for taxpayers whose códigos weren't in the
  hand map (AT 2023–2024) — the exact data the user needs. Surface unmapped non-PII
  códigos in an `otros`/visible bucket, never drop them. Keep the PII denylist
  complete by citing each código (`// observed …`); the RUT leaked under `9306`/`9920`
  then `8809` before the set was completed. (ADR-004 / ADR-006)
- **Body-RUT vs session-keyed surfaces (ADR-005).** A *body-RUT* surface (RCV)
  carries the operating RUT in the request body, so `operate`/`--rut` reaches a
  represented empresa — the task resolves the operating RUT. A *session-keyed*
  surface (F22; F29/BHE expected) authorizes by the session PRINCIPAL: it ignores
  the operate pointer, takes NO `--rut`, and always reads self; the empresa's data
  is reached by logging in AS the empresa (logout→login). Confirm reach live before
  wiring each session-keyed surface (F22 confirmed 2026-06-27). `rcv` is the body-RUT
  template, `f22` the session-keyed one.
- **Pace multi-call fan-outs via `Clock.sleep`.** A task that fires N POSTs (a
  multi-period/-year loop, a folio walk) sleeps `1000/rateLimitRps` ms between
  them through the `Clock` seam (the fake resolves instantly, so tests don't wait)
  — never hammer SII; never retry after a block. (ADR-004)
- **Pass SII's Spanish error messages through unchanged.** The user knows the
  domain; opaque translations waste their time. A scraper that can't find its
  selector raises a "scraper broken" error — never retry silently.
- **RCV resumen rows are raw magnitudes, not pre-netted — a composite that sums them MUST net
  reversing DTE types itself.** SII's `getResumen` (RCV) sends each DTE type's monto as a
  positive figure, including reversal documents (a Nota de Crédito Electrónica, tipo `61`,
  which reduces a prior purchase or sale). Any code that aggregates a "total crédito"/"total
  débito" figure from resumen rows — not just per-type display, where the raw magnitude is
  correct and expected — must SUBTRACT the reversing types' contribution or the aggregate will
  disagree with SII's own totals by exactly the reversed amount, read as a tax discrepancy that
  does not exist. Found live 2026-07-28 in `iva`'s crédito reconciliation (ADR-022 revision,
  `docs/BACKLOG.md` §3.5): 15 of 16 real months showed a phantom "descuadre" that was in fact
  this tool's own aggregation bug, not an SII rejection or an accounting problem. `TIPOS_REVERSA`
  in `tasks/iva.ts` is the only known member (`61`); extend it only with a citation from a new
  live observation (ADR-004) — never assume the full official DTE type table implies the same
  treatment for an unobserved code.
- **El registro RCV de exportaciones (110/111/112) NO es la exportación económica — cualquier
  cifra de INGRESOS por exportación se resuelve por CADENAS DE REFERENCIA del detalle
  (`detTipoDocRef`/`detFolioDocRef`), nunca sumando magnitudes del resumen.** Observado en vivo
  2026-08-14 (y reincidido 2026-08-18 por no estar documentado aquí — esta entrada ES la
  corrección): un contribuyente real refactura exportaciones en cadena y anula con NC 112 en $0
  (no restan nada) y hasta con una ND 111 por el monto exacto (que SUMA); el registro aritmético
  decía $47,6M cuando la exportación efectiva era $12,7M. Una 112 puede referenciar un folio de
  OTRO ejercicio (ajusta ese ejercicio, no el período leído). El neteo aritmético solo es válido
  donde el instrumento lo garantiza (IVA: los 110/111/112 llevan IVA $0 — por eso `TIPOS_REVERSA`
  de `tasks/iva.ts` nunca necesitó el 112, y la regla sembrada `reversa-nc` del auditor lo pinnea
  como no-reversa EN ESE CONTEXTO). Semántica completa: `docs/sii-contract/rcv.md`; implementación
  de referencia con tests: `turbocontabilidad/src/export-chains.js`.
- **A missing F22/F29 is only a real deficiency STRICTLY AFTER the earliest período the taxpayer
  is actually confirmed to have filed — never assume activity predates the first evidence of it.**
  Año tributario N reports on COMMERCIAL year N-1; a taxpayer that started operations mid-window
  legitimately has no F22 for the años before it existed. **UPDATE 2026-08-04 (ADR-035):** a real
  `fechaInicioActividades` field IS now observed (`situacion` / `opc=112`) — and it **VINDICATES**
  the heuristic below rather than replacing it: this taxpayer's inicio is `2019-06-19`, which
  explains the AT2019 false positive documented below exactly. Wiring the authoritative date into
  `monitor.ts` is a pending improvement that deserves its own tests, NOT a silent side effect; the
  anchor rule stays authoritative until then, and remains the correct fallback for any sweep that
  has not read `situacion`. `monitor.ts`'s `estadoFindings` anchors on the earliest año/período it DID find a
  declaración for within the current sweep, and downgrades any gap strictly before it to
  `severidad:'info'` (still surfaced — never silently dropped — but not counted in
  `resumen.aniosSinF22`/`mesesSinDeclaracion`, and not to be read as `alta` by a human or LLM
  report writer). A gap AFTER the earliest evidence stays `alta` — it is a real skipped year/month,
  not a startup artifact. Found live 2026-07-29 (a real taxpayer account): AT2019 was reported
  as a missing annual return at `alta` when AT2020 onward all had one and the taxpayer's first F29
  was 2019-06 — a false "declaración anual incumplida" that recurred across every audit report
  using this tool, not a one-off. **Any manual read of `f22 status`/`f29 overview` (bypassing
  `monitor`) MUST apply this same anchor-on-earliest-evidence rule before assigning severity** —
  the raw facades intentionally carry no severity judgment of their own (ADR-004: surface, don't
  assert), so the judgment call belongs wherever a report is written, not just inside `monitor.ts`.
- **BHE RECIBIDAS and BHE EMITIDAS are two unrelated flows — never summed, never conflated.**
  Recibidas (boletas issued TO the taxpayer) carries `retencionReceptor` — what the taxpayer
  itself withheld and must remit via F29 código 151; it is a LIABILITY. Emitidas (boletas the
  taxpayer issues as a `sociedad de profesionales`) is the taxpayer's OWN income, withheld on by
  the CLIENT, not something the taxpayer remits. `honorariosAnual` (`tasks/honorarios.ts`) reads
  ONLY `side: 'RECIBIDAS'` and must never be changed to also fetch or sum EMITIDAS — pinned by a
  wire-level guardrail test (`honorarios.test.ts`, "NEVER reads the EMITIDAS BHE report") that
  asserts every BHE CGI URL the task navigates to is the RECIBIDAS report. Investigated live
  2026-07-29 on an accountant's report of a suspected summing bug for Empresa A
  (a real taxpayer account): code audit + a live check of `bte list --emitidas` across three sampled months/
  years all returned zero boletas emitidas — the taxpayer (a ferretería) does not issue BHE at
  all, so even a hypothetical summing bug could not explain that client's reconciliation gap. No
  bug was found; this rule exists so a future change cannot reintroduce the conflation unnoticed.
- **A facade on a NEW SII host must be spiked against a direct POST/GET before assuming it works
  like the others — some backends need a bootstrap navigation + a paced wait, not just the
  request itself.** Found live 2026-08-03 building `portal/dj.ts` (ADR-030): a direct POST to
  `www2.sii.cl`'s DJ status endpoint, even with a fresh session and the correct `Referer`, returned
  a bare HTTP 401 — the SPA at that URL does an async session bootstrap on load (it pings its own
  `app/session/status`) that the REST API silently depends on. The fix (a `goto` to the UI page,
  THEN `pace()`, THEN the POST) was verified empirically: 0ms wait after `goto` failed every time,
  500ms succeeded consistently — the shipped facade paces at the project standard (1000ms) for
  margin. `bpst.ts` (ADR-029) already needed a bootstrap `goto` before its query POST, but DJ is
  the first facade where the wait duration itself is load-bearing, not just the navigation. Before
  building a new facade on a host not yet in this codebase, spike a bare request FIRST — a
  confident "the wire contract is X" is worthless if the transport has an undocumented
  precondition like this one.
- **Before committing to a high-risk decoder (GWT-RPC schema extraction, any reverse-engineered
  binary/compiled format), verify the exact client-side trigger that reaches the target endpoint
  — a link that LOOKS like the read surface may be a write/configuration flow for something
  adjacent.** Found live 2026-08-03 building `portal/notificaciones.ts` (ADR-032): a prior
  session located `linkexterno(4)` → a GWT-compiled app (`corenoti1Internet`) and reasonably
  hypothesized it was the Notificaciones READ surface (same `.nocache.js`/`.cache.js` signature
  as `peticiones`, ADR-020) — then correctly paused rather than build a GWT decoder at the end of
  a long session (see `docs/audits/2026-08-03-spike4-notificaciones-progress.md`). The NEXT
  session, before resuming that decoder work, re-read Mi SII's own unminified `misii.min.js` live
  and found `linkexterno(4)`'s real tooltip verbatim: "Solicitar, actualizar o revocar correo
  para notificaciones" — that GWT app configures WHICH EMAIL receives alert notifications, not
  reading their content. The actual read link ("Mis Notificaciones Vigentes") was a plain
  `call_option(201)` two lines away in the same page, hitting a completely different, much
  simpler legacy JSON CGI (`CViewCarta.cgi`) — no GWT decoding needed at all. **The general
  lesson: read the trigger's own label/tooltip and the exact JS function it calls before
  committing engineering effort to decode what it reaches — two links can sit side-by-side in
  the same menu, look equally "official", and go to unrelated flows (one read, one write).**
- **Elige la fuente de datos por su MODO DE FALLA, no por su elegancia — y cuando leas DOM
  renderizado, mapea por NOMBRE DE CABECERA, nunca por posición.** Encontrado en vivo 2026-08-04
  construyendo `portal/giros.ts` (ADR-034). ADR-020 estableció que la vía correcta para una app
  GWT es decodificar el GWT-RPC con un esquema derivado del permutation compilado, y rechazó
  explícitamente el scraping de DOM. Para `rfiInternet` (giros) esa vía resultó ser de una
  categoría de riesgo distinta: habla **GWT protocolo 7** (no el 5 de `sispadinternet`), con longs
  en base64, literales entre comillas simples que rompen el `JSON.parse` del códec existente, y un
  registro de deserializadores que obligaría a **re-derivar el extractor de esquema desde cero**
  sobre 255 tipos. Un esquema mal derivado **no falla ruidosamente**: corre un campo de posición y
  devuelve un **monto o una fecha de vencimiento silenciosamente equivocados** — sobre DEUDA
  FISCAL. La tabla renderizada, en cambio, estaba limpia y rotulada, y leerla mapeando por nombre
  de cabecera falla **fuerte** ("scraper roto") ante cualquier cambio. **La regla general: cuando
  dos fuentes dan el mismo dato, prefiere la que falla ruidosamente sobre la que puede mentir en
  silencio, aunque la ruidosa sea la "menos elegante" — y más aún si el dato tiene consecuencia
  legal o monetaria.** El corolario para DOM: un mapeo posicional reintroduce el fallo silencioso
  que se estaba evitando (insertar una columna corre todo); mapear por cabecera con una lista de
  cabeceras EXIGIDAS conserva el fallo ruidoso. Pinnéalo con tests que verifiquen ambas
  direcciones: insertar una columna nueva NO descoloca, renombrar una exigida SÍ revienta.
  **Advertencia de alcance:** ADR-020 rechazó el DOM por dos razones; solo una era falsa aquí
  ("los datos no están en globals limpios"). La otra —manejar una SPA es frágil— sigue siendo
  cierta y se asume como costo consciente: revalida en vivo estas fachadas más seguido.
- **Cuando una página del SII mezcla lectura y escritura, pinnea la restricción con un TEST, no
  solo con un comentario.** `portal/giros.ts` maneja una página titulada "CONSULTA Y **PAGO** DE
  GIROS" que expone un botón "Pagar" y enlaza `www2.sii.cl/pagogiro-ui/`. El script de manejo pulsa
  exclusivamente "Consultar", y un test verifica que la expresión enviada al navegador **no
  menciona "Pagar"** — así un cambio futuro que amplíe el script no puede deslizar una acción de
  escritura sin romper la suite. Mismo criterio para cualquier fachada sobre una página con
  acciones destructivas adyacentes (carpeta tributaria expone "Anular"; `sistgiInternet` expone
  declarar término de giro). El comentario documenta la intención; el test la hace exigible.
- **Never retry after a SII rate-limit / block.** It is server-side and timed;
  surface the message verbatim and stop.
- **In a multi-call fan-out, a per-item SII error stops the ITEM, not the batch.**
  When a task fans out N POSTs (a multi-folio/-period/-year loop) and ONE item
  returns a business/server error (e.g. F22 `historial`'s `buscaEventos` failing on
  a superseded folio — SII's own UI fails identically), capture that item's SII
  message VERBATIM in a per-item error list (F22's `foliosConError`) and continue
  with the rest; never retry it. A SESSION-level error (`NotAuthenticated` /
  `SessionExpired`) is NOT a per-item error and still aborts the whole fan-out. This
  refines "surface verbatim and stop" for the batch case: stop the item, surface it,
  keep the rest. (ADR-004)
- **Validate a RUT locally (Mod-11) BEFORE any login attempt.** A malformed RUT
  must never become a wasted submit — repeated failed logins lock the account.
  The CLI parses + Mod-11-checks the RUT before prompting/sending the Clave; a
  login (browser or `--console`) makes exactly ONE attempt, never auto-retried.
  (ADR-004 / ADR-010)

## Security, secrets & PII

- **The Clave never reaches the LLM and never lands in plaintext.** Login is
  either the user typing into SII's real page (browser, cookies-only) or a value
  in the OS keyring behind the `SecretStore` seam. No MCP tool accepts a
  password argument. (ADR-006)
- **Secrets are captured via a hidden terminal prompt — never a flag/env/arg.**
  The CLI `--console` login prompts the Clave with echo muted; it never accepts
  the Clave as a CLI flag, env var, or argument (no shell-history / argv /
  process-list leak). It is held in memory for one attempt, then discarded; only
  cookies persist. A task that takes a Clave (`consoleLogin`) is exported from the
  CLI-only `@dostertags/sii-core/cli` subpath, NOT the main barrel, so the MCP server cannot
  wire it. (ADR-006 / ADR-010)
- **Never commit** `*.pfx`, `*.p12`, `.env`, or anything under `.sii/`. Sessions
  are cookies-only; `.gitignore` blocks them — re-verify before any `git add`.
- **Audit every state-touching op** via the `AuditSink` port: `{ts, action, rut,
  result, durationMs?, ...extra}`. Keys whose lowercased name contains
  `password|clave|cookie|secret|token` are dropped before the line is written.
  The log is a receipt, never a gatekeeper — write failures degrade silently.
- **PII hygiene.** Real PII (nombre, RUT, dirección, email, teléfono, DoB) never
  lands in a tracked file — including CI guard denylists (hold those in a repo
  secret). Tests use synthetic, Mod-11-valid RUTs only. A task that surfaces the
  user's own PII carries an explicit opt-in name and states the exposure in its
  CLI help + MCP description; PII values never go to the audit log.

## Testing

- Tests must NOT hit production SII. Default mode is recorded fixtures with
  synthetic data; any live test is gated behind an explicit env var.
- Reproduce CI conditions before pushing (env stripped of any credential vars).

## Naming

- Files: kebab-case `.ts` modules. Tests: `<module>.test.ts` (vitest).
- Domain terms stay in Spanish where they are Spanish (`boletaHonorarios`,
  `propuestaF29`, `carpetaTributaria`). Don't anglicize SII terminology.
- User-facing surfaces (CLI verbs, MCP tool names) are English where no
  entrenched Spanish term exists (`status`, `login`, `profile`), Spanish where
  one does (`rcv`, `f29`, `bte`).
- Form/document codes stay numeric (`F29`, `F22`, DTE `33`/`39`).

## Commits & PRs

- One topic per commit. Conventional Commits subject (`feat(scope): …`),
  ≤72 chars. English everywhere (commits, branches, PRs).
- **One feature / work-unit per PR.** Don't bundle two distinct features even on
  the same branch — when a second feature emerges mid-branch, give it its own
  branch/PR (stacked if it depends on the first). Split BEFORE opening the PR.
- **Status docs go in a SEPARATE commit from feature code.** `CURRENT_STATUS.md`
  and `ROADMAP.md` bookkeeping is its own commit; the feature commit carries code
  plus its tightly-coupled docs only (the ADR + any `sii-contract/*.md`).
- **No AI attribution anywhere** — no `Co-Authored-By`, no "Generated with",
  no `🤖`, in any artifact that lands in git or on GitHub. Authorship is the
  human owner.
- `docs/` updates ship in the SAME commit as the code that motivated them.
