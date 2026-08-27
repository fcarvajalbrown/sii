# ADR-044: El bucle nocturno se parte en `fetch` (con sesión) y `learn` (desatendido)

## Status

Accepted — 2026-08-06. Cierra el ítem **§1.1 de `docs/BACKLOG.md`** ("Unattended `monitor`
scheduling — needs its own ADR"), abierto desde ADR-024. Refina ADR-043 sin cambiar ninguno de sus
cinco invariantes. NO reabre ADR-006: la Clave sigue sin almacenarse.

## Context

ADR-043 pide un bucle que "corre solo cada noche". ADR-006 lo impide: la sesión es *cookies-only*,
dura ~10 h, y el login es interactivo por diseño — el usuario escribe la Clave en la página real del
SII y el proyecto solo se queda con las cookies. Una corrida desatendida a las 03:00 **fallará en la
etapa 1** hasta que alguien inicie sesión.

La salida obvia (guardar la Clave en el keyring, contemplado por ADR-006 y diferido por ADR-008)
cambia la propiedad de seguridad más fuerte del proyecto por comodidad de agenda. Se rechaza.

**El corte correcto no es el que se supuso al principio.** Una primera lectura dijo "las etapas 3–8
no necesitan SII". Al revisarlo: la etapa 2 (`extract`) **tampoco** — parsea artefactos que ya están
en el almacén. La única etapa que necesita una sesión viva es la **1 (`ingest`)**.

Eso importa más de lo que parece: significa que **la cadencia del aprendizaje se desacopla del
acceso al SII**. Aprender no necesita datos frescos; necesita estrategias nuevas, reglas nuevas y
correcciones de auditor. Todo eso ocurre sin tocar el SII.

## Decision

**Dos modos de corrida, un solo orquestador.**

1. **`sii-auditor fetch`** — SOLO la etapa 1. Requiere una sesión viva. La dispara una persona
   después de `sii auth login`. Es la única parte que toca el SII y hereda el paceo de ADR-004.
2. **`sii-auditor learn`** — etapas **2–8**. Nunca toca el SII. Es el objetivo del programador de
   tareas / `cron` / `systemd` timer, y **`make nightly` pasa a apuntar aquí**.
3. **`sii-auditor run`** — las ocho, el comportamiento actual, para cuando hay sesión y se quiere
   todo de una vez.

Concretamente:

- `LoopConfig` gana `stages?: readonly Stage[]` (subconjunto a ejecutar). El orquestador ya itera
  el orden fijo `STAGES`; se filtra por ese conjunto. Una etapa **excluida** se registra en el
  manifiesto como `skipped` con un resumen explícito (`"no seleccionada en modo learn"`), NUNCA se
  omite en silencio — el manifiesto sigue siendo el relato honesto de la noche (ADR-043).
- `DEFAULT_NON_FATAL` no cambia: en `learn`, `extract` sigue siendo fatal (todo lo posterior deriva
  de lo que produjo); `ingest` simplemente no corre.

**`dataAsOf` es obligatorio en el manifiesto y encabeza el informe.** Una corrida `learn` opera
sobre artefactos que pueden tener semanas. Un informe nocturno que *parece* actual y descansa en
datos viejos es exactamente el modo de falla "confiadamente equivocado" que este repositorio
combate. Por eso:

- `RunManifest.dataAsOf` = el `retrievedAt` MÁS NUEVO de los artefactos que la corrida consideró
  (`null` si no consideró ninguno).
- La etapa 8 (`report`) abre con esa fecha y con la antigüedad en días.
- **Un período ABIERTO nunca se afirma desde artefactos rancios.** ADR-027 ya prohíbe cachear el
  período corriente; aquí la regla se extiende al informe: si el artefacto más nuevo de un período
  abierto es anterior a hoy, el informe lo marca como *no verificado hoy* en vez de presentarlo como
  estado actual.

## Alternatives Considered

1. **Guardar la Clave en el keyring para un `ingest` desatendido** — rechazada. Cambia la propiedad
   de seguridad central de ADR-006 (la Clave nunca toca el disco ni al LLM) por conveniencia de
   agenda, y necesitaría su propio ADR de seguridad. El valor que compra —datos frescos cada noche
   sin intervención— no lo justifica mientras el cuello de botella real del sistema sea el conjunto
   dorado, no la frescura de los datos.
2. **Dejar el bucle entero desatendido y aceptar que aborte** — rechazada. Cada noche produciría un
   manifiesto `aborted` idéntico; el operador aprendería a ignorarlo, que es precisamente el fallo
   que ADR-024 diseñó para evitar en las primeras corridas.
3. **Partir en 1–2 / 3–8** (la lectura inicial) — rechazada al comprobar que `extract` no necesita
   sesión. Dejar `extract` del lado con sesión ataría el re-parseo con una estrategia nueva a que
   alguien iniciara sesión, cuando es justo la operación que más se quiere repetir en frío.
4. **Un demonio propio que vigile la sesión y dispare `fetch` cuando exista** — rechazada por ahora:
   ADR-024 dejó la programación fuera de alcance a propósito, y un proceso residente es más
   superficie de la que el problema pide. El programador del sistema operativo basta.

## Consequences

- **Más fácil:** el aprendizaje corre de verdad todas las noches, sin persona y sin SII — absorbe
  correcciones, re-extrae con estrategias nuevas, re-evalúa y aplica la compuerta. La ingesta pasa a
  ser un acto humano deliberado, que es lo que ADR-006 quiere que sea.
- **Obligación:** `dataAsOf` debe llegar al informe. Sin eso, este ADR crea el riesgo que dice
  evitar.
- **Consecuencia honesta:** en una semana sin logins, el sistema puede seguir mejorando (métricas,
  reglas, parsers) mientras los DATOS envejecen. Son dos ejes distintos y el informe debe mostrarlos
  por separado; confundirlos sería leer "el sistema mejoró" como "la situación tributaria está al
  día".
- El `--dry-run` existente se compone con ambos modos sin cambios.
