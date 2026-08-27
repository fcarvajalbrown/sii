// `notificaciones_*` MCP tools — Notificaciones formales / Correspondencia (ADR-032). Thin calls
// into @dostertags/sii-core tasks (ADR-003), read-only. zod input schemas (ADR-011).
// SESSION-KEYED: reads the session principal; no `rut` argument.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { notificacionesDetalle, notificacionesList, type Runtime } from '@dostertags/sii-core';
import { toolText } from '../tool-helpers.js';

const categoriaSchema = z.enum(['formal', 'correspondencia']).optional();

export function registerNotificacionesTools(server: McpServer, runtime: Runtime): void {
  server.registerTool(
    'notificaciones_list',
    {
      title: 'Notificaciones / Correspondencia — listado',
      description:
        'Lista las Notificaciones formales del titular ("Mis Notificaciones Vigentes": ' +
        'citaciones, liquidaciones, resoluciones — el canal para confirmar si existe una ' +
        'citación Art. 63 vigente o reciente) o, con categoria="correspondencia", cartas y ' +
        'avisos informales que el SII ha enviado. SESSION-KEYED: lee SIEMPRE el titular de la ' +
        'sesión (no acepta otro RUT).',
      inputSchema: { categoria: categoriaSchema },
      annotations: { readOnlyHint: true },
    },
    ({ categoria }) =>
      toolText(async () =>
        JSON.stringify(
          await notificacionesList(runtime, categoria !== undefined ? { categoria } : {}),
          null,
          2,
        ),
      ),
  );

  server.registerTool(
    'notificaciones_detalle',
    {
      title: 'Notificaciones / Correspondencia — detalle',
      description:
        'Contenido de una Notificación/Correspondencia — asunto, remitente/destinatario, y el ' +
        'cuerpo de la carta (HTML) tal como SII lo envió. Expone la identidad propia del ' +
        'titular incrustada en la carta (razón social, correo de contacto) — misma exposición ' +
        'que whoami, nunca datos de un tercero. Usa el "id" y "tipo" que entrega ' +
        'notificaciones_list. SESSION-KEYED.',
      inputSchema: {
        id: z.number().int(),
        tipo: z.string(),
        categoria: categoriaSchema,
      },
      annotations: { readOnlyHint: true },
    },
    ({ id, tipo, categoria }) =>
      toolText(async () =>
        JSON.stringify(
          await notificacionesDetalle(runtime, {
            id,
            tipo,
            ...(categoria !== undefined ? { categoria } : {}),
          }),
          null,
          2,
        ),
      ),
  );
}
