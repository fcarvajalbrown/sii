# ADR-043: Bucle nocturno de auditoría — evidencia con procedencia, reglas como datos, promoción con compuerta

## Status

Accepted — 2026-08-06. Primera pieza del proyecto que **aprende entre corridas**. Extiende
ADR-024 (`monitor`, el primer estado entre corridas) y ADR-027 (caché local) hacia un almacén
real; extiende ADR-040 (crawler de reconocimiento) con su contraparte de producción. No cambia
ADR-003, ADR-004, ADR-005 ni ADR-006 — se construye **encima** de las seams, sin tocarlas.

## Context

El proyecto lee 14 superficies del SII con disciplina (observación en vivo, citada, curada). Pero
cada lectura es **efímera**: la fachada devuelve una proyección curada en memoria y el cuerpo HTTP
crudo se descarta dentro de `requestJson`/`requestForm`/`requestText`. Nada persiste salvo tres
JSON en `~/.sii/` (`session`, `operate`, `monitor`, `cache`). Consecuencias medidas:

- **No hay evidencia.** Un informe de auditoría cita una cifra que ya no se puede reproducir: el
  artefacto del que salió no existe. ADR-004 exige `// observed at <URL> on <YYYY-MM-DD>` en el
  CÓDIGO — procedencia para el desarrollador, no para el dato.
- **No hay medición.** 596 tests contra fakes prueban que el parser no se rompió; **ninguno** mide
  si extrae bien un documento real, cuánta normativa aplicable conoce el sistema, ni si los
  hallazgos que levanta coinciden con los que un auditor confirmó.
- **La lógica tributaria es código.** `f22-codigos.ts`, `f29-codigos.ts` (157 códigos),
  `TIPOS_REVERSA`, y la escalera `alta|media|info` de `monitor.ts` son condicionales a mano. Cada
  corrección necesita un release; ninguna lleva confianza, vigencia ni historial.
- **No hay normativa.** La regulación aparece solo como prosa en comentarios (Ley 19.983, Art. 42
  N°2, Art. 74 N°2, Art. 200 CT). Nada es recuperable ni fechado, así que **nada se puede citar**.

## Decision

Un paquete nuevo, **`packages/auditor/`** (`@dostertags/sii-auditor`), con nueve módulos y
un bucle nocturno de ocho etapas. Cinco invariantes lo gobiernan; el resto del diseño se deriva.

### I1 — Toda aserción lleva procedencia, y se obtiene GRATIS por decoración de la seam

La pieza clave: **`RecordingPortalDriver`**, un decorador sobre la seam `PortalDriver` (ADR-003)
que envuelve la `PortalSession` devuelta por `restore()` y **tee-a** cada respuesta cruda —cuerpo,
URL, estado HTTP, instante, hash de contenido— al almacén de artefactos ANTES de entregarla a la
fachada. Se instala en la raíz de composición: `createNodeRuntime({ portal: recording(...) })`,
exactamente el override que ADR-016 abrió.

**Cero cambios en `packages/core`.** Las 14 fachadas no se enteran, cubre las seis primitivas de
transporte de una vez, y la procedencia deja de ser algo que cada fachada deba acordarse de
adjuntar: es estructural. Un `Provenance` (hash de artefacto + URL + timestamp + id de estrategia)
es un CAMPO que atraviesa todo, no un módulo.

### I2 — La normativa se recupera y se cita, o el sistema dice que no sabe

`kb/normativa` guarda texto regulado troceado con anclas de cita estables (cuerpo, artículo, rango
de vigencia) y responde consultas **"qué regía el día X"**, porque una auditoría es retrospectiva.
`ask/` devuelve un `Answer` cuyo tipo **exige** al menos una cita: un `Answer` sin `citations` no
es representable. Cuando la evidencia no alcanza, el resultado es `Declined` con el motivo — no
una respuesta con menos confianza. **Ningún módulo genera texto normativo.**

