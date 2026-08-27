# ADR-040: Crawler de reconocimiento (Playwright + Llama 3.1 local) — herramienta, no fachada

## Status

Accepted — 2026-08-05.

## Context

El proyecto avanza superficie por superficie, cada una localizada a mano (ADR-004: observación en
vivo, citada). Eso funciona pero es lento — `docs/ESTADO-CONSOLIDADO.md` §4.2 lista 20 URLs
identificadas y nunca exploradas. El usuario pidió una herramienta que recorra el SII de forma
abierta (siguiendo cada link que encuentre, no una lista fija), use un modelo local (Llama 3.1 vía
Ollama, confirmado corriendo en la máquina del usuario: `llama3.1:latest`, 8B, contexto 131072) para
resumir lo que encuentra, y alimente con eso el grafo de conocimiento que el proyecto ya construye
con el skill `graphify` (en vez de literalmente entrenar una red neuronal, que no tiene sentido
para este problema — "armar una red" se interpreta como el grafo que `graphify-out/` ya produce).

**Esto es una herramienta de RECONOCIMIENTO, no una fachada de producción.** No la consumen el CLI
ni el MCP; no pasa por `withSession`'s task layer del mismo modo que `rcv`/`f22`/etc.; sus
hallazgos son CANDIDATOS que un humano revisa antes de promoverlos a `ESTADO-CONSOLIDADO.md` o a
una fachada real con su propio ADR. Por eso vive fuera de `packages/` (que es exclusivamente
superficies de producción, ADR-007).

## El riesgo real: un crawler abierto sobre el sitio real de una autoridad tributaria

Un crawler que "sigue cada link" en un sitio de producción real, sin las barreras correctas, puede:
1. Enviar un formulario de escritura (pagar un giro, generar una carpeta, aceptar un DTE...).
2. Ejecutar un handler `javascript:algunaFuncion()` que dispare una acción de escritura (el
   patrón EXACTO que ADR-032 encontró con `linkexterno(4)` — un link que parecía lectura y era
   configuración/escritura).
3. Saturar al SII con demasiadas peticiones y disparar un bloqueo de cuenta.

`docs/ESTADO-CONSOLIDADO.md` §4.3 ya cataloga 10 superficies de escritura conocidas. Ninguna
barrera de esto puede vivir solo en el prompt del LLM — Llama 3.1 es una señal adicional para
revisión humana, NUNCA el mecanismo de seguridad real (mismo principio que ADR-004: no se confía
en una inferencia no verificada para una decisión con consecuencia).

## Decision

1. **Vive en `tools/crawler/`** (fuera de `packages/`), package propio del workspace pnpm
   (`@dostertags/sii-crawler`, `private: true`, nunca se publica). Depende de
   `@dostertags/sii-core` (workspace) para reutilizar `createNodeRuntime` + `readSession` +
   `withSession` — **nunca hace login propio** (ADR-006: la Clave nunca la maneja código; si no
   hay sesión viva, el crawler se detiene y lo dice, no intenta autenticarse).

   **Consecuencia en `packages/core`:** `withSession`/`readSession` estaban deliberadamente FUERA
   del barrel principal (ADR-003: las superficies —CLI/MCP— llaman solo a tasks, nunca al
   primitivo de sesión). El crawler no es una superficie CLI/MCP, pero sí necesita una
   `PortalSession` viva sin una tarea de negocio de por medio. Se re-exportan desde el subpath
   `./node` (ya el "composition root" para consumo avanzado, ADR-016) — NO desde el barrel
   principal, así que el contrato que ven CLI/MCP y cualquier consumidor externo normal no
   cambia. Es lógica pura (sin `node:*`/playwright), así que no cuesta nada a quien no toque ese
   subpath.
2. **Solo navega, nunca envía nada.** El crawler llama `PortalSession.goto(url)` (una petición
   GET) para cada link que decide seguir. **Nunca** simula un click sobre un elemento del DOM real
   ni llama `.submit()` de ningún formulario — evita estructuralmente disparar un handler
   `onclick`/`javascript:` adjunto a un elemento, que es justo el vector de riesgo #2 de arriba.
