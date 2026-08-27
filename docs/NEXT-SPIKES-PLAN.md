# Plan: 5 spikes nuevos para `sii-core` — DJ, balance/EERR, carpeta tributaria, notificaciones

**Preparado:** 2026-07-29. **Actualizado:** 2026-08-03 — los CINCO candidatos originales están
CERRADOS. Ver `docs/audits/2026-08-03-spike1-dj-status.md`, `2026-08-03-spike2-3-dj-detalle.md`,
`2026-08-03-spike4-notificaciones-progress.md` (progreso parcial de una sesión anterior),
`2026-08-03-spike4-notificaciones-close.md` y `2026-08-03-spike5-carpeta-tributaria.md` para el
detalle completo de cada uno. **Este plan queda cerrado como documento de trabajo activo** — el
seguimiento pendiente (fiabilidad del endpoint de carpeta tributaria, `cterevisar`, filtrado por
institución, DJ 1943/otros años, etc.) vive en los ADR-030..033 y los contratos de wire
respectivos, no como nuevas filas aquí. Este archivo es autocontenido — no asume que quien lo lee
tiene memoria de la sesión donde se armó.

## Estado final (2026-08-03)

| # | Candidato | Estado | Entregable |
|---|---|---|---|
| 1 | Estado de DJ | ✅ Cerrado, live-validado | `sii dj status` / `dj_status`, ADR-030 |
| 2+3 | DJ 1943 (RLI) + DJ 1926 (balance) | ✅ Cerrado, live-validado (un solo hallazgo: DJ 1943 no existe para el RUT probado; DJ 1926 cubre ambos) | `sii dj historial`/`dj detalle`, `dj_historial`/`dj_detalle`, ADR-031 |
| 4 | Notificaciones/Citaciones | ✅ Cerrado, live-validado — **el routing supuesto (GWT `corenoti1Internet`) resultó ser un flujo de escritura no relacionado**; el surface real es la legacy `CViewCarta.cgi` de Mi SII (form-POST→JSON, sin GWT) | `sii notificaciones list`/`detalle`, `notificaciones_list`/`notificaciones_detalle`, ADR-032 |
| 5 | Carpeta Tributaria Electrónica | 🚧 Construido + probado (fakes); wire contract live-capturado 3× limpiamente, pero la verificación final en vivo del binario falló con 401 tras ~10 llamadas en ~20 min — re-verificar espaciado en una sesión futura antes de uso sensible a tiempo | `sii carpeta historial`/`carpeta_tributaria_historial`, ADR-033 |

## Contexto (léelo antes de tocar código)

`sii-core` es un monorepo TypeScript que automatiza la lectura (y algo de escritura) del portal
del SII chileno para un contribuyente y las empresas que representa. Cada superficie de lectura
(F22, F29, RCV, BTE, BPST, peticiones, …) sigue el MISMO patrón, documentado en
`CLAUDE.md`/`docs/CONVENTIONS.md`/`docs/ARCHITECTURE.md`. **Léelos antes de escribir una sola
línea** — en particular:

- **ADR-004** (no inventar wire contracts — todo endpoint citado debe venir de una observación en
  vivo, con fecha).
- **ADR-029** (`docs/decisions/029-bpst-boleta-terceros.md`) — el precedente MÁS RECIENTE y más
  relevante: un spike completo, de cero, de un producto SII nunca antes leído, en el mismo estilo
  que este plan pide repetir. Su log de implementación
  (`docs/audits/2026-07-29-empresa-a-bpst-fix.md`) muestra el flujo completo paso a paso:
  spike en vivo → contrato de wire → ADR → implementación TDD → verificación en vivo. **Sigue ese
  mismo flujo para cada uno de los 5 candidatos de este plan.**
- `docs/CONVENTIONS.md` — sección "SII domain rules" completa, especialmente las reglas sobre
  `raw`/PII, session-keyed vs. body-RUT, y el patrón "un módulo = un archivo + una función
  `register<Mod>`".

## Reglas duras — no las rompas

