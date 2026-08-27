# `sii-auditor` — roadmap, handoff, and open questions

**Written:** 2026-08-06. **Scope:** `packages/auditor` (ADR-043) only. The 14 shipped SII read
surfaces are covered by `docs/ROADMAP.md`; this file is subordinate to it and does not restate it.

> **Read this first if you are starting a fresh session.** It is the single entry point for the
> nightly audit loop: what exists, what is next, what is blocked on a human, and what a contador
> must supply before the system can measure anything meaningful.

---

## 1. Where the system actually is

**1114 tests green** (444 in `packages/auditor`). Build and lint clean. Everything below was verified, not assumed.

| Layer | State | Evidence |
| --- | --- | --- |
| `ingest/` provenance recorder | **Done** | 78 live fetches captured; 55 unique artifacts; all re-hash |
| `store/` artifacts + entities | **Done** | file + in-memory, parity-tested |
| `extract/` 3 parsers + review queue | **Done** | f29-propuesta, bte-resumen, bpst-pagina; queue + extraction log file-backed (W3) |
| `eval/` golden set, metrics, gate | **Done** | 188/188 fields, accuracy 1.0; golden-set independence checked (W8) |
| `rules/` evaluator + findings | **Done** | 47 evaluator tests; fact-path vocabulary (W2); rules produce findings (W6) |
| `loop/` orchestrator | **Runs end to end**, split `fetch`/`learn` (ADR-044) | stages 1–2, 6–8 live; 3–5 pending (blocked on run history, by design) |
| `kb/` normativa | **Store + loader done (W4)** | no corpus loaded — coverage is structurally `null`; loading is a human sourcing task |
| `scoring/` detectors | **Primitives only** | median/MAD/robustZ done; 4 detectors deferred |
| `ask/` | **Contract only** | deferred by design until eval existed (it now does) |

### The three target metrics, honestly

```
EXTRACTION  188/188 → 1.0        real, and regressions are demonstrably caught
NORMATIVA   null (0 anchors)     no corpus. Not a bug — nothing has been loaded.
FINDINGS    null                 rules evaluate, but nothing produces findings yet
                                 and expected/findings.jsonl is EMPTY
```

Extraction accuracy of 1.0 is a **starting line, not an achievement**: one taxpayer, one year,
three parsers, 188 fields. It becomes meaningful only as engagements accumulate.

### Proof the gate is not decorative

Against the real 2023 artifacts, each mutation is a mistake this project has actually made or
warned about:

| Injected bug | Accuracy | Gate |
| --- | --- | --- |
| `bte-resumen` reads honorarios as retención | 1.0 → 0.9362 | reject |
| `bpst-pagina` reads bruto as retenido | 1.0 → 0.9149 | reject |
| `f29-propuesta` reads código **153** instead of **151** | 1.0 → 0.9362 | reject |

---

## 2. The critical path — and it is not code

**`expected/findings.jsonl` is empty.** Until it is filled, finding precision and recall are
structurally unmeasurable no matter how many rules get written. Everything else in the loop can be
built and will still have nothing to optimise against.

Filling it is **curation work by a contador**, not engineering. See §4.

---

## 3. Build order — ordered by what is UNBLOCKED

**Updated 2026-08-06** after the maintainer resolved two decisions and flagged two blockers.

**Work TDD.** Every unit names the test that must fail first. Nothing here is "write code then test
it" — the exit test is the specification.

### Resolved since the first draft

| Decision | Outcome |
| --- | --- |
| Autonomy (`BACKLOG.md` §1.1) | **Split accepted** → [ADR-044](decisions/044-loop-split-fetch-learn.md) |
| Normativa sourcing | **BCN Ley Chile + circulares SII + instrucciones de llenado** → [ADR-045](decisions/045-normativa-corpus-sourcing.md) |

### Blocked this week (not by code)

| Unit | Blocked on |
| --- | --- |
| **B1** — `expected/findings.jsonl` ground truth | a contador's confirmed **and dismissed** 2023 findings (§4.1) |
| **B2** — promote `reversa-nc-debito` | a taxpayer with an observed F29 código **538** (§4.2) |

Neither blocks anything below. Build in this order:

### ~~W1 — Split the loop into `fetch` / `learn` (ADR-044)~~ — **DONE 2026-08-10**
- `LoopConfig.stages` selects the run mode; `sii-auditor fetch` (stage 1) / `learn` (2–8) / `run`
  (all eight). `make nightly` → `learn`, new `make fetch`, `make nightly-all` keeps the old
  behaviour. 21 new tests (949 → 970).
