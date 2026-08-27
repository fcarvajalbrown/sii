# ADR-024: Compliance monitor (`monitor`) — snapshot + diff, minimal on-disk state

## Status

Accepted — 2026-07-25. The first surface that is **stateful across runs**. Builds on ADR-022's
composite shape (facade join inside one `withSession`, paced, session-keyed) and ADR-006's PII
posture. The unattended-scheduling layer is deliberately OUT of scope — see "Deferred".

## Context

Every one of the ten shipped modules is pull-based: it answers "what does SII say right now?"
and forgets. Nothing watches. That produced a measured failure on this very taxpayer:

- Observación **F121** on AT2019 was raised **20-05-2019** and sat unnoticed for **seven years
  and two months**. The data was reachable by `sii f22 observaciones 2019` the entire time.
- A **Renta 2025 non-filing** surfaced only incidentally, while reading an unrelated payload
  during a spike.

The cost of finding out late is not engineering time — it is interés, multas, and forfeited
prescription defences under Art. 200 CT. The reads already exist; what is missing is a baseline
to compare against and a verdict on what changed.

Two constraints shape the design.

**1. State lands on disk, and this is a tax-data tool.** A snapshot naively containing what the
reads return would put observación glosas, event descriptions and SII's free-text notes to the
taxpayer into `~/.sii/`. Those embed functionary names, amounts and taxpayer detail. The session
jar already lives there and — per the security review — its `0600` mode is a **no-op on
Windows**. So on-disk content is a real exposure, not a theoretical one.

**2. A first run has no baseline.** The naive implementation reports every observación, every
event and every missing month as "new" on first execution, which trains the user to ignore the
output permanently.

## Decision

Add `monitorSweep(runtime, { anios?, meses?, dryRun? })`.

- **Signals watched** (all from existing facades, ONE session, paced):
  `fetchF22Declaraciones` → `fetchF22Observaciones` + `fetchF22Historial` over the last `anios`
  años tributarios (default 3); `fetchF29Estado` over the last `meses` months (default 12);
  `fetchPeticiones`. ~22 POSTs.
- **The snapshot stores IDENTIFIERS AND STATES ONLY — never free text.** Persisted under the
  distinct `KeyValueStore` key `monitor` (ADR-007):
  - observaciones → the set of `codigo` strings per año (`"F121"`), **not** `descripcion`
  - eventos → a fingerprint per event, `codigo|fecha|folio`, **not** `glosa`
  - F29 → `periodo → tieneDeclaracion` booleans
  - peticiones → `numero → estadoActual` (already functionary-stripped by the facade)

  This is the load-bearing privacy decision: **fingerprints are sufficient to detect change
  exactly, and free text is not needed to do it.** The OUTPUT of a run may carry the glosa
  (it is the same exposure as running the underlying command, and it is what makes the report
  actionable) — but nothing free-text is written to disk. Output and storage are deliberately
  asymmetric.
- **First run establishes a baseline — but STATE findings are still reported.** This split was
  forced by the tests and corrects the naive rule. Two kinds of finding:
  - **CHANGE findings** (`observacion_nueva`, `observacion_resuelta`, `evento_nuevo`,
    `peticion_cambio_estado`) are meaningless without a baseline, so on run one they are
    suppressed and only counted in `resumen`.
  - **STATE findings** (`f29_mes_sin_declaracion`) are true *right now*, independent of any
    baseline, and are reported on **every** run including the first.

  A month with no F29 is a standing deficiency, not news that something changed. Suppressing it
  on run one to keep the "no false alarms" rule tidy would reproduce the exact failure this
  feature exists to prevent — a real problem sitting unreported because nobody had looked before.
  `baseline: true` still tells the caller the change-detection half is not yet armed.
- **Change model:** each `cambio` carries `tipo`, `severidad`, `ambito` and a short `detalle`.
  `alta` — a new observación, a new historial event (SII acted), or a month with no declaración.
  `media` — a petition changed state. `info` — an observación disappeared (resolved).
- **The snapshot is written ONLY on a completed sweep**, and never under `dryRun`. A partial
  snapshot would make the next run report phantom "resolved" items for signals it never read.
- **Session-keyed, self only.** F22, F29 and peticiones-as-used here all authorize by the
  principal; a representing operate pointer is rejected before any session opens. No `--rut`.
- **Per-signal resilience.** A single año or month failing is captured verbatim in `errores`
  and the sweep continues; a session-level failure aborts. Never retried (ADR-004).
- **Audit:** one receipt with `rut`, counts and `baseline`; never a código, glosa or monto.

## Alternatives Considered

- **Store the full read payloads as the snapshot.** Rejected — it is the simplest diff and the
  worst privacy outcome: SII free text (including functionary names inside petition notes) would
  be written to a file whose permissions are unenforced on Windows. Fingerprints detect change
  just as exactly.
- **Hash the entire payload per signal and diff hashes.** Rejected — it detects *that* something
  changed but cannot say *what*, so every alert would require a full manual re-read. The
  per-item fingerprint keeps the diff itemised at no extra privacy cost.
- **Add a `Notifier` seam now** (email/webhook). Rejected as speculative: there is no consumer
  yet, and the task already returns JSON-serializable data (ADR-012) that a caller can pipe.
  The seam lands with the scheduler, when it has a real user.
- **Treat "no declaración this month" as always `alta`.** Softened: the current month is
  excluded from the missing-months check, since a period that is still open is not yet late.
- **Report on first run.** Rejected — see Context 2.

## Consequences

- The tool gains an early-warning capability it structurally lacked. The F121 case would have
  surfaced on the first sweep after 20-05-2019 instead of seven years later.
- `~/.sii/monitor.json` is a **new on-disk artifact**. It is deliberately low-value if leaked
  (códigos, dates, booleans, petition numbers) — but it is still tax metadata, and it makes the
  unresolved Windows file-permission gap (security review F-02) more pressing, not less.
- **Deferred, and gated on a decision the maintainer must make:** unattended scheduling. A cron
  sweep needs a session, but only `login` mints one and the Clave must be human-typed (ADR-006).
  Resolving that means either implementing the declared-but-unbuilt `SecretStore` keyring
  adapter so `consoleLogin` can run unattended — a real loosening of ADR-006 that needs its own
  ADR — or accepting a prompted daily run. **Until then `monitor` is a manual command**, which
  still delivers the diff value; it simply must be invoked.
- Partially anticipates the read-through cache (roadmap): this introduces the first
  cross-run persisted state, and the cache should extend `monitor`'s store rather than add a
  second one.