### I3 — Las reglas son datos versionados con una máquina de estados de promoción

Un `RuleRecord` lleva expresión (un **AST JSON de operadores cerrados**, evaluado por un
intérprete total — nunca `eval`, nunca un DSL a mano), ámbito de aplicabilidad, confianza,
procedencia, estado (`candidate | validated | retired`) e historial de versiones. Las transiciones
son puras y totales: `propose → candidate`, `candidate → validated` **solo por la compuerta**,
cualquiera → `retired`. La máquina de estados se implementa completa en esta sesión: es lógica
pura, es lo que hace exigible el invariante I4, y no depende de nada diferido.

### I4 — Nada se auto-modifica sin pasar la compuerta

El bucle **propone**; `eval/gate.ts` **promueve**. Un cambio candidato entra a producción solo si
mejora al menos una métrica objetivo sin degradar las otras más allá de una tolerancia declarada,
en el orden de prioridad **extracción → normativa → hallazgos**. Los rechazados se conservan con
su motivo y un hash del cambio, para que la misma mala idea no se re-proponga cada noche. La
compuerta corre contra el conjunto dorado; sin conjunto dorado la compuerta **rechaza todo**, que
es el modo de fallo correcto (ADR-034: preferir la fuente que falla ruidosamente).

### I5 — Determinismo primero; el identificador del cliente no cruza el borde

Misma entrada + misma versión del conjunto de reglas ⇒ misma salida, byte a byte. El tiempo entra
por la seam `Clock` (ADR-003), nunca por `Date.now()`. Los componentes estocásticos se aíslan
detrás de `scoring/model.ts` y se siembran explícitamente; el `baseline` estadístico por defecto
(z-score robusto con mediana/MAD sobre la propia historia del contribuyente) es determinista.
Precedente ya establecido: ADR-040 declaró la salida de Llama 3.1 "señal adicional, nunca
autoritativa".

**El borde de confidencialidad es una función, no una convención.** `confidential.ts` define
`TaxpayerKey` = hash con sal del RUT, sal local jamás comiteada. El almacén normalizado (local,
privado, del propio usuario) guarda el RUT real porque debe; **la KB, los resultados de `eval`, el
manifiesto de corrida y cualquier prompt salen indexados por `TaxpayerKey`**. El conjunto dorado
son expedientes reales, así que vive en una ruta configurable **fuera del repositorio**
(`SII_AUDITOR_GOLDEN_DIR`), nunca en `packages/`.

### Alcance del almacén

`store/` es **multi-contribuyente desde el día uno** (los expedientes se acumulan; el conjunto
dorado no tiene sentido con un solo contribuyente), mientras que la ingesta sigue siendo
**una sesión viva a la vez** — ADR-005 intacto: el bucle itera contribuyentes en serie, cada uno
con su propio login. Las entidades normalizadas modelan **solo lo que el SII expone**
(contribuyente, período, formularios F22/F29, DTE, libros RCV, DJ, giros, notificaciones) más un
asiento contable genérico para cuando exista una fuente real. **No hay generación de balance ni
de estado de resultados** en este alcance: `dj detalle` (ADR-031) LEE el balance de 8 columnas que
el SII ya tiene, y deliberadamente no lo interpreta semánticamente.

## Alternatives Considered

1. **Entrenar un modelo directamente sobre los datos de auditoría** (la alternativa que el
   encargo pide evaluar explícitamente) — **rechazada, y es la decisión central de este ADR.**
   Cuatro razones, en orden de peso: (a) **la salida no sería citable** — un modelo entrenado
   emite un veredicto, no un artículo con su rango de vigencia, y una observación del SII se
   contesta con la norma, no con una probabilidad; (b) **la retrospectividad rompe el
   entrenamiento** — una auditoría juzga el año N con la norma vigente en el año N, y un modelo
   entrenado sobre expedientes de varios años promedia regímenes que se excluyen entre sí (el
   propio proyecto ya vive esto: `M14A`, `REGS`, `FAEL`, `SGGC`); (c) **el volumen no existe** —
   los expedientes completos se cuentan por decenas, tres órdenes de magnitud menos de lo que
   pide un modelo que no memorice; (d) **una corrección no sería atribuible** — cuando un auditor
   corrige un hallazgo, en el enfoque de reglas se edita UN registro con su historial, y en el
   enfoque entrenado se reentrena y se espera. El enfoque adoptado no cierra esta puerta:
   `scoring/model.ts` deja la interfaz del modelo entrenado detrás del baseline, y la compuerta
   lo juzgaría con las mismas métricas. Lo que se rechaza es que el modelo **emita** la regla.
