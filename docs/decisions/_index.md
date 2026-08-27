# Architecture Decision Records

Foundational decisions for the TypeScript rewrite. Lineage to the Python
`sii-cli` ADRs is cited inside each record where a rule is ported.

| ID  | Title                                                                                          | Status   | Date       |
| --- | ---------------------------------------------------------------------------------------------- | -------- | ---------- |
| 001 | [Adopt Context-First Development (CFD) for this repo](001-adopt-cfd-methodology.md)             | Accepted | 2026-06-27 |
| 002 | [TypeScript + Node + pnpm-workspaces monorepo toolchain](002-typescript-node-pnpm-monorepo.md)  | Accepted | 2026-06-27 |
| 003 | [Shared core consumed by CLI + MCP; injectable seams for external deps](003-shared-core-ports-adapters.md) | Accepted | 2026-06-27 |
| 004 | [Port the SII guardrails + ToS posture from sii-py](004-port-sii-guardrails-and-tos-posture.md) | Accepted | 2026-06-27 |
| 005 | [Single-account, operate-centric identity model](005-single-account-operate-centric-identity.md)| Accepted | 2026-06-27 |
| 006 | [Auth posture — browser cookies-only default + keyring fallback](006-auth-posture-browser-cookies-host-secrets.md) | Accepted | 2026-06-27 |
| 007 | [Modular core layout + worktree-parallel boundaries](007-modular-core-layout.md) | Accepted | 2026-06-27 |
| 008 | [Runtime library choices — commander CLI, browser-first auth](008-runtime-library-choices.md) | Accepted | 2026-06-27 |
| 009 | [NodeNext module resolution for Node-runnable surface builds](009-nodenext-module-resolution.md) | Accepted | 2026-06-27 |
| 010 | [CLI console login — headless form-fill to a cookies-only session](010-cli-console-login.md) | Accepted | 2026-06-28 |
| 011 | [Adopt zod for MCP tool input schemas (and wire-boundary validation)](011-zod-validation.md) | Accepted | 2026-06-28 |
| 012 | [JSON is the default output; `@altumstack/sii-core` is the JSON contract](012-json-default-output.md) | Accepted | 2026-06-29 |
| 013 | [F29 read surface — phased; robust SDI-JSON now, GWT-RPC presented form deferred](013-f29-phased-read-gwt-rpc-deferred.md) | Accepted | 2026-06-29 |
| 014 | [Unauthenticated `PortalDriver.requestPublic` seam for public login-free consultas](014-public-consulta-seam.md) | Accepted | 2026-06-29 |
| 015 | [Publish `@altumstack/sii-core` as a private package on GitHub Packages](015-publish-core-github-packages.md) | Accepted | 2026-06-30 |
| 016 | [Embeddable core — pure main barrel, `./node` composition subpath, optional Playwright peer](016-embeddable-core-node-subpath.md) | Accepted | 2026-07-02 |
| 017 | [BHE emission — the first write surface (`bte emit`) posture](017-bte-emit-write-posture.md) | Accepted | 2026-07-02 |
| 018 | [Public release under the MIT license](018-public-release-mit-license.md) | Accepted | 2026-07-02 |
| 019 | [Publish to public npm under the personal scope `@dostertags/sii-core`](019-publish-public-npm-personal-scope.md) | Accepted | 2026-07-02 |
| 020 | [GWT-RPC read capability behind the seam (SISPAD peticiones)](020-gwt-rpc-read-capability.md) | Accepted | 2026-07-03 |
| 021 | [Publish the CLI + MCP surfaces to public npm](021-publish-cli-mcp-surfaces-npm.md) | Accepted | 2026-07-03 |
| 022 | [Composite read surfaces (`iva`, `renta`) — facade-level joins inside one session](022-composite-read-surfaces.md) | Accepted | 2026-07-25 |
| 023 | [Honorarios & retenciones reconciliation (`honorarios`) — BHE ↔ F29, F22 surfaced](023-honorarios-reconciliation.md) | Accepted | 2026-07-25 |
| 024 | [Compliance monitor (`monitor`) — snapshot + diff, minimal on-disk state](024-compliance-monitor.md) | Accepted | 2026-07-25 |
| 025 | [Harden `~/.sii` on Windows — POSIX modes are a no-op there](025-windows-local-state-acl.md) | Accepted | 2026-07-25 |
| 026 | [LLM-facing write posture — preview-bound confirmation, opt-in registration](026-llm-write-surface-posture.md) | Accepted | 2026-07-25 |
| 027 | [Local read-through cache — closed periods only, bounded staleness](027-local-read-cache.md) | Accepted | 2026-07-25 |
| 028 | [RCV `raw` becomes opt-in — the last surface shipping uncurated rows](028-rcv-raw-opt-in.md) | Accepted | 2026-07-25 |
| 029 | [BPST — Boleta de Prestación de Servicios de Terceros Electrónica, and its role in `honorarios`](029-bpst-boleta-terceros.md) | Accepted | 2026-07-29 |
| 030 | [Estado de Declaraciones Juradas (`dj status`) — the first read of the DJ system](030-dj-status.md) | Accepted | 2026-08-03 |
| 031 | [DJ content — presentation history + the actual balance/RLI figures (DJ 1926)](031-dj-detalle.md) | Accepted | 2026-08-03 |
| 032 | [Notificaciones / Correspondencia — closing the citación-visibility gap](032-notificaciones-correspondencia.md) | Accepted | 2026-08-03 |
| 033 | [Carpeta Tributaria Regular — read-only historial of issued dossiers](033-carpeta-tributaria-historial.md) | Accepted | 2026-08-03 |
| 034 | [Giros (`giros list`) — leer el DOM renderizado en vez de decodificar GWT-RPC](034-giros-dom-read.md) | Accepted | 2026-08-04 |
| 035 | [Situación tributaria — cumplimiento Ley COT, régimen y perfil](035-situacion-tributaria.md) | Accepted | 2026-08-04 |
| 036 | [Acuse de DTE (`dte acuse`) — derivado del RCV, no una fachada nueva](036-dte-acuse-derivado-rcv.md) | Accepted | 2026-08-04 |
| 037 | [`monitor` amplía su barrido a las señales de los ADR-030..035](037-monitor-senales-ampliadas.md) | Accepted | 2026-08-04 |
| 038 | [`monitor` — plazo real del F29 y anclaje por `fechaInicioActividades` (P1+P2)](038-monitor-plazo-y-anclaje-perfil.md) | Accepted | 2026-08-05 |
| 039 | [Informe bancario (`bancario resumen`) — abonos por semestre, la brecha E1](039-informe-bancario-transferencias.md) | Accepted | 2026-08-05 |
| 040 | [Crawler de reconocimiento (Playwright + Llama 3.1 local) — herramienta, no fachada](040-crawler-reconocimiento-llama.md) | Accepted | 2026-08-05 |
| 041 | [Superficie `profile` — domicilio propio + socios/representantes con opt-in explícito](041-profile-opt-in-terceros.md) | Accepted | 2026-08-05 |
| 042 | [Seam binaria (`requestBinary`) + descarga de PDF de cartas](042-binary-download-seam-pdf.md) | Accepted | 2026-08-06 |
| 043 | [Bucle nocturno de auditoría — procedencia, reglas como datos, compuerta de promoción](043-nightly-auditor-loop.md) | Accepted | 2026-08-06 |
| 044 | [El bucle se parte en `fetch` (con sesión) y `learn` (desatendido)](044-loop-split-fetch-learn.md) | Accepted | 2026-08-06 |
| 045 | [Fuentes del corpus de normativa — BCN, circulares SII, instrucciones de llenado](045-normativa-corpus-sourcing.md) | Accepted | 2026-08-06 |
| 046 | [`extract` descubre artefactos pendientes en el almacén, no en su propia corrida](046-extract-descubre-pendientes.md) | Accepted | 2026-08-10 |