- An unselected stage is recorded `skipped` with an explicit reason, never omitted. Because
  `skipped` now carries **two** meanings, a test pins that a not-selected skip is distinguishable
  from an idle one (`summary` says which) — otherwise stage 8's diff could not tell them apart.
- In `learn` the `PortalDriver` seam is **sealed** (every call throws), so "never reaches SII" is a
  property of the wiring, not a convention that stage selection happens to honour.
- `RunManifest.dataAsOf` = newest `retrievedAt` among artifacts considered, `null` when none, and
  **scoped to the swept subjects** — another taxpayer's newer artifact would over-claim this run's
  freshness, the one dangerous direction. A run with no configured subjects reports `null`.
- ⚠️ **Still owed by W7:** the report must LEAD with `dataAsOf` + its age in days and mark any OPEN
  period whose newest artifact predates today as *not verified today*. The field now exists; nothing
  consumes it yet, so ADR-044's obligation is only half discharged.

### ~~W2 — Fact-path validation (the silent-under-reporting gap)~~ — **DONE 2026-08-10**
- **The fact bag is now a vocabulary.** Which keys are PRESENT declares which facts exist:
  present non-null → the value; present `null` → legitimate absence (still `null`, still
  propagating, behaviour unchanged); **ABSENT → raises**, naming the path and the near-miss.
  A builder must therefore DECLARE a fact it knows about but lacks, rather than omitting it.
- `unknownPaths(expr, facts)` puts the previously-unused `referencedPaths()` to work. It is **not**
  redundant with the evaluator's throw: evaluation is lazy, so a bad path in an untaken
  `if`/`and`/`or` branch is never read and never raises — the rule looks healthy until the
  condition flips, then fails in a nightly run instead of at review time.
- **Found and fixed the real instance:** `rcvRowFacts` returned `{}` for a row with no DTE type.
  Omission was indistinguishable from a nonexistent path, so renaming `dte.tipo` would have
  degraded every row to "unknown" and reported nothing wrong. Now declares `{'dte.tipo': null}`,
  with a test pinning that the mapper always satisfies the vocabulary of the rule it feeds.
- 8 new tests (970 → 978).
- ⚠️ **NOT yet done, and deliberately:** nothing validates a rule at PROPOSE/PROMOTE time. That
  needs a declared fact-vocabulary registry — what paths *can* exist, independent of any one
  context — which does not exist until `extract` (W3) defines the fact surface. Wire
  `unknownPaths` into the promotion gate once it does; until then a rule is only checked against
  the bag it is actually run on.

### ~~W3 — `loop/stages/extract.ts` + the review queue~~ — **DONE 2026-08-10**
- **The routing rule holds:** at/above `REVIEW_THRESHOLD` → normalized store; below → review queue
  and NOT the store. Pinned at the boundary in both directions (`needsReview` is `< threshold`, so
  the threshold value itself is confident) and by a test asserting `upserted + queued === records`.
- **`createFileReviewQueue` is real** — append-only + fold-on-read. Pending is queued MINUS
  resolved, so a re-enqueue of an already-decided record does not resurrect it (otherwise depth
  measures run count, not health). Three malformed resolutions refused via one shared validator so
  the file and memory backends cannot drift.
- **Adds an extraction log** (`<root>/extractions/<runId>.jsonl` + `.failures.jsonl`). Required, not
  bookkeeping: `ArtifactStore.prune` already scans that directory for `provenance.artifact`, so a
  stage that routed without writing would let the next prune delete the bytes its own extractions
  cite. This was a live latent data-loss path before W3.
- **Adds `ExtractionStrategy.toEntities`** — only the parser knows the natural key its rows are
  identified by, and a guessed `entityId` collapses ADR-043 §I5. Optional, and its absence is
  REPORTED (`unprojected` counter + the strategy named in the summary), never silent.
- Memory peers for the queue and the log, with a parity test — `--in-memory` must exercise the real
  routing rule.
- 33 new tests (978 → 1011).
- ⚠️ **The three shipped strategies have no `toEntities` yet**, so a real run parses and routes them
  but upserts nothing, reporting them under `unprojected`. Writing those projections is domain work
  (which entity kind, which natural key per surface) and belongs with W5, when a real sweep produces
  artifacts to project. `registerCoreStrategies` also still throws — no strategy is wired into a
  production run yet.

### W4 — `kb/normativa` — **CODE DONE 2026-08-10; CORPUS STILL EMPTY (needs a human)**