1. **Solo lectura en todo este plan.** Ningún spike aquí descrito debe someter un formulario que
   modifique algo en SII. Si un candidato resulta ser inherentemente de escritura, deténte y
   consúltalo con el usuario antes de avanzar.
2. **Un spike a la vez, con autorización explícita antes de abrir la sesión real.** Cada spike
   navega el portal SII EN VIVO con la sesión autenticada del titular — no es una simulación.
   Antes de ejecutar el spike de un candidato, confirma con el usuario que puedes proceder (puede
   requerir que el titular haga `auth login` de nuevo si la sesión expiró).
3. **No inventes ni asumas un endpoint.** Todo host/path que termine en el código debe estar
   citado con `// observed <host/path> on <YYYY-MM-DD>` — exactamente como lo hace
   `portal/bpst.ts`. Si no puedes observarlo en vivo, no lo escribas.
4. **Ritmo:** todas las llamadas a SII van paceadas vía el seam `Clock.sleep` (1 req/s por
   defecto, `DEFAULT_SETTINGS.rateLimitRps`). Nunca dispares en paralelo. Si el SII responde
   429/503, DETENTE — no reintentes.
5. **TDD siempre:** escribe el test que debería fallar contra el comportamiento actual, confírmalo
   en rojo, implementa, confírmalo en verde. Esto ya se hizo así para BPST — sigue el mismo
   patrón visible en `packages/core/src/portal/bpst.test.ts` y `packages/core/src/tasks/bpst.test.ts`.
6. **Guardrails antes de cerrar cualquier candidato:**
   ```
   npx vitest run          # suite completa, 0 fallos
   pnpm build               # tsc -b, sin errores
   pnpm lint                # eslint, limpio
   ```
   más una verificación en vivo (solo lectura) contra un RUT real antes de dar el candidato por
   cerrado.
7. **Todo lo que uses de `docs/` (ADR, contrato de wire, ROADMAP, CONVENTIONS) se actualiza en el
   MISMO commit que el código** (regla ya existente del proyecto, ADR-007).

## Cómo explorar en vivo — el patrón ya probado (ADR-029)

Para ubicar un endpoint nuevo sin arriesgar el código de producción, se usó un script desechable
(fuera del repo, en un directorio de scratch) que importa el runtime YA COMPILADO del core y abre
una sesión real:

```js
import { createNodeRuntime } from 'file:///<ruta-absoluta>/sii/packages/core/dist/node.js';
import { withSession } from 'file:///<ruta-absoluta>/sii/packages/core/dist/auth/index.js';

const runtime = createNodeRuntime();
await withSession(runtime, async (session) => {
  const landed = await session.goto('https://misiir.sii.cl/cgi_misii/siihome.cgi');
  const links = await session.evaluate(`
    Array.from(document.querySelectorAll('a')).map(a => ({
      text: (a.textContent || '').trim(), href: a.getAttribute('href') || ''
    })).filter(l => /<palabra clave>/i.test(l.text) || /<palabra clave>/i.test(l.href))
  `);
  console.log(links);
});
```

Requiere que el core esté compilado (`pnpm build`) y que exista una sesión guardada
(`sii auth login` ya corrido). Desde ahí: seguir los links reales que aparecen en el menú de Mi
SII hasta encontrar la app real (host + path), inspeccionar el HTML/JSON que devuelve
(`session.goto` + `session.evaluate`, o `session.requestForm`/`session.requestJson` según la
forma que tenga), y SOLO ENTONCES escribir el facade de producción. Este fue exactamente el
camino que llevó a descubrir que BPST vive en `zeus.sii.cl/cvc_cgi/bte/` — un host y una forma de
wire que nadie había observado antes en este proyecto.

## Los 5 candidatos, en el orden recomendado

### 1. Estado de Declaraciones Juradas (fundacional — hacer primero)

**Por qué:** hoy no existe ningún equivalente a `f22 status`/`f29 overview` para DJ — no hay forma
de saber qué DJ están presentadas, pendientes o vencidas. Sin esto, los candidatos 2 y 3 no tienen
con qué contrastar completitud (no se sabe si falta buscar un folio o si simplemente no hay DJ
presentada ese año).

