// `bpst_*` MCP tools — Boleta de Prestación de Servicios de Terceros Electrónica (ADR-029).
// Thin calls into @dostertags/sii-core tasks (ADR-003), read-only. zod input schemas
// (ADR-011). SESSION-KEYED (ADR-005): reads the session principal; no `rut` argument.
//
// NAMING: distinct from `bte_*` (standard Boletas de Honorarios Electrónicas) despite SII's OWN
// UI calling THIS product "BTE" — see ADR-029's naming-collision note.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { bpstList, type BpstSide, type Runtime } from '@dostertags/sii-core';
import { toolText } from '../tool-helpers.js';

const sideOf = (recibidas?: boolean): BpstSide => (recibidas ? 'RECIBIDAS' : 'EMITIDAS');

export function registerBpstTools(server: McpServer, runtime: Runtime): void {
  server.registerTool(
    'bpst_list',
    {
      title: 'BPST — boleta de prestación de servicios de terceros',
      description:
        'Lista las boletas de prestación de servicios de terceros (BPST) de un período ' +
        '(YYYYMM/YYYY-MM) — boletas que la empresa emite A NOMBRE de trabajadores que no operan ' +
        'el portal SII por sí mismos (mano de obra poco calificada: agrícola, bodega, reparto), es ' +
        'decir la modalidad "Emisor de Boleta de Honorarios de Terceros". ESTA ES LA HERRAMIENTA ' +
        'CORRECTA cuando `bte_list` devuelve 0 boletas para una empresa que sí emite boletas de ' +
        'honorarios: son dos productos SII DISTINTOS aunque el propio portal SII llama "BTE" a ' +
        'ambos (ver ADR-029). EMITIDAS por defecto (el caso de uso principal); recibidas=true para ' +
        'las RECIBIDAS. SESSION-KEYED: lee SIEMPRE el titular de la sesión (no acepta otro RUT; ' +
        'para las BPST de una empresa, inicia sesión como ella).',
      inputSchema: { periodo: z.string(), recibidas: z.boolean().optional() },
      annotations: { readOnlyHint: true },
    },
    ({ periodo, recibidas }) =>
      toolText(async () =>
        JSON.stringify(await bpstList(runtime, { periodo, side: sideOf(recibidas) }), null, 2),
      ),
  );
}