W4 has two halves and only one of them is engineering. The machinery is finished; the corpus is a
sourcing task that ADR-045 deliberately keeps manual.

**Done (code):**
- `createFileNormativaStore` is real. `resolve(anchor, asOf)` returns the version in force on that
  date; a date before the earliest loaded version returns `null`, **not today's text**. Half-open
  interval — on a changeover day the new text governs. `history` / `anchors` / `search` land too;
  search applies the as-of filter FIRST and ranks by authority so a circular cannot stand in for
  a ley.
- `loadChunks` enforces the hard rule: ranges are COPIED from the source's version metadata, never
  inferred. Refuses a missing `from` (naming the anchor), inverted/empty ranges, empty text,
  missing provenance, and **overlapping versions of one anchor** — overlap would make `resolve`
  pick between two texts, and picking is guessing. The WHOLE batch is refused, never filtered:
  a partly-loaded corpus has gaps nobody declared.
- `sii-auditor normativa load <file.json>` / `normativa list`. The command **never fetches** —
  ADR-045 rejected scraper-plus-inferred-dates outright, so transcription stays human and the CLI
  validates what comes back. Refusals print cleanly and exit 1.
- Memory peer + parity test. Replaces the throwing `createNormativaLoader`.
- 31 new tests (1011 → 1042).

**NOT done (corpus) — this is the remaining W4 work, and it is not code:**
- Zero chunks are loaded, so `normativa.coverage` is still structurally `null` and `ask/` still
  declines every regulatory question. That is correct behaviour, not a regression.
- Scope stays the ~10 anchors the code already names. Start with the F29 instruction chunks for
  códigos **151 / 511 / 538** — what the reconciliation rules will cite.
- ⚠️ **The Art. 74 Nº 2 honorarios retention rate is NOT constant across years** (ADR-045
  Consequences). It must be read per-period from the dated instruction chunk and cited. No
  rate-based rule may ship until it is. This session did **not** load or assert any rate.
- Per ADR-045 the text lives in the user's LOCAL store (`~/.sii/auditor/normativa/`), never in this
  repository — BCN/SII text is not redistributed here.

### W5 — `loop/stages/ingest.ts` — **CODE DONE 2026-08-10; CANNOT RUN IN PRODUCTION YET**
- Taxpayers swept **sequentially** (ADR-005), each with its own recording runtime so artifacts are
  filed under its **own** key. Sweep order is sorted, not configuration order — a run-to-run diff
  must be signal, not iteration noise.
- **Failure isolation, one level up from the CONVENTIONS fan-out rule:** a per-step SII error stops
  the STEP; a session error stops that TAXPAYER (every later call would fail identically); neither
  stops the sweep. Nothing is ever retried. Paced through the `Clock` seam.
- **A sweep where EVERY taxpayer failed THROWS** rather than reporting `ok` with zero artifacts —
  usually it means nobody logged in, and `ingest` is fatal so the run aborts instead of letting
  `evaluate`/`gate` reason about a store that gained nothing. A taxpayer counts as failed only when
  NOTHING succeeded for it; one failed step among four is a partial read.
- The fetch plan is **data** (`FetchStep[]`, `ingest/plan.ts`); every step is a thin call into a
  shipped `core` task. **No fetch code, and none permitted.**
- **Fixed a latent double-recording bug this exposed:** `buildContext` wrapped the runtime with
  `recordingDriver` up front under a placeholder `'unassigned'` key. Since the stage must wrap per
  taxpayer, wrapping in both places would have recorded every response twice and filed one copy
  under a key belonging to nobody. The composition root now hands over an UNDECORATED runtime.