2. **Reglas en Python/YAML con un motor de terceros** (Drools, `business-rules`, `json-logic`) —
   rechazada: ADR-004 prohíbe lógica tributaria de terceros y el intérprete total que hace falta
   son ~120 líneas; una dependencia externa traería un lenguaje de expresión más grande de lo que
   se puede auditar, que es justo lo contrario del objetivo.
3. **Python para todo el sistema nuevo** (la petición original) — rechazada por el usuario tras
   constatar que el repositorio no tiene Python: sería una segunda cadena de herramientas, un
   segundo runner de tests y un borde de serialización hacia cada fachada existente, a cambio de
   un ecosistema analítico que el baseline determinista de `scoring/` no necesita.
4. **Postgres/SQLite ya** — diferida: `NormalizedStore` es una interfaz con forma de SQL y una
   implementación por archivos; un adaptador SQLite entra después sin tocar a los llamadores
   (mismo criterio que ADR-008 con el keyring). Evita una dependencia pesada antes de que exista
   un solo registro real.
5. **Nueve paquetes pnpm, uno por módulo** — rechazada: nueve `package.json`, nueve `tsconfig` y
   nueve referencias de proyecto para un grafo que nunca se publica por separado. Un paquete con
   nueve directorios respeta igual la regla de dependencias descendentes de ADR-007.
6. **Un demonio programador propio** — rechazada: ADR-024 dejó la programación desatendida fuera
   de alcance a propósito. `make nightly` es un proceso que corre y termina; quién lo despierta es
   el Programador de tareas de Windows / `cron` / un timer de `systemd`.

## Consequences

- **Más fácil:** una cifra de un informe se rastrea hasta los bytes exactos de los que salió; una
  corrección de un auditor es un dato que el sistema absorbe, no un ticket; el efecto de un cambio
  es medible antes de promoverlo.
- **Obligación real:** el conjunto dorado son **expedientes reales completos** y hay que curarlo a
  mano — sin él la compuerta rechaza todo y el bucle no aprende nada. Es el cuello de botella del
  sistema y no se puede sintetizar (regla explícita del encargo).
- **Nombre elegido para no colisionar:** `auditor` (asiste al auditor), NO `audit` — ese nombre ya
  es `core/src/audit/`, el recibo JSONL de ADR-004. Dos cosas distintas con el mismo nombre en un
  repositorio que ya distingue `bte` de `bpst` por un pelo sería una trampa evitable.
- **Deuda declarada, no resuelta aquí:** 33 archivos rastreados bajo `docs/` llevan el RUT y la
  razón social reales de un cliente (ADR/audits/CONVENTIONS). El borde de `confidential.ts` rige
  los módulos NUEVOS; sanear lo existente es un trabajo aparte con su propia decisión, porque
  ADR-019 fijó el precedente de no reescribir registros históricos.
- **Riesgo asumido:** `RecordingPortalDriver` persiste cuerpos crudos, y un cuerpo crudo del RCV
  trae `raw` con identidad de contrapartes — exactamente lo que ADR-028 sacó de la superficie. El
  almacén de artefactos hereda el endurecimiento de ADR-025 y queda fuera del repositorio, pero es
  una huella en disco mayor que la de hoy, y hay que decirlo en vez de descubrirlo después.