- **Precedente:** ninguno — no implementado. `docs/ROADMAP.md` tiene una fila `📋 sii dj` /
  `dj` ya anotada como planeada, sin endpoint observado.
- **Área probable:** Mi SII → "Declaraciones juradas" (posiblemente una SPA moderna sobre
  `www4.sii.cl`, dado que F22/F29/RCV ya son así — pero puede ser legacy; hay que verlo en vivo).
- **Riesgo:** bajo si es SDI-JSON (patrón ya dominado); medio si resulta ser una forma nueva.
- **Entregable:** `docs/sii-contract/dj-status.md`, ADR-030, `portal/dj.ts` + `tasks/dj.ts` + CLI
  (`sii dj status <anio>`) + MCP (`dj_status`).

### 2. DJ 1943 — Renta Líquida Imponible (RLI) y Balance

**Por qué:** `docs/BACKLOG.md` §7 ya documenta esto como la causa raíz de una observación F121 real
— hoy hay que cruzarla a mano, sin ninguna lectura automatizada.

- **Precedente:** `docs/BACKLOG.md` §7 (léelo — tiene el contexto exacto del observación F121).
- **Área probable:** el mismo visor de DJ presentada del candidato 1, folio específico 1943.
- **Riesgo:** medio — formulario estructurado con varios códigos, puede requerir curado
  cuidadoso de PII (RUT de socios, montos) igual que F22.
- **Depende de:** candidato 1 (para ubicar el folio de la DJ 1943 de un año dado).

### 3. DJ 1926 — Balance Tributario (8 columnas) / Estado de Resultados

**Por qué:** es literalmente el "balance y EERR tributario" — el pedido explícito que motivó este
plan. Cero soporte hoy.

- **Precedente:** ninguno formal — pedido directo del usuario en la sesión que generó este plan.
- **Área probable:** mismo visor de DJ que el candidato 2, formulario 1926.
- **Riesgo:** medio-alto — un grid de 8 columnas típicamente trae muchos códigos contables; el
  curado (qué es PII vs. qué es dato tributario) requiere la misma disciplina que se aplicó en
  F22 (denylist de PII, nunca allowlist de códigos tributarios — ver CONVENTIONS.md).
- **Depende de:** candidato 1; comparte visor con el candidato 2.

### 4. Notificaciones / Citaciones (Art. 63) — el que más avanzado está

**Por qué:** durante la auditoría de Empresa A, lo único que se pudo decir fue "sin
`fechaCitacion` en el historial de F22" — NO una confirmación real de que no exista una citación
por otra vía. Una citación Art. 63 interrumpe la prescripción del Art. 200 — es información con
consecuencia legal real.

- **Precedente:** `docs/ROADMAP.md`, fila `📋 sii notificaciones` — **el routing YA ESTÁ
  UBICADO** de un spike anterior: `linkexterno()` en Mi SII resuelve a `corenoti1Internet`, cuyo
  host `emin.sii.cl` es un alias interno de `www4.sii.cl` (ya probado: la misma tabla lista
  `propuestaf29ui` bajo `emin` mientras `portal/f29.ts` lo alcanza en `www4`). Ambos
  `www4.sii.cl/corenoti1Internet/` y `www4.sii.cl/seeui/see/internet` quedaron confirmados como
  destinos válidos (el muro de login los devolvió como destino post-login). **Falta capturar el
  payload real** — quedó bloqueado la vez anterior por expiración de sesión (~10h de vida útil).
  También se identificó `Mi SII`'s propio `CViewCarta.cgi` (POST `opc=<n>`) como una QUINTA forma
  de wire: JSON con un envelope `{codigoError, descripcionError, sysdate, …}`, DISTINTO del
  envelope SDI `respEstado` — necesita su propio schema zod. Los PDF de cartas se leen vía
  `www3.sii.cl/Coreca1Internet/MuestraPdf?`, con la clave `codCarta` ya expuesta en
  `f22 historial`.