- 13 new tests (1042 → 1055).
- ~~🔒 BLOCKER — no way to say WHICH taxpayers to sweep~~ — **CLOSED 2026-08-10** by
  `src/subjects.ts`. Subjects come from `<store>/subjects.json`, never argv (a RUT is inside the
  boundary; a flag publishes it in the process list). `loadSubjects` returns **keys only** — the
  RUT and any alias never leave the function — canonicalises before hashing (two spellings must
  not split one subject's history), and validates Mod-11 locally before anything reaches SII.
  `loadSalt` is **write-once by construction**: creates only when absent, never overwrites, no
  rotate path (rotating is a data migration, not a config change), and refuses a non-hex or
  short salt rather than deriving brute-forceable pseudonyms. 12 tests.
- ✅ **Live-validated end to end 2026-08-10**: with a synthetic subject configured, stage 1 ran
  against real SII, filed 3 artifacts under the pseudonymous key, and reported one step failure
  with SII's verbatim message when the session expired mid-sweep — failure isolation working as
  designed (3 artifacts kept, taxpayer not counted as failed).
- ~~🔒 NEW BLOCKER — stage 1 does not check who is logged in~~ — **FIXED 2026-08-10.** Stage 1 now
  resolves the live session’s subject before sweeping: a match is swept; no match at all THROWS
  naming what to do; an undeterminable principal THROWS (a guess is worse than a stop); a configured
  subject the session is not for is SKIPPED with an actionable message. The principal’s RUT is read
  from the LOCAL session record (no extra SII call) and hashed at the composition root, so the stage
  still sees only a `TaxpayerKey`. `requireSessionMatch` defaults TRUE; it exists solely so tests can
  reach the multi-taxpayer isolation logic one real session cannot, and a test proves the default.
  **Re-verified against the live scenario that caused it: run aborted, ZERO artifacts recorded** —
  the same invocation had recorded three.
- ⚠️ **A multi-taxpayer sweep is N logins, not one.** ADR-006 keeps login interactive, so one
  process holds one session; the stage supports N because the store and manifest are multi-taxpayer,
  not because one invocation can authenticate as several people. A configured subject that is not
  logged in fails with SII's own message and the sweep moves on.

### ~~W6 — Findings from rules (`rules` → `ProducedFinding`)~~ — **DONE 2026-08-10**
- **A rule's expression is the ASSERTION THAT MUST HOLD.** A reconciliation is true when the figures
  agree, so a finding is raised when it is `false`. Written the other way round the `null` case
  becomes ambiguous, which is the whole risk here.
- **`null` NEVER produces a finding.** A month whose F29 was never read cannot be reconciled;
  calling that a discrepancy invents one out of missing data, and the fastest way to make a real
  finding ignored is to bury it in twenty that were never real. `collectUnknown` reports undecided
  rules SEPARATELY, so "reconciled" and "could not be checked" are never conflated.
- **Only `validated` rules produce findings** (ADR-043 §I4). `anomaly` and `classification` never
  auto-issue — `RuleKind` says so in as many words.
- **W2 pays off here:** a rule referencing an undeclared fact RAISES, naming the rule and the path,
  checking the WHOLE tree so a typo in an untaken branch is caught at review time rather than the
  night the condition flips.
- Materiality is DERIVED from a `within` rule's actual gap; `null` (never 0) for shapes where it
  cannot be computed, so an unquantified finding does not rank below a trivial quantified one.
- 19 new tests. Its **metric** stays `null` until B1 lands — expected, not a failure.
- ⚠️ **No rate-based retención rule was shipped, per the W4 constraint.** The Art. 74 Nº 2 rate is
  not constant across years and the corpus is still empty; the test rule reconciles two EXTRACTED
  figures (BHE+BPST vs F29 151) and asserts no rate at all.

### ~~W7 — `loop/stages/report.ts` (stage 8)~~ — **DONE 2026-08-10**
- **Discharges the ADR-044 obligation W1 left open.** The report LEADS with `dataAsOf` and its age,
  and marks an OPEN period whose newest artifact predates today as *not verified today*. `null`
  data is never reported as verified — it is the weakest of the three cases, not the middle one.
- **It is a diff.** A first run's delta is `null`, never 0 — "no change" and "nothing to compare"
  are different claims. A structurally unmeasurable metric is counted as **unmeasured**, not
  unchanged, so `normativa.coverage` being `null` cannot read as "held steady".
- **Fixed a real bug its own test found:** age was elapsed hours floored, so an artifact retrieved
  23:00 yesterday and read 03:00 today came out 0 days old — and 0 reads as *verified today*. Age
  is now CALENDAR days, which also rounds staleness up rather than down (the safe direction).
- **The report does not reproduce stage `detail`.** Details carry SII's verbatim messages, which can
  name a taxpayer, and the report is the artifact most likely to be pasted into a ticket. It names
  the failed stages and leaves the text in the manifest, inside the boundary.
  `assertNoIdentifiers` still runs over everything it does carry.
- 12 new tests. ⚠️ `rulesPromoted` / `rulesRetired` / `rejected` / `normativaAbsorbed` /
  `structuralChanges` / `reviewQueueDelta` are still empty — they need stages 3–5 and a persisted
  gate ledger, which do not exist yet. The fields are declared and rendered as empty rather than
  omitted, so nothing silently disappears when those stages land.

### W8 — Golden-set independence hardening
- **Test first:** for the sealed engagement, `honorarios` / `liquido` / `brutos` / `pagado` are each
  corroborated by an arithmetic identity, not only by a read-from-bytes.
- Today only the reconciled fields (`retencionReceptor`, `retenidos`) have independent corroboration
  — see §5. Until then those four fields are effectively decorative in the golden set.

**Deliberately not next:** stages 3–5 (absorb / mine / propose). They need ≥2 runs of history and
real auditor corrections before they can cluster anything. Building them now yields a generator with
nothing to generate from.

---

## 5. Open risks, stated plainly

| Risk | Status |
| --- | --- |
| **33 tracked files under `docs/` carry a real client's RUT and razón social** | Open. `confidential.ts` governs new modules; remediating history needs its own decision (ADR-019 set the precedent of not rewriting records). |
| **Golden set is one taxpayer, one year** | Accuracy 1.0 is not yet evidence of much. Needs a second engagement from a different régimen. |
| **BHE/BPST ground truth is corroborated but not fully independent** | W8 shipped the MECHANISM (`corroboration.ts`: arithmetic identities, cross-source, refusal of self-contradicting sets, `independenceRatio`). The sealed engagement still has to be ANNOTATED with identities — until then those four fields report as `uncorroborated`, which is now visible instead of implicit. |
| **Nota de Débito (56) netting unresolved** | Pinned by test as NOT reversing. Extending it requires an observation, not a guess (`BACKLOG.md` §3.5). |
| **Artifact store holds raw SII responses incl. counterparty PII** | Declared in ADR-043. ACL-hardened, outside the repo, but a larger on-disk footprint than before. |
| **`carpeta` facade 401s after ~10 calls/20 min** | Pre-existing (ADR-033). Re-verify spaced out before relying on it. |
| **`pnpm format` rewrites 148 files on Windows** | Found 2026-08-10. `core.autocrlf=true` with **no `.gitattributes`**, so the working tree is CRLF while Prettier defaults to `endOfLine: "lf"` — every file is "unformatted". Underneath that noise **51 files have genuine style violations** at HEAD (`npx prettier --check --end-of-line auto .`). Running `pnpm format` before a commit therefore buries the real diff in ~1.2k lines of churn. Needs a `.gitattributes` + one formatting-only commit, as its own topic. |
| **`scripts/metrics.mjs` has no test coverage** | It reads the real store and is now the daily-read instrument, but `vitest.config.ts` only includes `packages/**`, so nothing pins its reductions. A defect in exactly that spot (best-eval tie-break understating verified fields 188→48) survived until read by hand on 2026-08-10. |

---

## 6. How to resume in a fresh session

```bash
pnpm install && pnpm build && pnpm test          # expect 949 passing
make nightly-demo                                 # loop end-to-end, in-memory, no SII
SII_AUDITOR_STORE=~/.sii/auditor make nightly     # against the real store
```

**Orientation, in order:** `docs/decisions/043-nightly-auditor-loop.md` (the why) →
`packages/auditor/README.md` (the how) → this file (the what next).

**The knowledge graph** is at `graphify-out/graph.html` (3152 nodes, 7540 edges, 161 communities).
Query it with `/graphify query "..."` rather than re-reading the repo.

**Working style:** TDD. Every work unit in §3 names the test that must fail first. The project's
standing rule applies — *prefer the source that fails loudly over the one that can lie quietly*
(ADR-034) — and in this package that means `NotImplemented`, never a stub returning `[]`.

### State that lives outside the repo

| Path | Holds |
| --- | --- |
| `~/.sii/auditor/artifacts/` | raw SII responses, content-addressed |
| `~/.sii/auditor/golden/` | the sealed engagement + its evidence |
| `~/.sii/auditor/eval/` | persisted `EvalResult` per run |
| `~/.sii/auditor/runs/` | run manifests |
| `~/.sii/auditor-salt.json` | the pseudonymisation salt (`loadSalt` via core's `KeyValueStore`, key `auditor-salt`) — **never commit, never regenerate**. ⚠️ Verified 2026-08-10: `~/.sii/auditor/salt` is an ORPHAN nothing reads (written 2026-08-06 by a pre-`loadSalt` path); the live salt was minted 2026-08-10, so keys derived before/after that date differ — the 08-06 artifacts and the golden set are keyed under the OLD salt. Back up BOTH files. |

Regenerating the salt silently orphans every existing `TaxpayerKey`: the golden set would no longer
match any live sweep, and nothing would error.
