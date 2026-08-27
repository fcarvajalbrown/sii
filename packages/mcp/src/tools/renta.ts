// `renta` MCP tool — the annual pack (ADR-022). Thin call into the `rentaAnual` composite task
// (ADR-003), read-only. zod input schema (ADR-011). SESSION-KEYED (ADR-005): no `rut` argument.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { rentaAnual, type Runtime } from '@dostertags/sii-core';
import { toolText } from '../tool-helpers.js';

export function registerRentaTools(server: McpServer, runtime: Runtime): void {
  server.registerTool(
    'renta',
    {
      title: 'Renta anual (pack F22 + F29)',
      description:
        'Pack anual de un año tributario (YYYY): el F22 (folio, estado y el formulario agrupado ' +
        'en ingresos / deducciones / retenciones·PPM·créditos / cálculo / resultado) junto a las ' +
        'doce posiciones mensuales del F29 del AÑO COMERCIAL que ese F22 declara — siempre año-1 ' +
        '(el F22 de AT 2026 declara el año comercial 2025). Un año sin declaración, o un mes sin ' +
        'F29 presentado, devuelve valores vacíos, no un error. SESSION-KEYED: lee SIEMPRE el ' +
        'titular de la sesión. Expone datos tributarios del contribuyente.',
      inputSchema: { anio: z.string(), refresh: z.boolean().optional() },
      annotations: { readOnlyHint: true },
    },
    ({ anio, refresh }) =>
      toolText(async () =>
        JSON.stringify(
          await rentaAnual(runtime, { anio, ...(refresh !== undefined ? { refresh } : {}) }),
          null,
          2,
        ),
      ),
  );
}