- **Área probable:** `www4.sii.cl/corenoti1Internet/` o `www4.sii.cl/seeui/see/internet`.
- **Riesgo:** medio — el routing ya está resuelto, así que el trabajo restante es capturar el
  payload con una sesión fresca (recién logueada, no una de 10 horas) y decidir el schema zod.
- **Nota:** este es el candidato con MENOS incertidumbre de routing — podría ir primero en la
  práctica si se prioriza cerrar el hueco de auditoría por sobre lo fundacional del candidato 1.

### 5. Carpeta Tributaria Electrónica

**Por qué:** es el dossier consolidado que el propio SII genera (el que piden los bancos para
créditos) — resumen de situación + cifras clave en un solo documento. Sirve como cruce
independiente contra los otros módulos (F22, DJ, balance).

- **Precedente:** ninguno — solo mencionado como concepto en `docs/ARCHITECTURE.md` ("carpeta
  tributaria" listada junto a "situación tributaria" como parte de "everything-not-DTE").
- **Área probable:** Mi SII → Situación tributaria / Carpeta tributaria electrónica.
- **Riesgo:** medio — es el más incierto en forma: si termina siendo generación de un PDF sin
  datos estructurados detrás, el "curado" real es mínimo (guardar el PDF, no parsear un grid) y
  el valor de un facade dedicado baja. Evaluar esto EN VIVO antes de comprometerse a construir un
  parser — puede que solo valga la pena un `carpeta descargar <rut>` que guarde el PDF.
- **Independiente** de los candidatos 1–4 — puede hacerse en cualquier momento.

## Cómo arrancar la conversación nueva

1. Lee este archivo completo, más `docs/decisions/029-bpst-boleta-terceros.md` y
   `docs/audits/2026-07-29-empresa-a-bpst-fix.md` — son el precedente exacto a replicar.
2. Confirma con el usuario: ¿con cuál de los 5 candidatos empezamos? (Recomendado: candidato 1,
   por ser fundacional y de menor riesgo — o candidato 4/Notificaciones si se prioriza cerrar el
   hueco de auditoría, dado que su routing ya está resuelto.)
3. Verifica sesión: `node packages/cli/dist/main.js auth status --refresh`. Si expiró, pide al
   titular `auth login` antes de continuar.
4. Ejecuta el spike de ESE candidato únicamente (script desechable en el directorio de scratch,
   solo lectura, paceado). Documenta lo encontrado en `docs/sii-contract/<candidato>.md` antes de
   escribir código de producción.
5. Escribe el ADR correspondiente (siguiente número disponible en `docs/decisions/_index.md`).
6. Implementa con TDD siguiendo el patrón de `bpst.ts`/`bpst.test.ts` (facade → task → CLI → MCP,
   cada uno con su test, registro append-only en `index.ts`/`program.ts`/`server.ts`).
7. Corre los guardrails (sección "Reglas duras", punto 6) antes de dar el candidato por cerrado.
8. Actualiza `docs/ROADMAP.md` (nueva fila), `docs/decisions/_index.md` (nueva entrada), y
   `docs/CONVENTIONS.md` si el spike revela un patrón nuevo que valga la pena documentar como
   regla general.
9. Repite desde el paso 2 para el siguiente candidato — SIEMPRE confirmando antes de abrir una
   nueva sesión real de exploración.

## Qué NO asumir

- No asumas que los 5 candidatos comparten el mismo host o la misma forma de wire — SII ya tiene
  CUATRO formas de wire distintas en este proyecto (SDI-JSON, inline-JS-map, form-POST→HTML de
  BPST, GWT-RPC de peticiones) y una quinta ya anotada para notificaciones
  (`{codigoError, descripcionError, ...}`). Cada candidato puede ser una sexta o séptima forma.
- No asumas que un candidato es viable como facade estructurado hasta verlo en vivo (ver la nota
  del candidato 5 sobre PDF-only).
- No reutilices sin verificar el nombre "BTE"/"DJ"/etc. tal como aparece en la UI de SII — ya hubo
  una colisión de nombres real (BPST vs. `bte.ts`, ver ADR-029) que costó tiempo entender.
