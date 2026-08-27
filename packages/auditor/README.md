# `@dostertags/sii-auditor` — the nightly audit loop

> Decision record: [ADR-043](../../docs/decisions/043-nightly-auditor-loop.md). Read it before
> changing anything here; it explains *why* each constraint exists, and several of them look
> arbitrary until you know the incident behind them.
>
> **Starting a fresh session?** Go to [`docs/AUDITOR-ROADMAP.md`](../../docs/AUDITOR-ROADMAP.md)
> — what is built, what is next, and what is blocked on a contador rather than on code.

A system that runs unattended every night, gets measurably better than it was the day before, and
answers analytical questions about a taxpayer's position **with cited evidence**.

Three things improve day over day, **in this priority order** — the order is enforced by the gate,
not just documented:

1. **Extraction accuracy** — parsing SII responses into normalized records correctly
2. **Normativa coverage** — how much applicable regulation the system can cite
3. **Audit finding quality** — precision and recall against auditor-confirmed outcomes

---

## Start here (five minutes)

```bash
pnpm install && pnpm build
```

```bash
make nightly-demo
```

That drives all eight stages with in-memory stores, touches neither SII nor the disk, and prints a
run manifest. Most stages will say `not_implemented` — **that is the correct output today**, and
reading it is the fastest way to understand what is built and what is not.

To run against a real on-disk store (the loop still stops where it is unbuilt, honestly):

```bash
SII_AUDITOR_STORE=~/.sii/auditor make nightly
```

`make nightly` runs `learn` — stages 2–8, which never touch SII. To fetch fresh data, log in first
and run the other half:

```bash
sii auth login && SII_AUDITOR_STORE=~/.sii/auditor make fetch
```

```bash
pnpm test
```

279 tests, all against fakes. Nothing in this package's test suite reaches SII, ever.

### Making an existing command evidence-backed, today

This works now and needs nothing else from this package — no golden set, no rules, no loop:

```ts
import { createRecordingRuntime, resolveStoreRoot } from '@dostertags/sii-auditor';
import { f22Formulario } from '@dostertags/sii-core';

const storeRoot = resolveStoreRoot(process.env.SII_AUDITOR_STORE, process.cwd());
const { runtime, artifacts } = createRecordingRuntime({ storeRoot, taxpayer: taxpayerKey(rut, salt) });

const form = await f22Formulario(runtime, { anio: 2025 });
// Every raw SII response behind that call is now in `artifacts`, hash-keyed, with a manifest
// carrying the URL, HTTP status and retrieval timestamp.
const evidence = await artifacts.findManifests({ urlContains: 'f22' });
```

---

## The five invariants

Everything else is a consequence of these. If a change violates one, the change is wrong — not the
invariant.

**1. Every assertion carries provenance.** Any number, rule or finding traces to a source document,
URL or regulation article, with a retrieval timestamp. *An answer without provenance is a bug.*