3. **Extracción de links por texto plano, nunca por ejecución.** Tras cada `goto`, un solo
   `evaluate()` de solo-lectura extrae: el HTML completo (`outerHTML`), el título y meta tags,
   cada `<a href>` con su texto visible, y (vía `performance.getEntriesByType('resource')`, una
   API pasiva del navegador) la lista de recursos que la página cargó (scripts, XHR, fetch,
   json) — sin inyectar ningún parche de red ni interceptar tráfico en vivo. Un `href` que
   empieza con `javascript:` se registra (texto + nombre de función) para revisión humana pero
   **JAMÁS se ejecuta** — mismo principio que ADR-032 (leer la etiqueta/tooltip antes de asumir
   qué hace un link).
4. **Denylist de escritura, en código, pinneada por test.** Antes de encolar cualquier link, se
   evalúa contra un denylist de patrones (texto visible + href) derivado 1:1 de
   `ESTADO-CONSOLIDADO.md` §4.3 (Pagar, Generar, Anular, Declarar, Rectificar, Aceptar, Reclamar,
   `opc=114`, `opc=dec`, `pagogiro-ui`, `generarcteregular`, `navegacionf22`, `ren_mp`, etc.). Un
   match se registra como "candidato de escritura — NO seguido" en el reporte, nunca se navega.
   Un test (`denylist.test.ts`) fija cada entrada del denylist contra un ejemplo real citado en
   `ESTADO-CONSOLIDADO.md` — el mismo patrón que `portal/giros.ts` ya estableció.
5. **Solo dominios `*.sii.cl`.** Cualquier link fuera de ese dominio se registra pero no se sigue
   (nunca hay razón legítima para que el crawler salga del SII).
6. **Paceado y acotado.** Usa el mismo `DEFAULT_SETTINGS.rateLimitRps` del resto del proyecto
   (`Clock.sleep` entre naves — nunca satura), con un presupuesto de páginas por corrida y una
   profundidad máxima, ambos configurables por CLI con defaults conservadores. Nunca reintenta
   tras un error — mismo principio de todo el proyecto (ADR-004).
7. **Semillas: Mi SII + las 14 URLs ya en producción** (`ESTADO-CONSOLIDADO.md` §4.1) — no solo
   Mi SII, porque varias superficies conocidas viven en subdominios que Mi SII no enlaza
   directamente (`zeus.sii.cl`, `www3.sii.cl`, `palena.sii.cl`...). Desde ahí, sigue cada link
   real (no `javascript:`) descubierto, respetando el denylist y el dominio.
8. **Llama 3.1 (Ollama local, `http://localhost:11434`) resume cada página capturada** — qué es,
   qué recursos/JSON cargó, y una señal ADICIONAL (no autoritativa) de "esto podría ser
   escritura" para que un humano lo revise más rápido. El resumen del LLM SIEMPRE se guarda junto
   con los datos crudos que lo originaron — nunca reemplaza la captura real, así que un resumen
   equivocado del LLM es visible y verificable, no una fuente de verdad silenciosa.
9. **Salida:** capturas crudas (HTML/links/recursos/resumen del LLM) a `tools/crawler/out/`
   (gitignored — puede contener datos tributarios reales), más un reporte Markdown por corrida en
   el mismo directorio con la lista de candidatos NUEVOS (URLs no presentes en
   `ESTADO-CONSOLIDADO.md` §4.1/§4.2) para revisión humana. **El crawler nunca escribe directamente
   en `docs/ESTADO-CONSOLIDADO.md` ni en ningún ADR** — promueve un hallazgo a esos documentos
   solo un humano (o una sesión de trabajo posterior), tras confirmarlo (ADR-004).
10. **Alimentar `graphify` con las capturas queda como el paso siguiente manual** (`/graphify
    tools/crawler/out --update` o equivalente) — este ADR no automatiza esa invocación; es una
    decisión deliberada para no encadenar dos herramientas con comportamiento no determinista
    (crawler + LLM + graphify) en un solo paso sin que un humano revise el output intermedio.
