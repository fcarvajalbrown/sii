// `giros_list` MCP tool — deuda fiscal formal (ADR-034). Llamada fina a un task de
// @dostertags/sii-core (ADR-003), solo lectura. Esquema zod (ADR-011). SESSION-KEYED.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { girosList, type Runtime } from '@dostertags/sii-core';
import { toolText } from '../tool-helpers.js';

export function registerGirosTools(server: McpServer, runtime: Runtime): void {
  server.registerTool(
    'giros_list',
    {
      title: 'Giros — deuda fiscal emitida por el SII',
      description:
        'Giros emitidos al titular (deuda fiscal formal): folio, formulario asociado (ej. el ' +
        'F29 que lo origina), fecha de emisión y de VENCIMIENTO, estado y saldo. Por defecto el ' +
        'año en curso; "anio" fija uno, "years" barre hacia atrás. OJO: el estado "Vigente" se ' +
        'observó junto a saldo $0 — "Vigente" describe el documento, NO significa impago; la ' +
        'deuda es el campo "saldo". SOLO LECTURA: esta herramienta nunca paga un giro. ' +
        'SESSION-KEYED: lee SIEMPRE el titular de la sesión (no acepta otro RUT).',
      inputSchema: {
        anio: z.string().optional(),
        years: z.number().int().positive().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    ({ anio, years }) =>
      toolText(async () =>
        JSON.stringify(
          await girosList(runtime, {
            ...(anio !== undefined ? { anio } : {}),
            ...(years !== undefined ? { years } : {}),
          }),
          null,
          2,
        ),
      ),
  );
}
