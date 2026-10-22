# `@dostertags/sii-web`: demo GUI

A local web page that shows a taxpayer's SII position and then audits it: months with no F29, F22 observaciones, giros with a balance, honorarios retentions against F29 código 151, and RCV IVA against the F29 propuesta. Decision record: [ADR-047](../../docs/decisions/047-demo-gui-web-surface.md).

## Run

```bash
pnpm install
pnpm --filter @dostertags/sii-web build
```

Demo mode serves a fixed synthetic taxpayer (`demo/taxpayer.json`) and shows a "Datos sintéticos" banner. Use it on stage.

```bash
pnpm --filter @dostertags/sii-web demo
```

Live mode reads the real SII. "Iniciar sesión" opens SII's own login page in a browser window on the same machine; Clave Única works there. The password is typed into SII's page and never reaches this server.

```bash
pnpm --filter @dostertags/sii-web start
```

Then open `http://127.0.0.1:5180`. `--port <n>` changes the port.

For client development, run the server on 5180 and `pnpm exec vite` inside `packages/web`; Vite proxies `/api` to it.

## Limits

- The server listens on `127.0.0.1` only and has no login of its own. Do not expose it on a network.
- The audit is read-only: the monitor runs with `dryRun`, so it never moves the baseline the CLI keeps.
- Honorarios and IVA are compared against SII's F29 propuesta, not the filed form (ADR-013).
- Live mode makes many paced requests. The overview takes about a minute, and the audit several.
- Findings cite the task, período and figures behind them. They do not yet link to raw SII artifacts from `packages/auditor`.