11. **Ejecución diaria: NO se configura una Tarea Programada de Windows en este ADR.** El crawler
    solo tiene sentido dentro de una ventana de sesión SII viva (~12h tras `sii auth login`,
    ADR-006), y una tarea desatendida a una hora fija normalmente encontraría la sesión expirada.
    Se deja como un comando manual (`pnpm --filter @dostertags/sii-crawler crawl`) que
    también puede programarse más adelante (Tarea Programada, o el skill `schedule` de este
    entorno) — eso es una configuración persistente del sistema y se pide explícitamente antes de
    crearla (no es parte de esta decisión).

## Alternatives Considered

1. **Simular clicks reales sobre los elementos del DOM (en vez de solo `goto` con el `href`
   extraído).** Rechazado — un click real dispara cualquier handler `onclick`/`javascript:`
   adjunto, exactamente el vector de riesgo que ADR-032 encontró en producción. Navegar solo por
   `href`s de texto plano, nunca por click, es estructuralmente más seguro.
2. **Dejar que Llama 3.1 decida qué links seguir.** Rechazado — el modelo puede alucinar que algo
   es "seguro" cuando no lo es; el denylist duro en código es el único gate real, el LLM es
   señal, nunca decisión (ADR-004).
3. **Interceptar tráfico de red en vivo (parchear `window.fetch`/`XMLHttpRequest` vía
   `evaluate`).** Descartado para v1 — añade código ejecutándose en la página (aunque de solo
   lectura) y complejidad de sincronización. La API pasiva `performance.getEntriesByType`
   (sin inyectar nada) cubre el caso de uso de "qué JSON/recursos cargó esta página" con menos
   riesgo. Queda como mejora futura si se necesita más detalle.
4. **Poner el crawler dentro de `packages/core` o `packages/cli`.** Rechazado — no es una
   superficie de producción consumida por CLI/MCP (ADR-003/ADR-007); mezclarlo confundiría el
   mapa de módulos y el pipeline de publicación de esos paquetes.
5. **Automatizar una Tarea Programada diaria ya mismo.** Rechazado por ahora — es una
   configuración persistente del sistema (requiere permiso explícito, no implícito en "quiero que
   corra todos los días") y depende de una sesión SII que no puede renovarse sola.

## Hallazgo en vivo (2026-08-05): una cookie "localmente fresca" puede estar muerta en SII

La primera corrida real (`--seed https://misiir.sii.cl/cgi_misii/siihome.cgi --max-pages 3
--max-depth 1 --no-llm`) aterrizó en la página de login (`zeusr.sii.cl`) en la profundidad 0 — la
sesión guardada estaba dentro del TTL local (~12h) pero SII ya la había invalidado del lado del
servidor. `PortalSession.goto` no prueba liveness por sí solo (a diferencia de
`requestJson`/`requestForm`, que sí detectan un bounce a `LOGIN_HOST` como sesión expirada) — el
crawler original NO tenía esa verificación y habría seguido navegando el sitio PÚBLICO sin darse
cuenta, reportando sus links (incluyendo, correctamente, que varios cayeron en el denylist) como
si fuera una corrida autenticada normal.

**Corregido**: tras cada `goto`, el crawler verifica el hostname de aterrizaje contra `LOGIN_HOST`
(mismo criterio URL-based de todo el proyecto, `CONVENTIONS.md`) y, si coincide, aborta TODA la
corrida (no solo la página) con `SessionExpiredError` — nada capturado después de un bounce al
login pertenece a la sesión. Pinneado por test (`crawl.test.ts`).

## Consequences

- Primer uso de un LLM local (Ollama) en el proyecto — sin costo por token, sin enviar datos del
  SII a un tercero (corre en la máquina del usuario).
- El presupuesto de páginas/profundidad por corrida es deliberadamente conservador al principio;
  se puede ampliar una vez que una primera corrida real confirme que el denylist + el dominio
  filtran correctamente.
- Cualquier candidato que el crawler encuentre sigue necesitando el mismo tratamiento que todo el
  proyecto: observación citada, ADR si se convierte en fachada, nunca código sobre una inferencia
  sin confirmar (ADR-004).
