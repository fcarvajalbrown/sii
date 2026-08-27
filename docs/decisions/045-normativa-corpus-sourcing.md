# ADR-045: Fuentes del corpus de normativa — BCN Ley Chile, circulares SII e instrucciones de llenado

## Status

Accepted — 2026-08-06. Resuelve la decisión editorial que ADR-043 §I2 dejó explícitamente abierta
("qué cuerpos, de qué fuente oficial, con qué granularidad, y con qué evidencia para cada rango de
vigencia"). Habilita el work unit W6 de `docs/AUDITOR-ROADMAP.md`. No cambia ningún invariante.

## Context

ADR-043 §I2 exige que el sistema **recupere y cite** la norma o diga que no sabe: nunca la enuncie
desde los pesos del modelo. El esquema (`kb/normativa.ts`), las anclas de cita y la consulta
"qué regía el día X" existen desde entonces. **No hay corpus cargado**, así que la cobertura de
normativa es estructuralmente `null` y `ask/` declina toda pregunta regulatoria.

La pieza que faltaba no era código: era decidir de dónde sale el texto y —lo más difícil— de dónde
sale la **fecha de vigencia** de cada versión. ADR-043 lo dice sin rodeos: una fecha adivinada
produce *una cita confiada de la ley del año equivocado*, que es peor que no citar, porque la
ausencia declina y la fecha errada responde.

## Decision

**Tres fuentes, con rangos distintos y un papel distinto cada una.**

1. **BCN — Ley Chile (`bcn.cl/leychile`)** es la fuente PRIMARIA del texto legal y, sobre todo, **de
   las fechas de vigencia**. Es la razón de elegirla por encima de cualquier copia: publica el texto
   *consolidado con versiones*, cada una con su rango de vigencia declarado por la propia BCN. Ese
   metadato ES el `EffectiveRange`. **Regla dura: `effective.from`/`effective.to` se COPIAN del
   metadato de versión de BCN; jamás se infieren de la fecha de publicación de una ley
   modificatoria ni de la lectura del articulado.** Si una versión no trae rango explícito, el chunk
   NO se carga.
   - Rango: `ley` / `decreto`.
   - Cuerpos iniciales: DL-825 (IVA), DL-824 (Renta), Código Tributario, Ley 19.983.

2. **Circulares y resoluciones del SII (`sii.cl`)** son interpretación administrativa, NO ley.
   Entran con rango `circular` / `resolucion` y **nunca pueden contradecir** un chunk de rango
   superior: el campo `rank` existe para que un conflicto se resuelva por jerarquía en vez de por
   orden de carga. Aportan lo que la ley no dice: cómo el SII aplica la norma en la práctica.

3. **Instrucciones de llenado de formularios del SII** (F22, F29, F50 y sus anexos) son la fuente
   **operativa** y la más valiosa para este proyecto en concreto: son lo que traduce la norma a
   **códigos**. Son literalmente lo que dice qué significa el código 151, el 511 o el 538.
   - Se citan bajo la **resolución que aprueba el formulario** cuando es identificable (rango
     `resolucion`); si no lo es, entran como `circular`.
   - El ancla incluye el formulario y el código: `SII-F29-INSTR/2023#cod-151`.

**Granularidad:** un chunk por **artículo**; cuando un artículo es largo o su inciso/numeral se cita
por separado en la práctica (Art. 74 Nº 2, Art. 42 Nº 2), el inciso/numeral es su propio chunk con
ancla anidada. Las instrucciones de formulario se trocean **por código**, que es la unidad en que
realmente se consultan.

**Alcance inicial deliberadamente estrecho:** las ~10 anclas que el código ya nombra, no "la
tributación chilena". Cargar en masa no sube la cobertura — la métrica cuenta solo anclas que un
expediente necesitó (`eval/metrics.ts`), así que el volumen sin uso no mueve el número y sí agrega
superficie que mantener.

**Verbatim y con `retrievedAt`.** El texto se guarda tal cual, nunca resumido ni parafraseado: una
cita tiene que poder citarse. Cada chunk lleva `sourceUrl` + `retrievedAt` + `corpusVersion`, y una
enmienda posterior **no reescribe** lo que un hallazgo pasado afirmó que decía la ley.

## Alternatives Considered

1. **Solo BCN Ley Chile** — rechazada: la ley no dice qué código del F29 corresponde a qué
   retención. Sin las instrucciones de llenado, el sistema puede citar el Art. 74 Nº 2 pero no
   conectarlo con el código 151, que es justo el puente que necesita una reconciliación.
2. **Solo circulares e instrucciones del SII** — rechazada: es interpretación sin la norma que
   interpreta, y sin rangos de vigencia fiables. Además invierte la jerarquía: dejaría al sistema
   citando administración donde corresponde ley.
3. **Un scraper genérico + un LLM que infiera las fechas de vigencia** — rechazada de plano. Es
   exactamente el fallo que ADR-043 §I2 existe para impedir, y el modo de error es silencioso: una
   fecha inventada produce una cita que se lee autorizada.
4. **Cargar el corpus completo de los cuatro cuerpos de una vez** — rechazada por ahora: no sube la
   métrica (ver alcance), y multiplica el trabajo de verificar rangos de vigencia uno por uno.

## Consequences

- **Más fácil:** W6 deja de estar bloqueado. La cobertura de normativa pasa de `null` a un número
  real, y `ask/` puede responder —citando— en vez de declinar siempre.
- **Obligación real:** cada chunk exige verificar su rango de vigencia contra el metadato de BCN.
  Es trabajo manual y no se puede automatizar sin reintroducir el riesgo del alt. 3.
- **Riesgo tributario que esto ataca directamente:** la tasa de retención de honorarios (Art. 74
  Nº 2) **no es constante en el tiempo** — hay un aumento legislado por tramos anuales. Una regla
  que calcule retención esperada con una tasa fija estará silenciosamente equivocada para casi todo
  año. Las instrucciones de llenado, fechadas, son la fuente correcta de esa tasa por período. **La
  tasa concreta de cada año NO se afirma aquí**: se carga desde la fuente y se cita (ADR-004).
- **Obligación de licencia/uso:** el texto de BCN y del SII se guarda en el almacén LOCAL del
  usuario. No se redistribuye ni se publica con el repositorio.
