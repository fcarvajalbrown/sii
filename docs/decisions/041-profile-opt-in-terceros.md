# ADR-041: Superficie `profile` — domicilio propio + socios/representantes con opt-in explícito

## Status

Accepted — 2026-08-05. Cierra P8 (`docs/ESTADO-CONSOLIDADO.md` §3) y `docs/BACKLOG.md` §3.4
(domicilio).

## Context

`situacion.ts` (ADR-035) ya lee `opc=112` pero deliberadamente reduce `socios`/`representantes`/
`direcciones` a un CONTEO — la decisión correcta para esa superficie (una vista de "¿estoy en
regla?", no un perfil completo). Eso dejó dos necesidades reales sin resolver:

1. **`BACKLOG.md` §3.4**: `whoami` da razón social + email; el domicilio (`direcciones[]`) no se
   expone en ningún lado.
2. **El seguimiento explícito de ADR-035**: una superficie `profile` con opt-in para
   socios/representantes — útil para un contador que necesita confirmar la composición societaria
   vigente de su cliente, pero que NUNCA debe aparecer en una lectura por defecto.

Se re-confirmó en vivo (2026-08-05, a real taxpayer account) la forma REAL de `opc=112.socios[]` /
`.representantes[]` / `.direcciones[]` — no se había citado antes con nombres de campo exactos,
solo categorías ("RUT, nombres, participación"). Campos observados (nombres de campo citados;
LOS VALORES REALES capturados —terceros identificables— NO se citan en este documento ni en
ningún artefacto del repo, por ser PII de personas/empresas distintas del contribuyente):

- `socios[]`: `rut`, `dv`, `razonSocial`, `nombres`, `apellidoPaterno`, `apellidoMaterno`,
  `participacionCapital`, `participacionUtilidades`, `porcentajeAtribucion`,
  `fechaIncorporacion`, `fechaFinParticipacion`, `fechaModificacion`, `vigente` (`"S"`/`"N"`
  observado). Cada elemento del array trae además `codigoError`/`descripcionError`/`sysdate`/
  `index` — ruido de un envelope repetido por fila, no dato del socio; se descarta.
- `representantes[]`: `rut`, `dv`, `razonSocial`, `nombres`, `apellidoPaterno`,
  `apellidoMaterno`, `fechaInicio`, `fechaTermino`, `vigente`.
- `direcciones[]`: `calle`, `numero`, `comunaDescripcion`, `regionDescripcion`,
  `tipoDomicilioDescripcion`, `tipoPropiedadDescripcion`, `telefono`, `canon`,
  `rutPropietario`/`dvPropietario` (el arrendador — el mismo campo que ADR-035 ya había
  identificado como PII de tercero), `fechaModiRegistro`.

## Decision

1. **Nueva tarea `profile` (`tasks/profile.ts`)**, session-keyed self-only (mismo guard que
   `situacion`/`bancario`), reutilizando `fetchPerfilCompleto` — una función NUEVA en
   `portal/situacion.ts` que hace la MISMA petición `opc=112` (no un endpoint nuevo) pero
   proyecta también `socios`/`representantes`/`direcciones` a tipos curados. `situacion.ts`'s
   `fetchPerfilContribuyente` (usada por `sii situacion`) **no cambia** — sigue exponiendo solo el
   conteo, sin tocar su contrato existente.
2. **Domicilio PROPIO va SIN opt-in** — calle, comuna, región, tipo de domicilio, teléfono: es la
   dirección del CONTRIBUYENTE mismo, misma categoría que `whoami`'s email (dato propio, no de
   terceros). **`rutPropietario`/`dvPropietario` (el arrendador) SÍ requiere opt-in** — es la
   identidad de un tercero, igual que `direcciones[]` completo se denylistó en ADR-035.
3. **Socios y representantes completos requieren `--incluir-terceros` (CLI) /
   `incluirTerceros: true` (MCP) — sin eso, `profile` solo informa el CONTEO**, igual que
   `situacion` ya hace. Con el opt-in: RUT, razón social/nombre, participación (capital y
   utilidades), vigencia — nunca `sraGpk`/`sraNdr` (valor `null` en toda observación, significado
   desconocido, no se asume nada sin observarlo con un valor real — ADR-004).
4. **La descripción del tool MCP declara la exposición explícitamente** cuando `incluirTerceros`
   está disponible — mismo patrón que `peticiones_list`/`notificaciones_detalle`.
5. **Auditoría**: el recibo registra `rut` + `incluyoTerceros: boolean` + cuántos socios/
   representantes — NUNCA sus RUT ni nombres (ADR-006).
6. **No se investigó el resto de `contribuyente` (45 campos) más allá de lo que `situacion`/
   `whoami` ya citan** — fuera de alcance de este ADR; se toman los mismos campos ya curados por
   `PerfilContribuyente` como base y se extienden solo con domicilio + terceros.

## Alternatives Considered

1. **Extender `situacionTributaria`/`sii situacion` con un flag `--completo` en vez de una
   superficie nueva.** Rechazado — `situacion` es deliberadamente "¿estoy en regla?" (ADR-035);
   mezclar ahí un modo con PII de terceros complica su contrato ya estable y sus tests. Una
   superficie separada, con su propio nombre que declara su propósito ("perfil"), es más clara.
2. **Exponer socios/representantes siempre, sin opt-in, confiando en que MCP declare la
   exposición.** Rechazado — el mismo criterio que BTE/BPST/notificaciones: un dato de terceros no
   debe aparecer en una lectura por defecto solo porque la descripción lo advierte; el opt-in es
   la barrera real, la descripción es la señal humana/LLM de que existe.
3. **Denylist de campos dentro de socios/representantes en vez de opt-in binario.** Rechazado —a
   diferencia de F22 (donde el código tributario SIN PII es la mayoría y el denylist es acotado),
   aquí CASI TODO el contenido de `socios`/`representantes` ES la identidad del tercero; no hay
   nada útil que quede tras un denylist de campos.

## Consequences

- Cierra P8 y BACKLOG §3.4 con una sola fachada nueva, reutilizando `opc=112` (sin costo de red
  adicional más allá de una llamada extra a un endpoint YA seguro y ya usado por `situacion`).
- El grafo `graphify` ya había señalado la conexión `whoami ⟷ opc=112` (misma pregunta, dos vías)
  — esta superficie es la resolución natural de esa señal.
- Sin verificar: el significado de `sraGpk`/`sraNdr` (siempre `null` en la observación disponible).
