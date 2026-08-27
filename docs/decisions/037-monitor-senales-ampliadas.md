# ADR-037: `monitor` amplía su barrido a las señales de los ADR-030..035

## Status

Accepted — 2026-08-04. Cierra la brecha **G17** de `docs/COVERAGE-GAP-ANALYSIS.md` (spike F).
**Extiende ADR-024** (el monitor) sin cambiar ninguno de sus principios.

## Context

`ADR-024` construyó `monitor` sobre tres señales: observaciones/eventos del F22, meses sin F29 y
peticiones. Desde entonces se hicieron legibles cinco superficies más (ADR-030 DJ, ADR-032
notificaciones, ADR-033 carpeta, ADR-034 giros, ADR-035 situación/Ley COT), pero **el barrido
seguía mirando solo las tres originales**. El análisis de brechas marcó esto como G17 y señaló
que era el mayor retorno por unidad de esfuerzo del plan: cero exploración, pura integración.

La motivación de ADR-024 sigue vigente y aplica igual a las señales nuevas: *la observación F121
de AT2019 se levantó en 2019 y pasó siete años inadvertida, siendo legible todo ese tiempo.*

## Decision

Añadir **cuatro señales** al barrido, cada una con su hallazgo:

| Señal | Fuente | Hallazgo | Severidad |
|---|---|---|---|
| DJ con estado observado | `fetchDjEstadoAnual` (ADR-030) | `dj_observada` (estado) + `dj_cambio_estado` (cambio) | alta / media |
| Notificación FORMAL vigente | `fetchComunicacionesList` (ADR-032) | `notificacion_vigente` | alta |
| Giro con **saldo > 0** | `fetchGirosAnual` (ADR-034) | `giro_con_saldo` (estado) + `giro_nuevo` (cambio) | alta |
| Requisito Ley COT incumplido | `fetchCumplimientoCot` (ADR-035) | `cot_incumplimiento` | alta |

Decisiones concretas:

1. **La regla de privacidad de ADR-024 se respeta al pie de la letra.** El snapshot en disco
   guarda **solo identificadores y estados**: `dj` (`año|nºDJ` → estado), `giros` (folio →
   estado), `notificaciones` (**id → tipo**, NUNCA la `descripcion`, que es texto libre) y `cot`
   (`atrCodigo` → `"SI"`/`"NO"`). **El MONTO del giro nunca se persiste** — viaja aparte, solo
   hacia la salida. Pinneado por dos tests.
2. **El criterio de deuda es el SALDO, no el estado.** ADR-034 observó que `Estado: "Vigente"`
   convive con `Saldo: $0`: "Vigente" describe el documento, no el impago. Marcar por estado
   habría producido una alarma falsa en cada giro del contribuyente. Pinneado por test.
3. **DJ observada se detecta por CONTENIDO, no por igualdad.** ADR-030 no cierra el enum de
   estados, así que se busca `/observ/i` en vez de comparar con `"Observada"`.
4. **Un snapshot ANTERIOR a este ADR no dispara falsos "nuevos".** Los mapas nuevos se leen con
   `?? {}`, y los giros solo se comparan si YA existía mapa de giros — misma cautela que la guarda
   por-año de las observaciones (hallazgo en vivo de 2026-07-26). Pinneado por test.
5. **Un fallo de UNA señal no aborta el barrido**: se captura en `errores` y el resto continúa
   (regla de fan-out de ADR-004, aplicada a un sweep de señales heterogéneas). Pinneado por test.
6. **Los contadores del `resumen` se derivan de `cambios`**, no se recalculan aparte — así el
   número siempre coincide con lo que realmente se marcó (misma regla que ADR-024 aplicó a
   `aniosSinF22`).
7. **Coste:** el barrido pasa de 3 a 7 familias de señales; giros además maneja una SPA. Se
   limita a **una** llamada de DJ (su ventana ya cubre 3 años) y **un** año de giros, todo paceado
   por el mismo `Clock`.

## Alternatives Considered

1. **Marcar giros por `estado === 'Vigente'`.** Rechazado por los datos reales: los tres giros del
   contribuyente están "Vigente" con saldo $0. Habría sido una alarma falsa permanente.
2. **Persistir el saldo en el snapshot para detectar variaciones de monto.** Rechazado: ADR-024
   restringe el snapshot a identificadores y estados. El folio nuevo ya detecta lo importante.
3. **Reportar `notificacion_nueva` solo como cambio contra baseline.** Rechazado: una notificación
   formal vigente es una situación permanente (una citación no deja de existir porque ya se
   reportó). Se trata como hallazgo de ESTADO, igual que un año sin F22.
4. **Incluir también carpeta tributaria (ADR-033).** Descartado: generar un dossier es una acción
   voluntaria del contribuyente, no una señal de cumplimiento. Vigilarla sería ruido.
5. **Incluir el acuse de DTE (ADR-036).** Diferido: su señal accionable ("pendientes") no está
   publicada por SII (ver ADR-036), así que hoy no hay nada fiable que vigilar.

## Consequences

- **Encontró algo real en la primera corrida en vivo:** tres DJ observadas que el proyecto no
  podía ver (1835 AT2025, 1847 AT2024, 1948 AT2024) — exactamente la clase de hallazgo que motivó
  ADR-024.
- El barrido es más lento y toca más superficies; una caída de SII en cualquiera de ellas degrada
  a `errores` sin romper el resto.
- **Falso positivo PREEXISTENTE detectado, NO corregido aquí** (ver abajo). Se documenta en vez de
  arreglarse al vuelo, por la misma razón que ADR-035 no cableó `fechaInicioActividades`: cambiar
  cómo el monitor asigna severidad merece su propio trabajo con sus tests.

### ⚠️ Hallazgo abierto: el mes inmediatamente anterior se marca antes de vencer su plazo

La verificación en vivo (2026-08-04) marcó `F29 2026-07` como *"Sin declaración"* en severidad
**alta**. Pero el F29 de julio **no está atrasado**: vence el 12 (o el 20 para declarantes
electrónicos) de agosto. `estadoFindings` solo exime el período EN CURSO, así que el mes anterior
siempre se marca durante su propia ventana legal de declaración.

Es el mismo patrón de falso positivo que ADR-024 documentó para AT2019 y que
`docs/CONVENTIONS.md` advierte que un informe no debe leer como incumplimiento.

**La corrección ahora es posible:** ADR-035 observó en vivo el campo
`contribuyente.autorizadoDeclararDia20` (`"S"` para este contribuyente), que determina si el
plazo es el día 12 o el 20. Con eso se puede eximir el mes anterior mientras su plazo siga
abierto. **Queda como trabajo propio, con sus tests** — no como efecto colateral de este ADR.
