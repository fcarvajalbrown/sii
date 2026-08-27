# ADR-042: Seam binaria (`requestBinary`) + descarga de PDF de cartas

## Status

Accepted — 2026-08-06. Cierra la parte de ARQUITECTURA del spike **G** de
`docs/ESTADO-CONSOLIDADO.md` §1.2. **La descarga de un PDF real NO se logró verificar en vivo esta
sesión** — ver "Verificación en vivo" abajo. La seam, la fachada, la tarea y el CLI están
construidos y probados contra fakes (TDD verde), pero el contrato exacto de query params de
`MuestraPdf` queda como un ítem abierto, no una hipótesis confirmada.

## Context

Ninguna primitiva actual del proyecto devuelve binario. Las cinco primitivas de `PortalSession`
(`requestJson`, `requestForm`, `requestText`, `goto`/`evaluate`) y la de `PortalDriver`
(`requestPublic`) decodifican SIEMPRE el cuerpo de la respuesta a texto (`TextDecoder`, con
detección de charset — ADR-014). Eso basta para JSON/HTML/GWT-RPC, pero no sirve para un PDF: un
`TextDecoder` sobre bytes binarios corrompe el contenido de forma silenciosa (no lanza error, solo
produce basura).

El caso concreto es `https://www3.sii.cl/Coreca1Internet/MuestraPdf?codCarta=<n>` (**OBSERVADA**,
ADR-004): la URL para descargar el PDF de una carta/notificación SII, con la clave `codCarta` ya
expuesta desde 2026-06-29 por `f22 historial` (`buscaEventos` → campo `codCarta`, ver
`portal/f22/historial.ts`). `docs/ESTADO-CONSOLIDADO.md` lo describe así: "JSON es análisis; PDF es
evidencia" — varios módulos ya devuelven metadata estructurada sobre cartas/notificaciones/DJ
(`f22 historial`, `notificaciones detalle`, `dj detalle`), pero ninguno puede producir el documento
original que un contador necesita como evidencia ante una fiscalización.

Esto es un cambio de arquitectura real (toca el contrato de seams, `packages/core/src/seams/index.ts`
— ADR-003), no solo una fachada nueva, así que corresponde su propio ADR antes de tocar código
(regla del proyecto, CLAUDE.md "Decisiones get an ADR BEFORE implementation").

## Decision

1. **Nueva primitiva `PortalSession.requestBinary(url, options?): Promise<BinaryResponse>`** —
   peer autenticado de `requestForm`/`requestText`, pero sin decodificar el cuerpo: retorna
   `{ status: number; body: Buffer; contentType: string | null }`. La detección de sesión muerta es
   la MISMA convención URL-based que `requestForm`/`requestText` (bounce a `LOGIN_HOST` ⇒
   `SessionExpiredError`) — un PDF binario nunca es JSON, así que no hay heurística de
   content-type que aplicar (igual razón que las otras dos: el cuerpo no-esperado-como-JSON es
   normal, no una señal de sesión muerta).
2. **Node adapter**: `context.request.fetch(url, {method:'GET', headers})` seguido de
   `await response.body()` (Playwright ya devuelve un `Buffer` crudo desde `APIResponse.body()` —
   NO pasa por `TextDecoder`). El `content-type` se lee del header de respuesta, verbatim, sin
   parsear (a diferencia de `charsetOf`, que es solo para decodificar TEXTO).
3. **Fake**: `FakeSessionScript.requestBinary?: (url, options?) => BinaryResponse | Buffer` en
   `adapters/fake/index.ts`, mismo patrón que `requestForm`/`requestText` (azúcar: un `Buffer` se
   envuelve en `{status:200, body}`).
4. **Nueva fachada `portal/documentos.ts`** — `fetchCartaPdf(session, {codCarta})`: GET a
   `MuestraPdf?codCarta=<n>`, valida que el `content-type` observado (`application/pdf`) coincida
   o levanta `DocumentoError` (nunca asume que un binario devuelto es un PDF válido sin chequear el
   content-type — mismo espíritu que `nonJsonResponseError`: fallar ruidoso ante lo inesperado).
   Body-agnostic respecto a QUIÉN generó la carta — `codCarta` ya viene de superficies existentes
   (`f22 historial`, potencialmente `notificaciones`/`dj` en el futuro), esta fachada solo
   descarga el PDF dado el código, no re-deriva de dónde salió.
5. **Nueva tarea `tasks/documentos.ts`** (`descargarCartaPdf`) — `withSession` + un recibo de
   auditoría que registra `codCarta` + el TAMAÑO en bytes, **NUNCA el contenido** (ADR-006). El
   PDF completo NUNCA toca el `AuditSink`.
