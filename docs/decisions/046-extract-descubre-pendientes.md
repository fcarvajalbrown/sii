# ADR-046: `extract` descubre artefactos pendientes en el almacén, no en su propia corrida

## Status

Accepted — 2026-08-10. Repara la brecha entre lo que ADR-044 **afirma** ("la etapa 2 parsea
artefactos que ya están en el almacén") y lo que W3 **implementó** (la etapa 2 solo mira los
artefactos de SU PROPIA corrida). No cambia ningún invariante de ADR-043; no toca ADR-006.

## Context

El primer `fetch` real (2026-08-10, 14 artefactos) seguido del primer `learn` real lo expuso:

- `extractStage` se bloqueaba con el resultado de `ingest` DE ESTA corrida (`status !== 'ok'` ⇒
  ocioso) y acotaba el descubrimiento a `findManifests({ runId: ctx.runId })`.
- Bajo el corte de ADR-044, el `ingest` de una corrida `learn` SIEMPRE está `skipped` y los
  artefactos del `fetch` pertenecen a OTRO runId. Conclusión: **el objetivo del programador de
  tareas (`learn`) no podía extraer nada, nunca** — solo `run` (las ocho etapas en un proceso)
  ejercitaba la etapa 2, lo que anula el propósito del corte.

El comentario de W3 ("acotado a esta corrida; re-parsear la historia es un backfill deliberado")
era correcto en su intención — la noche no es un backfill — pero eligió la cota equivocada: el
runId, cuando la distinción real es **intentado vs. nunca intentado**.

## Decision

**El conjunto pendiente es: cada manifiesto de un sujeto CONFIGURADO cuyo `contentHash` no está
referenciado por ningún registro NI fallo de extracción.** La etapa 2 lo calcula plegando el log de
extracciones (`ExtractionStore.referencedArtifacts()`, método nuevo: la unión de
`provenance.artifact` sobre todos los registros y fallos de todas las corridas) contra los
manifiestos del almacén, y deja de consultar el resultado de `ingest` por completo.

Reglas que fijan el comportamiento (cada una con su test):

1. **Un fallo cuenta como intentado.** Un artefacto que revienta el parser no se reintenta cada
   noche; re-parsearlo tras arreglar el parser es un **bump de versión + backfill deliberado**,
   exactamente la postura de W3, que no cambia.
2. **Un artefacto que ningún estrategia matchea NO se registra en el log**, así que sigue
   pendiente. Es una propiedad, no un descuido: la noche en que aterrice el wrapper de una
   superficie barrida (`rcv-detalle`), el backlog completo se extrae solo, sin backfill manual.
   Mientras tanto el contador `unmatched` lo reporta cada noche — visible, nunca silencioso.
3. **Acotado a los sujetos configurados** (`config.taxpayers`), por la misma razón que
   `computeDataAsOf`: los artefactos de un sujeto no configurado no son de esta corrida. Efecto
   lateral deliberado: la historia 2026-08-06 bajo la sal huérfana (clave `f1ba969f…`, ver la
   corrección del roadmap) NO inunda la primera `learn` — queda esperando la decisión de migración
   de sal, que es de quien opera, no de esta etapa.
4. **Dedupe por `contentHash`** dentro del conjunto pendiente (se conserva el manifiesto más
   antiguo). Coherente con la identidad de registro ya existente (`<hash>:<estrategia>`): bytes
   idénticos son UN artefacto, tenga uno o veinte manifiestos.
5. Orden determinista sin cambios: `retrievedAt`, luego `contentHash`.

En modo `run` el comportamiento queda subsumido: los artefactos que `ingest` acaba de grabar nunca
fueron intentados, así que entran al conjunto pendiente igual que antes.

## Alternatives Considered

1. **Enlazar la corrida `learn` con la(s) última(s) corrida(s) `fetch`** — rechazada. ¿Cuáles?
   ¿Dos fetch desde el último learn? ¿Y si un learn abortó a mitad? Cada respuesta inventa
   contabilidad de enlaces que el fold obtiene gratis, y un learn caído dejaría artefactos
   huérfanos para siempre.
2. **Mantener la cota por runId y declarar `run` el único modo que extrae** — rechazada. Ata la
   extracción a una sesión viva, que es exactamente lo que ADR-044 existe para evitar; el objetivo
   nocturno quedaría decorativo.
3. **Marcar como intentado el artefacto sin estrategia** — rechazada. Pierde el backlog
   auto-drenante (regla 2) y obliga a un backfill manual cada vez que aterriza un parser nuevo,
   que es el caso más común de los próximos meses.

## Consequences

- **`learn` extrae de verdad.** La historia de registros extraídos —el prerrequisito de las etapas
  3–5— puede por fin empezar a acumularse sin una persona presente.
- **Costo nocturno:** plegar el log es O(corridas) lecturas de archivo + un `findManifests` por
  sujeto. Trivial a esta escala; si el log crece a miles de corridas, un índice es trabajo futuro
  y este ADR es el lugar que lo documenta.
- **Interacción con `prune` (importante):** un artefacto pendiente no está referenciado por el log
  todavía — su única protección es la edad de sus manifiestos. `prune` ya es manual y explícito
  (ADR-043); la regla operativa es: **no podar con un `before` posterior al último `learn` que
  haya drenado el conjunto pendiente.** Automatizar la poda necesitaría considerar pendientes.
- **Borde asumido:** bytes idénticos capturados para DOS sujetos configurados (en la práctica,
  solo respuestas vacías) cuentan como intentados para ambos — coherente con que el id de registro
  no incluye sujeto. Si alguna vez importa, el cambio es al esquema de identidad de registros, no
  a este descubrimiento.
- El mensaje ocioso de la etapa pasa de "no new artifacts from ingest" a "no pending artifacts" —
  el manifiesto sigue siendo el relato honesto de la noche.