This is structural, not disciplinary. `ExtractionRecord.provenance` is required;
`Answer.citations` is typed as a non-empty tuple, so an uncited answer will not compile. And
provenance is captured automatically by `RecordingPortalDriver` — see [How ingest
works](#how-ingest-works-the-one-clever-part) below.

**2. No generative invention of regulation.** The system never states a tax rule from model
weights. It retrieves the rule text and cites it, or it returns `Declined` — a *different type*
from `Answer`, so a caller must handle "I don't know" explicitly and cannot render it as a soft
answer.

**3. Rules are data.** Tax logic lives in versioned `RuleRecord`s with confidence, provenance and
version history — not in TypeScript conditionals. Expressions are a small JSON AST evaluated by a
**total** interpreter: no loops, no recursion, no `eval`. Every expression terminates.

**4. Nothing self-modifies without passing a gate.** The loop *proposes*; `eval/gate.ts` *promotes*.
`rules/promotion.ts:promote()` requires a `GateApproval` and re-validates every field of it. There
is no code path that promotes a rule without a golden-set evaluation behind it.

**5. Every run is reproducible.** Same inputs + same rule-set version ⇒ identical output. Time comes
from the `Clock` seam, never `Date.now()`. JSON is serialised with sorted keys so content hashes are
stable. Stochastic components sit behind `scoring/model.ts` and are explicitly seeded.

**Plus the confidentiality boundary**, which is a function (`confidential.ts`), not a convention:

| Inside (may hold a real RUT) | Outside (`TaxpayerKey` only) |
| --- | --- |
| `store/artifacts` — raw SII responses | `kb/*` — normativa, behavior map |
| `store/normalized` — the entity model | `eval/results` — metrics per run |
| `~/.sii/*` — session, cache, monitor | `loop/manifest` — the nightly run record |
| the golden set | any external prompt or API payload |

`assertNoIdentifiers` runs before any manifest is persisted. It is a *backstop* — the real mechanism
is that outside-bound types have no field to put a RUT in.

---

## Module map

| Module | What it does | State |
| --- | --- | --- |
| `ingest/` | Wraps the shipped `core` facades; every raw response is captured with a manifest | ✅ |
| `store/` | Immutable content-addressed artifacts + a normalized relational model | ✅ (file + in-memory) |
| `extract/` | Versioned, registered parsers producing typed records with confidence + provenance | ✅ — 3 parsers; review queue deferred |
| `kb/` | Normativa (with `as-of` queries) + the webapp behavior map | schemas ✅, no corpus loaded |
| `rules/` | Rule records + the promotion state machine | ✅ — evaluator, state machine, rule #1 |
| `scoring/` | Robust-statistics anomaly baseline; learned-model seam behind it | primitives ✅, detectors deferred |
| `eval/` | **The most important module.** Golden set, metrics, the gate | ✅ — needs a real engagement |
| `loop/` | The eight-stage resumable orchestrator, split `fetch`/`learn` (ADR-044) | ✅ runs end to end; stages 6–7 live, 1–5 & 8 pending |
| `ask/` | Retrieval-grounded, always-cited question interface | contract ✅, deferred by design |

✅ = implemented and tested. Everything else throws `NotImplemented` with a message saying exactly
what must exist first — never a stub returning `[]` or `null`.

> **Why `NotImplemented` and not a stub:** a store that silently answers "no rows" is
> indistinguishable from a store that answers "nothing is wrong". Loud failure is the same instinct
> [ADR-034](../../docs/decisions/034-giros-dom-read.md) applied when it chose DOM reading over a
> re-derived GWT schema: *prefer the source that fails loudly over the one that can lie quietly.*

---

## How ingest works (the one clever part)

`packages/core`'s 14 facades return **curated projections**; the raw response body is decoded inside
`requestJson`/`requestForm`/`requestText` and thrown away. So a figure in a report could not be
traced to evidence, because the evidence was never kept.

The fix is a decorator on the `PortalDriver` seam:

```ts
const runtime = createNodeRuntime({ portal: recordingDriver(realDriver, ctx) });
```

Every session it hands out tees each raw response — bytes, URL, HTTP status, timestamp, content
hash — into the artifact store *before* the facade sees it. Consequences:

- **Zero changes to `packages/core`.** The facades never learn they are recorded, so this cannot
  drift out of sync with them the way a per-facade `provenance` argument would.
- **All six transports at once**, including ones added later. A new facade is recorded the day it
  is written, with no way to forget.
- **De-duplication is free and meaningful.** Tonight's F22 hashing to last night's value *is* the
  "nothing changed" signal.

Known limit, declared rather than hidden: `goto` records a URL-only artifact. DOM-reading facades
(giros, bte) get their real evidence from `evaluate`, whose *result* is recorded. The rendered DOM
itself is not reconstructible, and pretending otherwise would be a false citation.

---

## The nightly loop

An explicit, resumable state machine. The manifest is saved **after every stage**, which is what
makes a crash at stage 5 resume at stage 5 instead of re-fetching from SII (pacing is 1 req/s, and
[ADR-004](../../docs/decisions/004-port-sii-guardrails-and-tos-posture.md) forbids hammering it).

| # | Stage | Does | Fatal on failure? |
| --- | --- | --- | --- |
| 1 | `ingest` | Fetch new periods; detect structural change; flag broken selectors | **yes** |
| 2 | `extract` | Parse; record confidence; queue low-confidence for review | **yes** |
| 3 | `absorb` | Pull the three learning signals | no |
| 4 | `mine` | Cluster recurring failures into diagnoses | no |
| 5 | `propose` | Generate candidates at `candidate` status, low confidence | no |
| 6 | `evaluate` | Run the regression suite — **baseline every night**, plus the change-set | no |
| 7 | `gate` | Promote only what earns it; retain rejections with reasons | no |
| 8 | `report` | Diff of what the system knows today vs yesterday | no |

Stages 1–2 are fatal because everything after them operates on what they produced; continuing past
a partial ingest would evaluate — and possibly *promote* — against an incomplete night's data.

**Stage statuses are honest.** `ok` (did work) · `skipped` (legitimately nothing to do, **or** not
selected by the run mode) · `not_implemented` (hit a deferred body) · `failed` (threw). A stage
cannot report success for work it did not do, and SII's Spanish messages pass through **verbatim**,
never translated. The two `skipped` meanings are always told apart in `summary`/`detail` — a stage
is never silently absent from the manifest.

### Two run modes ([ADR-044](../../docs/decisions/044-loop-split-fetch-learn.md))

**Only stage 1 needs a live SII session.** `extract` parses artifacts already in the store, so
everything from stage 2 onward runs unattended. That is what decouples the cadence of *learning*
from access to SII: learning needs new strategies, new rules and auditor corrections — none of
which live at SII.

| Command | Stages | Session? | Who triggers it |
| --- | --- | --- | --- |
| `sii-auditor fetch` | 1 (`ingest`) | **required** | a human, after `sii auth login` |
| `sii-auditor learn` | 2–8 | never touches SII | the scheduler — **`make nightly`** |
| `sii-auditor run` | all eight | required | a human wanting everything at once |

In `learn` the `PortalDriver` seam is **sealed** — every call throws. ADR-044's guarantee is a
property of the wiring, not a convention that stage selection happens to honour.

```bash
sii-auditor fetch [--dry-run]               # stage 1 only; needs a session
sii-auditor learn [--dry-run] [--in-memory] # stages 2-8; never reaches SII
sii-auditor run   [--dry-run] [--in-memory] # all eight stages
sii-auditor resume <runId>                  # continue from the first unfinished stage
sii-auditor stage <runId> <stage>           # re-run exactly one (runs it regardless of mode)
sii-auditor status [runId]                  # print a manifest
```

Exit codes: `0` completed · `1` fatal stage aborted the run, or the context could not be built ·
`2` bad invocation.

### `dataAsOf` — how old the data is, separately from when the run happened

A `learn` run works on artifacts that may be weeks old, so `RunManifest.dataAsOf` carries the
**newest `retrievedAt` among the artifacts the run considered**, or `null` when it considered none.
Never a fabricated date, never `0`.

It is scoped to the swept subjects: another taxpayer's newer artifact would date this run's data to
someone else's, and over-claiming freshness is the one direction that is dangerous. A run with no
configured subjects reports `null` — it swept nobody, so it considered nothing.

`startedAt` says when the loop ran; `dataAsOf` says how old what it reasoned about is. Conflating
them would read *"the system improved"* as *"the tax situation is up to date"* — two different
axes. Stage 8 leads with this field and marks any OPEN period whose newest artifact predates today
as **not verified today**.

---

## The gate, in one example

```
extraction.accuracy   0.980 → 0.975   (−0.005, inside a widened tolerance)
findings.precision    0.800 → 0.900   (+0.100)
                                       ⇒ REJECTED (priority_violation)
```

A gain in a lower-priority metric may **not** buy a loss in a higher-priority one, even inside
tolerance. Everything downstream is derived from extraction, so trading it away is trading the
foundation for the view — and a tolerance band would let that happen a little every night, forever.

Two more failure-closed rules:

- **No golden set ⇒ reject everything.** An empty suite vacuously satisfies "no regression", so a
  naive gate promotes every candidate on exactly the night the golden set is misconfigured.
- **No baseline ⇒ reject everything.** A first run establishes the baseline; it does not promote
  against itself.

A night where every candidate is rejected is a **healthy** night.

---

## Adding a completed engagement to the golden set

The golden set is the **bottleneck of the entire system** and cannot be engineered around. Without
it the gate rejects everything and nothing improves.

**It is real engagements only — never synthetic.** A generated fixture encodes what we already
believe the parser does, so it reports 100% accuracy on the day the extractor breaks in a way we did
not anticipate. Every trap this project has hit (the missing BPST retención source, the
nota-de-crédito netting, per-page totals, the F29 plazo false positive) was invisible until real
data contradicted an assumption.

It lives at `$SII_AUDITOR_GOLDEN_DIR`, **outside the repository**, and is never committed.

```
<engagementId>/
  manifest.json              EngagementManifest — periods, régimen, corpus scope, sealedAt
  artifacts/                 the RAW SII responses the engagement was decided on, by content hash
  expected/extractions.jsonl ExpectedField per line — field-level ground truth
  expected/findings.jsonl    ExpectedFinding per line — INCLUDING dismissed ones
  expected/citations.jsonl   ExpectedCitation per line — the anchors relied on
```

Four things that are easy to get wrong:

1. **Copy artifacts from the store; never re-fetch.** Re-fetching gets *today's* answer, and the
   engagement was decided on that day's answer. This is the commonest way a golden set silently
   rots.
2. **Include the findings the auditor dismissed** (`confirmed: false`). Recall needs the misses;
   precision needs the false positives. A file of only confirmed findings measures neither.
3. **An unverified field is `verified: false`, not a guess.** It is excluded from the denominator —
   counting unchecked fields as correct is the fastest route to a meaningless 99%.
4. **Sealing is final.** Correcting a genuine mistake means a new version (`<id>-v2`), not an edit.
   Editing ground truth in place turns the harness into a mirror of whatever the code does now.

Full procedure with field-by-field notes: [`src/eval/golden.ts`](src/eval/golden.ts).

---

## Scheduling

The loop is a process that runs and exits. It has no scheduler of its own — deliberately; the
operating system's is enough ([ADR-044](../../docs/decisions/044-loop-split-fetch-learn.md)).

**Schedule `learn`, never `run`.** `learn` never touches SII, so it succeeds at 03:00 with nobody
present. Scheduling `run` would produce an identical `aborted` manifest every night until someone
logged in — and an operator learns to ignore a nightly alert that is always the same, which is the
exact failure ADR-024 designed the first runs to avoid.

**`fetch` stays a human act.** It needs a live session, and ADR-006 keeps the Clave out of the
keyring and out of any unattended process. Run it after `sii auth login`, when you have one.

**Recommended: 03:00 local, daily.** SII is quiet, and it leaves a working day before the report is
read. Ingest is paced at 1 req/s per ADR-004, so a multi-taxpayer sweep takes minutes, not seconds.

**Windows (this project's dev platform)** — Task Scheduler:

```powershell
schtasks /Create /TN "sii-auditor nightly" /SC DAILY /ST 03:00 /RL LIMITED /TR "cmd /c cd /d C:\path\to\sii && node packages\auditor\dist\loop\cli.js learn >> %USERPROFILE%\.sii\nightly.log 2>&1"
```

**Linux / macOS** — a systemd timer is preferable to cron (it survives a missed run via
`Persistent=true`, which matters for a laptop that was asleep at 03:00):

```ini
# ~/.config/systemd/user/sii-auditor.timer
[Timer]
OnCalendar=*-*-* 03:00:00
Persistent=true
```

Three operational notes:

- **The session expires, and that is why the loop is split.** Cookies-only sessions last roughly 10
  hours ([ADR-006](../../docs/decisions/006-auth-posture-browser-cookies-host-secrets.md)), and
  login is interactive by design — the Clave is typed into SII's real page and never stored. Rather
  than route around that (storing the Clave in the keyring was considered and **rejected**: it
  trades the project's strongest security property for scheduling convenience), the loop keeps the
  session-bound stage on the human side. `learn` is unaffected by an expired session.
- **Data ages even while the system improves.** In a week with no logins, `learn` keeps getting
  better — new strategies, re-extraction, re-evaluation — while the DATA gets staler. Read
  `dataAsOf`, not `startedAt`, to know which.
- **Never retry after an SII block.** It is server-side and timed. The loop surfaces the message
  verbatim and stops.
- **Alert on exit code 1**, not on `not_implemented` stages.

---

## Deliberately not here

- **No fine-tuning and no training pipeline.** `scoring/model.ts` declares the seam a learned scorer
  would implement and the constraints it inherits; nothing trains.
- **No chat interface.** `AskService.ask` is deferred until `eval/` exists — building it first would
  mean shipping an answer generator with no way to measure whether its answers are right.
- **No LLM where the answer should be deterministic.** The nightly report is a rendering of numbers
  already computed. Proposals in stage 5 are arithmetic over labelled corrections. An LLM may parse
  a question's intent or phrase a retrieved answer; it may never supply a figure, a finding or a
  regulation.
- **No heavy framework.** One dependency: `@dostertags/sii-core` (workspace). No database
  engine — `NormalizedStore` is SQL-shaped so a SQLite adapter drops in later without touching
  callers.
- **No accounting-statement generation.** This project has no source for a client's books.
  `dj detalle` ([ADR-031](../../docs/decisions/031-dj-detalle.md)) *reads* the balance de 8 columnas
  SII already holds and deliberately does not interpret it semantically. `JournalEntry` exists as a
  seam and is unpopulated — saying so is more useful than an empty table that looks authoritative.

---

## Where to start building

In dependency order, because each unblocks the next.

**~~1. `store/file-backed.ts`~~ — done.** Artifacts and entities on disk, plus the recorder wiring
(`createRecordingRuntime`). This is what makes any existing command evidence-backed, and it needed
nothing else.

**~~1b. The measurement chain~~ — done.** Golden-set reader, all three metric families, the eval
result store, the harness, and stages 6–7 wired to them. A nightly run now evaluates a baseline and
persists it, so trends are queryable the moment there is something to measure. `sii-auditor run`
today reports, honestly: *"baseline evaluated against an EMPTY golden set — the gate will reject on
no_golden_set."*

**~~2. The first golden engagement~~ — done, and sealed.** `2023-honorarios-retenciones`: 58
artifacts captured live through the recorder, 48 `ExpectedField` rows, **extraction accuracy 1.0
(48/48)**, golden version `94a3ba0b4b2954c3`.

Two things make it a measurement rather than a mirror:

- **Ground truth was read from the raw bytes** (plain `JSON.parse` of `data.listCodPropuestos`),
  never from the strategy's own output — and each `código 151` is independently corroborated by
  arithmetic, since BHE recibidas + BPST emitidas equalled it for all 12 months of 2023.
- **It demonstrably catches regressions.** Against the real artifacts: a parser reading código
  **153** instead of **151** (the confusion ADR-023 warns about) drops accuracy to **0.75**; an
  off-by-one-peso parser drops it to **0.5**. Both rejected by the gate.

One honest caveat found while proving that: the first mutation tried — "skip zero-valued códigos" —
was a **no-op**, because 0 of 181 códigos in the real evidence have value 0. Real data does not
exercise every path, which is exactly why the parser also has synthetic unit tests.

**~~3a. `f29-propuesta`~~ — done.** 21 unit tests. Output is `Record<código, valor>` so an
`ExpectedField` path is `codigos.151` rather than an index that breaks when SII reorders.

3. **`bte-mensual` and `bpst-mensual`** — the remaining two legs. Their artifacts are already staged
   and self-attributing (BHE's `evaluate` map carries `anio_consulta`/`mes_consulta`; BPST's HTML
   carries the período). Follow the `f29-propuesta` template, then extend the engagement's ground
   truth and re-seal as `-v2`.

   Bootstrap it from `docs/audits/2026-07-29-empresa-a-bpst-fix.md`, which already holds
   peso-exact, human-verified ground truth for two months (BHE recibidas + BPST emitidas
   reconciling to F29 código 151, plus the per-page pagination trap that under-counted a real month
   by 44.5%). Those artifacts predate the recorder, so re-fetch those two periods through
   `createRecordingRuntime` and **check the figures against what the audit recorded**. Match ⇒ a
   validated engagement with real artifacts. Mismatch ⇒ a closed 2023 period moved, which is itself
   worth knowing (ADR-027's "closed is not immutable", made concrete).

3. **Three strategies: `bte-mensual`, `bpst-mensual`, `f29-formulario`** — the three legs of that
   reconciliation, so the golden set can actually measure something. (Not `rcv-detalle` first,
   despite it being the widest surface: build what the golden set can measure.) Each needs its
   facade's raw-payload shape to compute `alias_fallback` / `unknown_keys` signals honestly, which
   is a per-facade change to `packages/core` that ADR-043 deliberately did not make blind.

**~~4. `rules/expression.ts:evaluate` + rule #1~~ — done.** 40 evaluator tests covering exactly the
cases where a bug is silently wrong arithmetic, and `TIPOS_REVERSA` migrated out of
`packages/core/src/tasks/iva.ts`.

The migration split one `Set` into **two rules**, because the source comment draws a distinction a
`Set` cannot carry: the crédito side was *observed* live across 16 months (confidence 0.9), the
débito side is explicitly *"inferred, not confirmed"* (confidence 0.3, and it stays a `candidate`
until a taxpayer with an observed código 538 verifies it). Behavioural equivalence with the `Set`
is pinned across 11 DTE types — including that Nota de Débito (56) is **not** treated as reversing,
which is still an open question in `BACKLOG.md` §3.5.

5. **`kb/normativa` corpus** — an editorial decision before a coding one: which bodies, which
   official source, what chunk granularity, and documented evidence for every effective date. A
   guessed date yields a confident citation of the wrong year's law. Scope it to the ~10 anchors
   the code already names, not "Chilean tax law".

**Resolved (`BACKLOG.md` §1.1 → [ADR-044](../../docs/decisions/044-loop-split-fetch-learn.md)):**
"nightly autonomous" collided with ADR-006. The loop is now split into `fetch` / `learn` — see
[Two run modes](#two-run-modes-adr-044). Note the cut is **1 / 2–8**, not the 1–2 / 3–8 first
proposed here: `extract` parses stored artifacts and needs no session, and leaving it on the
session side would have tied re-parsing with a new strategy to somebody logging in — the operation
most worth repeating cold.

**Open item inherited from ADR-043:** 33 tracked files under `docs/` carry a real client's RUT and
razón social (ADRs, audit logs, CONVENTIONS). `confidential.ts` governs the modules *here*;
remediating the existing exposure is separate work needing its own decision, because
[ADR-019](../../docs/decisions/019-publish-public-npm-personal-scope.md) set the precedent of not
rewriting historical records.