6. **CLI `sii carta pdf <codCarta> --out <ruta>`** — escribe el PDF a disco en la ruta indicada
   (obligatoria: nunca se imprime binario a stdout, rompería el contrato "STDOUT es JSON
   pipeable a `jq`", ADR-012). Confirma con un objeto JSON `{codCarta, bytes, ruta}` cuando
   termina.
7. **⛔ MCP diferido, NO construido en este ADR.** El SDK de MCP puede devolver contenido binario
   (`type: 'resource'` con `blob` base64), pero eso pondría el PDF completo en el canal hacia el
   LLM — exactamente lo que el proyecto evita para todo dato PII-denso (mismo espíritu que "el
   dato nunca llega al LLM" de ADR-006, aunque ahí es sobre la Clave). Un PDF de carta es
   contenido de identidad propia (mismo posture que `whoami`/`notificaciones detalle`) pero en
   formato NO estructurado — el LLM no puede filtrar campos de un blob binario como sí puede con
   JSON. Se prefiere que la descarga quede en el CLI (control humano directo del archivo) hasta
   que haya un caso de uso concreto que justifique el riesgo adicional.

## Alternatives Considered

1. **Modelar `requestBinary` como un caso especial de `requestText` (texto latin1 1:1 con
   bytes).** Rechazado — es una trampa clásica: un PDF no es texto, y aunque un mapeo latin1
   byte-a-byte es técnicamente reversible, obliga a cada consumidor a re-convertir a `Buffer`
   correctamente o arriesgar corrupción. Un tipo de retorno distinto (`Buffer`) hace el contrato
   explícito en el sistema de tipos.
2. **Devolver el PDF directamente desde la tarea sin pasar por `withSession`+auditoría.**
   Rechazado — rompería la regla "cada operación que toca el SII pasa por `withSession` +
   un recibo de auditoría" (CONVENTIONS.md), sin ninguna razón especial para este caso.
3. **Construir la tool MCP igual que el resto (base64 blob) desde el día uno.** Rechazado por
   ahora — sin un caso de uso real que la necesite, es superficie nueva sin beneficio probado;
   más fácil añadirla después que quitarla.

## Verificación en vivo (2026-08-06) — RESULTADO NEGATIVO, documentado en vez de ocultado

Se probó `sii carta pdf <codCarta> --out <ruta>` en vivo (a real empresa account) contra
tres `codCarta` reales obtenidos de `f22 historial 2025` (`000483`, `000400`, `000408`). **Los tres
fallaron con HTTP 500** — el cuerpo de respuesta (inspeccionado con un log de depuración temporal,
revertido antes de cerrar esta sesión) es una página de error genérica del framework legacy
(`<title>FisWeb</title> … "Ha Ocurrido un error interno en la aplicacion"`), NO un mensaje que
indique un parámetro faltante específico. Añadir un header `Referer` no cambió el resultado.

`docs/BACKLOG.md` §2.1 ya documentaba la URL como derivada de un global JS (`jwscarta`) observado
de pasada en una sesión previa, con la nota explícita **"very likely the retrieval key for
MuestraPdf — an observed link between two live surfaces"** — es decir, la hipótesis `?codCarta=<n>`
NUNCA fue confirmada capturando el enlace real que la UI de SII construye (a diferencia de, por
ejemplo, `notificaciones` — ADR-032 — donde el enlace real SÍ se confirmó antes de construir). Esta
sesión repitió el mismo error que CONVENTIONS.md ya advierte evitar ("Antes de committing a un
decoder de alto riesgo… verifica el trigger exacto") — aquí no era un decoder GWT, pero el
principio es el mismo: se construyó código sobre un patrón de URL "muy probable" en vez de
confirmarlo primero con el enlace real.

**No se construyó código adicional para re-derivar `MuestraPdf`** — habría significado abrir
Mi SII interactivamente y capturar el `jwscarta` real (requiere clic en un enlace de una carta real
desde la UI, no algo alcanzable solo con `goto`+`evaluate` sobre la página ya conocida). Queda como
ítem abierto explícito, no una función marcada como funcionando cuando no lo está.

## Consequences

- Desbloquea PDFs de cartas SII para cualquier `codCarta` ya expuesto (`f22 historial`), y deja el
  seam listo para el resto del *document vault* mencionado en `BACKLOG.md` §4 (PDF de carpeta
  tributaria, certificados) sin otro cambio de arquitectura.
- `requestBinary` queda disponible para cualquier facade futura que necesite descargar un binario
  autenticado — no solo PDFs (ej. un futuro `carpeta descargar`).
- Abre un ítem de seguimiento: una tool MCP para PDFs, si algún caso de uso concreto la justifica,
  necesita su propia decisión sobre cómo declarar la exposición (fuera de alcance aquí).
- **Abre el ítem principal de seguimiento**: capturar el enlace REAL que la UI de Mi SII construye
  para una carta (probablemente leyendo `jwscarta` en el momento del clic, no solo su nombre) antes
  de confiar en `sii carta pdf` para trabajo real. La seam (`requestBinary`) y el resto de la
  arquitectura no están en duda — solo la URL/parámetros exactos de este endpoint específico.
