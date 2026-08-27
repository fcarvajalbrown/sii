# ADR-039: Informe bancario (`bancario resumen`) — abonos por semestre, la brecha E1

## Status

Accepted — 2026-08-05. Cierra **E1** de `docs/ESTADO-CONSOLIDADO.md` §5 — señalada ahí como "la
mayor oportunidad no explotada del proyecto" (dato ya localizado en un spike previo, ningún módulo
lo usaba).

## Context

Un informe SII de abonos bancarios por semestre (cuántos abonos, monto total, por banco y tipo de
cuenta) es el insumo del cruce de fiscalización más agresivo del SII: comparar depósitos bancarios
contra ventas declaradas. Una sesión previa había localizado el `opc` (`119` en `CViewCarta.cgi`,
el mismo CGI que ya usan `situacion.ts` — ADR-035 — y `notificaciones.ts` — ADR-032) y capturado
una muestra con datos reales, resumida en `ESTADO-CONSOLIDADO.md` §5 (E1) — pero **sin log de
auditoría ni contrato de wire propios**, solo la mención en el índice. Antes de construir sobre
eso, esta sesión volvió a golpear el endpoint en vivo para confirmarlo de primera mano (ADR-004: no
se construye sobre una cita que no se puede verificar).

## Decision

1. **Reconfirmado en vivo (2026-08-05, a real taxpayer account):**
   ```
   POST https://misiir.sii.cl/cgi_misii/CViewCarta.cgi
   opc=119&VIEW=1
   ```
   → `{"listCarpetaTributaria":[{rutTitularC2, dvTitularC2, periodoDj, glosaNombreBanco,
   glosaTipoCuenta, semestre, sumaCantidadAbonos, sumaMontoTotalAbonos}, …]}` — una fila por
   semestre/banco/tipo de cuenta. Los números coinciden con los citados en el spike previo
   (1.433 abonos / $619.837.498 para el semestre más antiguo observado), confirmando que aquella
   cita era real, no una alucinación de un resumen anterior.
2. **Envelope PROPIO, otro más del mismo CGI multi-forma** (ADR-035 ya documentó que
   `CViewCarta.cgi` no tiene un envelope común — este es el séptimo/octavo/noveno observado según
   se cuente). Nombre de clave (`listCarpetaTributaria`) engañoso — **no tiene relación con la
   Carpeta Tributaria Regular (ADR-033)**; es el nombre interno que SII usa para este JSON, no una
   pista de su contenido real. Documentado explícitamente para que nadie lo confunda a futuro.
3. **Nueva fachada `portal/bancario.ts`** — `fetchInformeBancario(session)`, sin parámetros (el
   RUT viaja por la cookie de sesión, igual que `situacion`/`notificaciones`). zod `.loose()` en
   el borde (ADR-011); cada fila se proyecta a un tipo curado. **`periodoDj` y `semestre` pasan
   VERBATIM, sin decodificar** — se observó una inconsistencia real (`periodoDj:202502` Y
   `periodoDj:202507` ambos etiquetados `"Primer semestre 2025"` por SII) que ADR-004 prohíbe
   resolver por adivinanza; se cita tal cual en el contrato de wire.
4. **Session-keyed, self only** — mismo REQUISITO cauteloso que `situacion`/`notificaciones`/F22/
   F29: no se observó parámetro de RUT representado en la petición, y `rutTitularC2` en la
   respuesta siempre fue el RUT de la sesión, nunca uno representado. Sin `--rut`.
5. **Nueva tarea `tasks/bancario.ts`** (`bancarioInforme`) — `withSession` + un recibo de
   auditoría (solo conteo de filas y período, NUNCA un monto — ADR-006/ADR-024, mismo criterio
   que todo el resto del proyecto). Nuevo `BancarioError` (SII rejects / envelope no reconocido).
6. **CLI `sii bancario resumen` / MCP `bancario_resumen`** — sin argumentos, `readOnlyHint`. La
   descripción del tool MCP declara que expone MONTOS AGREGADOS de depósitos bancarios propios
   (no de terceros, no PII de identidad, pero sí dato financiero sensible) — misma disciplina de
   declarar la exposición que `whoami`/`notificaciones detalle`.
7. **NO se explora paginación ni desglose por transacción individual en esta primera versión** —
   la respuesta observada es un resumen agregado por semestre/banco (3 filas para este
   contribuyente en 3 semestres), sin indicio de una vista más granular en el mismo `opc`. Un
   desglose transacción-por-transacción, si existe, es una fachada FUTURA, no parte de este ADR.

## Alternatives Considered

1. **Confiar en la cita de `ESTADO-CONSOLIDADO.md` sin re-verificar en vivo.** Rechazado — ADR-004
   exige que cada afirmación esté citada y sea verificable; un resumen de sesión anterior sin log
   de auditoría propio no es una cita verificable por sí sola, así que se re-probó antes de
   construir sobre ella.
2. **Decodificar `periodoDj` a un rango de fechas legible.** Rechazado por ahora — la
   inconsistencia observada (dos períodos distintos con la MISMA glosa de semestre) impide inferir
   una regla confiable sin más observaciones. Se pasa verbatim; una `Anio`/`Periodo` propios del
   dominio ya existen si se decide resolverlo más adelante con más datos.
3. **Nombrar el módulo `carpeta-bancaria` o similar (siguiendo la clave `listCarpetaTributaria`
   de SII).** Rechazado — ese nombre confundiría con ADR-033 (Carpeta Tributaria Regular), un
   producto SII completamente distinto. Se nombra por lo que el dato REALMENTE es
   (informe bancario / abonos), no por la clave interna con la que SII lo envuelve.

## Consequences

- Cierra E1 — el cruce bancario que un cliente puede usar para auto-verificar si sus depósitos
  declarados cuadran con lo que el SII ya está mirando, antes de que el SII se lo señale.
- Abre una pregunta de producto (fuera de alcance de este ADR): comparar `sumaMontoTotalAbonos`
  contra las ventas declaradas del mismo semestre sería un cruce de alto valor, pero requiere
  resolver primero la ambigüedad de `periodoDj` → rango de meses exacto, y decidir qué RCV/F29
  agregado corresponde a cada semestre. Queda para un composite futuro, no para esta fachada base.
- Wire contract: `docs/sii-contract/bancario.md`.
