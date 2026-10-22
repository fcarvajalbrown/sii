# ADR-047: Demo GUI (`packages/web`) — a local web surface over core tasks

## Status

Accepted — 2026-10-22. Choices set by the owner: Vite and Preact, the "see, then audit" demo
script, and a live mode plus a synthetic demo mode.

## Context

The CLI and the MCP server serve a terminal and an LLM. Neither works for a client sitting across
the table, or for a projector at a public talk. The client pitch is "see your SII, audit your
accountant": show the taxpayer's position, then run the checks that already exist (`monitorSweep`,
ADR-024; `honorariosAnual`, ADR-023; `ivaMensual`, ADR-022) and list what they found. The same
screen is the base for a live demo at two events, where SII may be down and a real RUT should not
appear on a projector.

## Decision

Add a third surface, `packages/web` (`@dostertags/sii-web`, private, not published).

- **Server:** Node's built-in `http`, bound to `127.0.0.1` only. It serves the built client and a
  small JSON API: `GET /api/session`, `POST /api/login`, `GET /api/overview`, `POST /api/audit`.
  It calls `@dostertags/sii-core` tasks only (ADR-003), so throttling, the audit log and the
  session store apply as they do for the CLI.
- **Login** is the existing headed browser login (`login`, ADR-006/010), which opens SII's real
  page on the machine running the server; Clave Única works through it. No credential crosses
  the API.
- **Client:** Vite and Preact single-page app, UI strings in Spanish. Three steps: login, "Tu
  SII" (situación, 12-month F29 grid, F22 by year, the last closed month's RCV totals from
  `ivaMensual`), and "Auditar a mi contador" (findings with the figures and source behind each).
- **Audit is read-only:** `monitorSweep` runs with `dryRun: true`, so the GUI never moves the
  monitor baseline the CLI keeps.
- **Two modes behind one `Source` interface:** `live` (the tasks above) and `demo` (`--demo`), a
  fixed synthetic taxpayer from `packages/web/demo/taxpayer.json`. Every demo response carries
  `sintetico: true` and the UI shows a "Datos sintéticos" banner.
- **New dev dependencies, pinned exactly:** `vite@8.3.4`, `preact@10.29.8`. Vite compiles the
  JSX directly; `@preact/preset-vite` is not used because it pulls in `@babel/core`.

## Alternatives Considered

1. **Plain HTML and JS, no dependencies** — rejected by the owner in favour of a component
   framework the UI can grow on.
2. **Desktop app (Tauri)** — needs a Rust toolchain and is slower to reach a working demo.
3. **Terminal UI** — reads poorly on a projector and for clients who are not technical.
4. **Wiring `packages/auditor`'s recording runtime into live mode** — deferred. It needs the
   pseudonymisation salt and the artifact store; the first cut cites the task, período and
   figures behind each finding instead.

## Consequences

- A third surface means a third place where core changes must be reflected. The API keeps the
  task result shapes, so the client follows core types.
- The server binds to localhost and has no authentication of its own; it must never be exposed on
  a network interface.
- The demo fixture is synthetic and must stay marked as such everywhere it is shown.
