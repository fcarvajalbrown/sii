# `@dostertags/sii-crawler`

Herramienta de **reconocimiento** (ADR-040) — NO es una fachada de producción. No la consumen el
CLI ni el MCP del proyecto; sus hallazgos son candidatos para revisión humana antes de promoverlos
a `docs/ESTADO-CONSOLIDADO.md` o a una fachada real con su propio ADR.

## Qué hace

Recorre superficies SII **de solo lectura**, siguiendo cada link que encuentra (no una lista fija
de páginas), partiendo de Mi SII y de las URLs ya conocidas del proyecto (`src/seeds.ts`). Por
cada página captura: HTML, título, headers, links salientes, y los recursos (`fetch`/XHR/scripts)
que cargó — vía `performance.getEntriesByType('resource')`, una API pasiva del navegador, sin
parchear nada. Opcionalmente resume cada página con **Llama 3.1** corriendo local en
[Ollama](https://ollama.com) (`http://localhost:11434`).

## Requisitos

- Una sesión SII **ya autenticada** (`node packages/cli/dist/main.js auth login`, desde la raíz
  del repo). El crawler **nunca hace login por su cuenta** (ADR-006) — si no hay sesión viva, se
  detiene y lo dice.
- [Ollama](https://ollama.com) corriendo local con `llama3.1` descargado (`ollama pull llama3.1`),
  si quieres los resúmenes (`--no-llm` para saltarlos).
- Playwright con Chromium instalado (`npx playwright install chromium`, una vez).

## Barreras de seguridad (no negociables — ver ADR-040)

- **Nunca hace click ni envía un formulario.** Solo navega (`GET`) a `href`s de texto plano.
- **Nunca ejecuta un `href="javascript:..."`.** Se registra para revisión humana, jamás se corre.
- **Denylist de escritura en código** (`src/denylist.ts`), derivado 1:1 de
  `docs/ESTADO-CONSOLIDADO.md` §4.3 — Llama 3.1 es una señal adicional para el reporte, NUNCA el
  mecanismo de seguridad real.
- **Solo dominios `*.sii.cl`.**
- **Aborta toda la corrida si aterriza en la página de login** — una cookie localmente vigente
  puede estar muerta en SII; seguir navegando ahí sería recorrer el sitio público creyendo que es
  una sesión autenticada (hallazgo real, ver el ADR).
- **Nunca reintenta.**

## Uso

Desde la raíz del repo (o `cd tools/crawler`):

```bash
pnpm --filter @dostertags/sii-crawler build
pnpm --filter @dostertags/sii-crawler crawl -- --max-pages 40 --max-depth 3
```

Flags (todos opcionales):

| Flag | Default | Qué hace |
|---|---|---|
| `--max-pages <n>` | 40 | Presupuesto de páginas por corrida. |
| `--max-depth <n>` | 3 | Profundidad máxima de links a seguir. |
| `--pace-ms <n>` | 1000 | Pausa entre navegaciones (mismo criterio que el resto del proyecto). |
| `--no-llm` | — | Salta el resumen con Llama 3.1 (corrida más rápida). |
| `--seed <url>` | (todas las semillas) | Recorre SOLO esa URL como semilla — útil para probar. |
| `--out <dir>` | `tools/crawler/out/` | Dónde escribir el reporte de esta corrida. |

## Salida

Cada corrida crea `out/<timestamp>/`:

- `REPORTE.md` — resumen legible: candidatos NUEVOS (URLs no catalogadas en
  `ESTADO-CONSOLIDADO.md`), links bloqueados por el denylist, handlers `javascript:` encontrados
  (para revisar a mano), y errores.
- `result.json` — la captura cruda completa (puede contener datos tributarios reales — nunca se
  commitea, `out/` está en `.gitignore`).
- `paginas/*.html` — el HTML de cada página NUEVA, para inspección rápida.

**El crawler nunca escribe en `docs/`.** Promover un hallazgo real a `ESTADO-CONSOLIDADO.md` o a
un ADR sigue siendo una decisión humana (ADR-004: nada que el LLM infiera se asume cierto sin
confirmar).

## Alimentar el grafo (`graphify`)

Si quieres construir un grafo navegable con lo que encontró el crawler (en vez de leer el
Markdown), corre el skill `graphify` sobre el directorio de una corrida:

```
/graphify tools/crawler/out/<timestamp> --update
```

Es un paso manual deliberado (ADR-040) — no se encadena automáticamente.

## Ejecución diaria

No hay una Tarea Programada configurada. El crawler solo tiene sentido dentro de una ventana de
sesión SII viva (~12h tras el login), así que una tarea desatendida a hora fija normalmente
encontraría la sesión expirada. Córrelo a mano cuando tengas una sesión activa, o prográmalo tú
mismo (Tarea Programada de Windows, o el skill `schedule`) si quieres automatizarlo — eso es una
configuración persistente del sistema y se decide aparte de esta herramienta.
