// `profile` MCP tool (ADR-041). Llamada fina a un task de @dostertags/sii-core (ADR-003),
// solo lectura. SESSION-KEYED.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { profile, type Runtime } from '@dostertags/sii-core';
import { toolText } from '../tool-helpers.js';

export function registerProfileTools(server: McpServer, runtime: Runtime): void {
  server.registerTool(
    'profile',
    {
      title: 'Perfil del titular',
      description:
        'Perfil del titular: identidad, actividades económicas, timbrajes y domicilio propio. ' +
        'incluirTerceros=true agrega socios y representantes (RUT, nombre, % de participación) ' +
        'y el RUT del arrendador del domicilio — son datos de TERCEROS (PII), expuestos SOLO ' +
        'con ese opt-in explícito; sin él, solo se informa cuántos hay. SESSION-KEYED: lee ' +
        'SIEMPRE el titular de la sesión (no acepta otro RUT).',
      inputSchema: { incluirTerceros: z.boolean().optional() },
      annotations: { readOnlyHint: true },
    },
    ({ incluirTerceros }) =>
      toolText(async () =>
        JSON.stringify(
          await profile(runtime, incluirTerceros !== undefined ? { incluirTerceros } : {}),
          null,
          2,
        ),
      ),
  );
}
