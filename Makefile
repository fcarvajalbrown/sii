# Convenience targets for the nightly audit loop (ADR-043).
#
# The rest of the repo is driven by pnpm scripts; this Makefile exists because the brief asks for
# `make nightly` and because the nightly entry point is what a scheduler invokes — a stable command
# name matters more here than consistency with the pnpm-script convention.
#
# On Windows this needs `make` (Git for Windows ships it, or `choco install make`). The equivalent
# pnpm invocation is given under each target so nothing depends on having make installed.

PNPM ?= pnpm
AUDITOR := $(PNPM) --filter @dostertags/sii-auditor

.PHONY: help build test typecheck lint fetch nightly nightly-all nightly-dry nightly-demo status resume eval clean metrics metrics-history

help:
	@echo "Nightly audit loop (ADR-043)"
	@echo ""
	@echo "  make fetch          Stage 1 ONLY. Needs a live session: run 'sii auth login' first."
	@echo "                      The only target that touches SII (ADR-044)."
	@echo "  make nightly        Stages 2-8 ('learn'). Never touches SII. THE SCHEDULER TARGET."
	@echo "  make nightly-all    All eight stages, for when a session exists."
	@echo "  make nightly-dry    Decide everything, promote and persist nothing"
	@echo "  make nightly-demo   Drive the state machine with in-memory stores (no SII, no disk)"
	@echo "  make status         Print the latest run manifest"
	@echo "  make resume RUN=<id>  Continue an interrupted run"
	@echo ""
	@echo "  make metrics        Daily growth snapshot (four families) + append to history"
	@echo "  make metrics-history  Print the recorded time series"
	@echo ""
	@echo "  make build / test / typecheck / lint"
	@echo ""
	@echo "Required environment:"
	@echo "  SII_AUDITOR_STORE        Absolute path to the artifact + entity store (OUTSIDE the repo)"
	@echo "  SII_AUDITOR_GOLDEN_DIR   Absolute path to the golden set of completed engagements"

build:                      ## pnpm build
	$(PNPM) build

typecheck:                  ## tsc -b
	$(PNPM) typecheck

test:                       ## vitest run
	$(PNPM) test

lint:
	$(PNPM) lint

# THE HUMAN-TRIGGERED HALF (ADR-044). Stage 1 alone, and the only target that reaches SII. It needs
# a live cookies-only session, so it follows a `sii auth login` — deliberately NOT schedulable,
# because ADR-006 keeps the Clave out of the keyring and out of any unattended process.
fetch: build
	node packages/auditor/dist/loop/cli.js fetch

# THE SCHEDULED ENTRY POINT (ADR-044). Stages 2-8: extract, absorb, mine, propose, evaluate, gate,
# report. Never touches SII — `extract` parses artifacts already in the store — so this runs at
# 03:00 with nobody present. Exits non-zero when a fatal stage aborts the run, so a scheduler can
# alert on it; a stage reporting `not_implemented` is NOT a failure and exits 0.
#
# It operates on data that may be days old. The manifest's `dataAsOf` says how old, and stage 8
# leads with it — a report that looks current while resting on stale data is the failure this
# package exists to prevent.
nightly: build
	node packages/auditor/dist/loop/cli.js learn

# All eight in one go, for when a session exists.
nightly-all: build
	node packages/auditor/dist/loop/cli.js run

nightly-dry: build
	node packages/auditor/dist/loop/cli.js learn --dry-run

# Exercises the orchestrator, manifest and resume logic with no SII access and no disk writes.
# Every stage reports honestly, including the ones that are not built yet.
nightly-demo: build
	node packages/auditor/dist/loop/cli.js run --in-memory

status: build
	node packages/auditor/dist/loop/cli.js status

# Corpus + learning-loop growth. Needs no build: it reads the repo and the store directly, so it
# still reports something useful on a night the build is broken.
metrics:
	node scripts/metrics.mjs

metrics-history:
	node scripts/metrics.mjs --history

resume: build
	@test -n "$(RUN)" || (echo "usage: make resume RUN=<runId>" && exit 2)
	node packages/auditor/dist/loop/cli.js resume $(RUN)

clean:
	$(PNPM) clean
