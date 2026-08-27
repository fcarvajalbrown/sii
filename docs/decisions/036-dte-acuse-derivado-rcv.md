# ADR-036: Acuse de DTE (`dte acuse`) — derivado del RCV, no una fachada nueva

## Status

Accepted — 2026-08-04. Cierra **parcialmente** la brecha **G3** de
`docs/COVERAGE-GAP-ANALYSIS.md` (recepción y acuse de DTE, Ley 19.983) — con una limitación real
declarada abajo. Spike C.

## Context

`COVERAGE-GAP-ANALYSIS.md` marcó G3 como crítica por su **plazo legal**: el Art. 3 de la Ley
19.983 da 8 días corridos para reclamar una factura; pasado el plazo queda tácitamente aceptada y
se vuelve título ejecutivo. El plan proponía explorar la app "Registro de Aceptación o Reclamo de
un DTE" y construir un facade de lectura con "días restantes".

La exploración en vivo (2026-08-04) cambió el diseño en dos pasos:

1. **El estado de acuse YA viaja en el RCV.** `portal/rcv.ts` curaba desde siempre
   `detEventoReceptor`/`detEventoReceptorLeyenda`, pero **sus valores nunca se habían
   documentado**. Sobre 1.859 documentos reales aparecieron tres: `A` ("No reclamado en plazo"),
   `C` ("Recibo otorgado por el receptor") y `P` ("Forma de pago contado").
2. **La app oficial NO es una bandeja de pendientes.** `www4.sii.cl/registrorechazodtej6ui`
   resultó ser una consulta de **UN documento** (RUT emisor + tipo + folio → sus eventos). SII **no
   publica una lista de "DTE pendientes de acuse"**. La pregunta del contador, por tanto, no se
   *lee*: se *deriva*.

## Decision

1. **`tasks/acuse.ts` es una COMPOSICIÓN sobre `rcvListAll`, no una fachada nueva.** Cero wire
   nuevo, cero riesgo de scraper, una sola sesión (la que ya abre `rcvListAll`). Agrupa los DTE
   recibidos por evento, suma montos, y aísla los que no traen evento.
2. **No escribe recibo de auditoría propio.** `rcvListAll` ya registra la lectura; duplicarlo
   anotaría dos lecturas donde hubo una. Pinneado por test.
3. **`diasDesdeRecepcion` es un DATO, no un veredicto legal.** Se calcula como días corridos entre
   `fechaRecepcion` y hoy — y se documenta explícitamente, en el tipo y en la descripción MCP, que
   **este proyecto no adjudica el plazo del Art. 3**: su disparador depende de la recepción de las
   mercaderías o servicios, que el SII no expone. Prometer una cuenta regresiva legal a partir de
   un dato que no es el disparador sería precisamente el error silencioso con consecuencia que
   este repo evita.
4. **`sinEventoPorTipo` existe para impedir un falso positivo.** En los dos períodos observados,
   el **100 %** de los documentos sin evento fueron Notas de Crédito (tipo `61`) y una DIN
   (`914`), mientras que **todas** las facturas traían evento: la ausencia correlaciona con el
   TIPO de documento, no con una acción pendiente. Presentar la lista cruda como "pendientes de
   acuse" habría generado una alarma falsa recurrente — el mismo patrón de error que el descuadre
   fantasma de IVA (`BACKLOG` §3.5) y el falso AT2019 (`CONVENTIONS.md`). El CLI y el tipo lo
   dicen explícitamente. **No se afirma como regla** que el tipo 61 nunca lleve evento: dos
   períodos no son una regla (ADR-004).
5. **`eventoReceptor` pasa verbatim, sin enum cerrado.** No se observó ningún valor de "pendiente
   / dentro de plazo".
6. **⛔ Aceptar o reclamar NO se implementa.** Es un acto con efecto jurídico; exige su propio ADR
   con la postura de escritura de ADR-017/ADR-026 (preview + confirmación + `destructiveHint`).
   Durante todo el spike la app de acuse se navegó **sin pulsar un solo control**.
7. **Body-RUT** (ADR-005): hereda el alcance de RCV, así que `--rut`/operate SÍ llega a una empresa
   representada — a diferencia de casi todas las superficies recientes, que son session-keyed.

## Alternatives Considered

1. **Construir un facade sobre `registrorechazodtej6ui`.** Rechazado: es una consulta por folio
   individual, no una lista. Un facade así solo respondería "¿qué eventos tiene ESTE documento?",
   dato que el RCV ya entrega para todos a la vez.
2. **Calcular y mostrar "te quedan N días para reclamar".** Rechazado: exigiría afirmar cuál es el
   disparador legal del plazo, que no está observado. Se entrega `diasDesdeRecepcion` como hecho y
   se declara la limitación.
3. **Tratar "sin evento" como la lista de pendientes.** Rechazado empíricamente por los datos
   reales (ver punto 4).
4. **Añadir los campos al `monitor`.** Diferido al spike F, junto con el resto de señales nuevas.
5. **Usar el WebService oficial** (`Webservice_Registro_Reclamo_DTE_V1.2.pdf`, observado en el
   catálogo). No explorado: es la vía de ESCRITURA documentada por SII, fuera del alcance de este
   spike de lectura. Anotado como punto de partida si algún día se aborda la escritura.

## Consequences

- Un contador puede ver, por período, el estado de acuse de todos sus DTE recibidos y detectar
  cualquier documento sin evento — con el desglose que evita interpretarlo mal.
- **G3 queda CERRADA SOLO PARCIALMENTE, y así se declara en el análisis de brechas:** lo que NO se
  puede responder hoy es "¿qué facturas están DENTRO del plazo ahora mismo y requieren acción?",
  porque ni el RCV ni la app publican un estado "pendiente". Si ese estado existe, aparecerá como
  un `eventoReceptor` no observado; el código lo pasará verbatim y quedará visible.
- Documenta en `docs/sii-contract/rcv.md` unos valores que se curaban a ciegas desde el principio.
- **Seguimiento abierto:** observar un documento genuinamente pendiente (requiere mirar el mes
  abierto con facturas a crédito recientes); el WebService oficial; y la escritura de
  aceptación/reclamo, que necesita su propio ADR.
