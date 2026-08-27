// `carpeta_tributaria_historial` MCP tool — Carpeta Tributaria Regular (ADR-033). Thin call into
// @dostertags/sii-core tasks (ADR-003), read-only. SESSION-KEYED: reads the session
// principal; no `rut` argument. READ ONLY: never generates or annuls a dossier.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { carpetaTributariaHistorial, type Runtime } from '@dostertags/sii-core';
import { toolText } from '../tool-helpers.js';

export function registerCarpetaTools(server: McpServer, runtime: Runtime): void {
  server.registerTool(
    'carpeta_tributaria_historial',
    {
      title: 'Carpeta Tributaria Regular — historial',
      description:
        'Historial de Carpetas Tributarias Regulares (dossieres de crédito) que el titular ha ' +
        'generado — todos los años por defecto, o uno con "anio". Cada ítem incluye el ' +
        'destinatario declarado del dossier (nombre/RUT), que puede ser un TERCERO (ej. un ' +
        'contacto bancario), no siempre el propio titular — esta herramienta expone esa ' +
        'identidad de terceros. SOLO LECTURA: nunca genera ni anula una carpeta. SESSION-KEYED: ' +
        'lee SIEMPRE el titular de la sesión (no acepta otro RUT).',
      inputSchema: { anio: z.string().optional() },
      annotations: { readOnlyHint: true },
    },
    ({ anio }) =>
      toolText(async () =>
        JSON.stringify(
          await carpetaTributariaHistorial(runtime, anio !== undefined ? { anio } : {}),
          null,
          2,
        ),
      ),
  );
}
