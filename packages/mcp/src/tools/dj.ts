// `dj_*` MCP tools — Estado y contenido de Declaraciones Juradas (ADR-030 / ADR-031). Thin calls
// into @dostertags/sii-core tasks (ADR-003), read-only. zod input schemas (ADR-011).
// SESSION-KEYED for now: reads the session principal; no `rut` argument.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { djDetalle, djHistorial, djStatus, type Runtime } from '@dostertags/sii-core';
import { toolText } from '../tool-helpers.js';

export function registerDjTools(server: McpServer, runtime: Runtime): void {
  server.registerTool(
    'dj_status',
    {
      title: 'DJ — estado de Declaraciones Juradas',
      description:
        'Estado de las Declaraciones Juradas (DJ) del titular para los últimos N años ' +
        'tributarios (por defecto 6, máximo 15) — qué DJ (1835, 1847, 1879, 1887, 1926, 1948, ' +
        'etc.) están aceptadas, observadas, o sin registro para cada año. SESSION-KEYED: lee ' +
        'SIEMPRE el titular de la sesión (no acepta otro RUT).',
      inputSchema: { years: z.number().int().positive().optional() },
      annotations: { readOnlyHint: true },
    },
    ({ years }) =>
      toolText(async () =>
        JSON.stringify(await djStatus(runtime, years !== undefined ? { years } : {}), null, 2),
      ),
  );

  server.registerTool(
    'dj_historial',
    {
      title: 'DJ — historial de presentaciones',
      description:
        'Historial de presentaciones por DJ para un año tributario: folio, estado, fecha, ' +
        'tipoDeclaracion (incluye anuladas y rectificatorias). El "key" de cada presentación es ' +
        'lo que necesita dj_detalle. SESSION-KEYED: lee SIEMPRE el titular de la sesión.',
      inputSchema: { anio: z.union([z.string(), z.number()]) },
      annotations: { readOnlyHint: true },
    },
    ({ anio }) => toolText(async () => JSON.stringify(await djHistorial(runtime, { anio }), null, 2)),
  );

  server.registerTool(
    'dj_detalle',
    {
      title: 'DJ — contenido de una declaración (balance/RLI, etc.)',
      description:
        'Contenido de una DJ anual presentada — la tabla tal como la entrega SII (secciones → ' +
        'filas → celdas), SIN reinterpretar qué columna significa qué (para no arriesgar una ' +
        'cifra mal atribuida): compara los valores de una fila "dato" contra los rótulos de la ' +
        'fila "cabecera" en la misma posición de columna. Usa el "dj" y "key" que entrega ' +
        'dj_historial. Solo DJ ANUALES están confirmadas en vivo. SESSION-KEYED.',
      inputSchema: {
        anio: z.union([z.string(), z.number()]),
        dj: z.number().int(),
        key: z.number().int(),
        seccion: z.number().int().optional(),
        pagina: z.number().int().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    ({ anio, dj, key, seccion, pagina }) =>
      toolText(async () =>
        JSON.stringify(
          await djDetalle(runtime, {
            anio,
            dj,
            key,
            ...(seccion !== undefined ? { seccion } : {}),
            ...(pagina !== undefined ? { pagina } : {}),
          }),
          null,
          2,
        ),
      ),
  );
}
