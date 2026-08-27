# ADR-038: `monitor` — plazo real del F29 y anclaje por `fechaInicioActividades` (P1+P2)

## Status

Accepted — 2026-08-05. Cierra los dos hallazgos abiertos que ADR-037 documentó y deliberadamente
NO corrigió al vuelo (P1 y P2 de `docs/ESTADO-CONSOLIDADO.md` §3). Extiende ADR-024/ADR-035/ADR-037
sin cambiar ninguno de sus principios.

## Context

Dos falsos positivos preexistentes en `monitor.ts` → `estadoFindings`:

1. **P1**: el mes F29 inmediatamente anterior al actual se marcaba `alta` ("sin declaración") aun
   cuando su plazo legal (día 12, o 20 para un declarante electrónico) todavía no vencía. La
   corrida en vivo del 2026-08-04 marcó F29 2026-07 en `alta` el día 04-08, cuando su plazo era el
   12 o el 20 de agosto — un falso "incumplimiento" que un cliente lee como error del proyecto.
2. **P2**: el anclaje de severidad para F22/F29 pre-inicio usaba una heurística ("anclar en la
   evidencia más antigua detectada") porque `docs/CONVENTIONS.md` daba por inexistente un campo
   real de "fecha de inicio de actividades". ADR-035 observó en vivo que `opc=112` SÍ lo expone
   (`contribuyente.fechaInicioActividades`, `"2019-06-19 00:00:00.0"` para Empresa A) — y que
   la heurística acertaba, no reemplazándola por eso mismo: cambiar el anclaje merecía su propio
   trabajo con sus tests.

## Decision

1. **`fetchPerfilContribuyente` (`portal/situacion.ts`) expone `autorizadoDeclararDia20`** como
   `boolean | null` (vía el mismo helper `siNo()` que ya cura `afectoIva`) — el campo ya estaba
   citado en `docs/sii-contract/situacion.md` como observado pero no curado.
2. **`monitor.ts` → `sweep()` llama a `fetchPerfilContribuyente` una vez más por barrido**
   (mismo patrón que las otras señales del spike F: `errores` captura un fallo, nunca aborta el
   resto). Ni `autorizadoDeclararDia20` ni `fechaInicioActividades` se PERSISTEN en el snapshot —
   son insumos de juicio para `estadoFindings`, no estado a diffear (ADR-024 solo pide
   identificadores y estados que SÍ cambian entre corridas).
3. **P1**: el mes INMEDIATAMENTE anterior a `currentPeriodo` se exime a `severidad:'info'` (nunca
   se descarta en silencio — ADR-004: surface, don't drop) mientras `now.getDate() <= plazoDia`,
   con `plazoDia = autorizadoDeclararDia20 ? 20 : 12`. **Sin el dato** (perfil no disponible este
   barrido) se mantiene el comportamiento anterior (`alta`) — nunca se asume el plazo más
   permisivo.
4. **P2**: `fechaInicioActividades` (parseado con una regex que exige el formato exacto observado
   `"YYYY-MM-DD…"`, `null` en cualquier otro caso — ADR-004: nunca adivinar un formato no visto)
   reemplaza la heurística como anclaje: el primer año tributario que debe declarar es
   `añoComercialInicio + 1` (AT N reporta el año comercial N-1); el primer período F29 que debe
   declarar es el mes de inicio mismo. **Sin el dato**, la heurística de "primer año/mes con
   declaración detectado" sigue como respaldo — el mismo camino que ADR-037 dejó pendiente.

## Alternatives Considered

1. **Persistir `autorizadoDeclararDia20`/`fechaInicioActividades` en el snapshot.** Rechazado:
   ADR-024 reserva el snapshot para identificadores y ESTADOS QUE CAMBIAN; estos dos campos son
   metadata casi estática del contribuyente, no una señal a diffear entre corridas.
2. **Asumir día 20 (el más permisivo) cuando `autorizadoDeclararDia20` no está disponible.**
   Rechazado: sería asumir un dato no observado en ESTA corrida (ADR-004) — mejor sobre-reportar
   (comportamiento previo) que fallar en silencio hacia el lado optimista.
3. **Eliminar el mes anterior del reporte en vez de marcarlo `info`.** Rechazado: ADR-024/ADR-037
   established el precedente de "nunca silenciar, solo degradar" para todo hallazgo de estado
   pre-existente (observaciones resueltas, años pre-inicio); el mismo criterio aplica aquí.

## Consequences

- Cierra P1 y P2 de `docs/ESTADO-CONSOLIDADO.md` §3 — las dos correcciones de mayor
  relación valor/esfuerzo señaladas ahí, según la propia recomendación estratégica del documento.
- Costo: un POST más por barrido (`opc=112`), paceado igual que el resto (ADR-004).
- **Live-validado 2026-08-05** (a real taxpayer account, tras renovar sesión): `F29 2026-07` →
  `severidad:'info'`, "el plazo (día 20) todavía no vence"; `F22 AT2019` → `severidad:'info'`,
  cita `fechaInicioActividades=2019-06-19` real (no la heurística); `errores: []` en ambas
  corridas — ver `docs/audits/2026-08-05-dia1-p1-p2.md`.
