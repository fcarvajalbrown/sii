// `dte_acuse` MCP tool (ADR-036). Composición sobre RCV, solo lectura. Body-RUT (ADR-005).
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { dteAcuse, type Runtime } from '@dostertags/sii-core';
import { toolText } from '../tool-helpers.js';

export function registerAcuseTools(server: McpServer, runtime: Runtime): void {
  server.registerTool(
    'dte_acuse',
    {
      title: 'DTE recibidos — estado de acuse de recibo / reclamo',
      description:
        'Estado de acuse de los DTE RECIBIDOS en un período, agrupado por el evento que informa ' +
        'SII (observados: "A" = no reclamado en plazo, "C" = recibo otorgado, "P" = forma de ' +
        'pago contado), más los documentos SIN evento informado — esa es la lista accionable. ' +
        'IMPORTANTE: "diasDesdeRecepcion" es aritmética sobre la fecha de recepción del SII, NO ' +
        'un veredicto sobre el plazo del Art. 3 de la Ley 19.983: el disparador legal depende de ' +
        'la recepción de mercaderías/servicios, que el SII no expone, así que esta herramienta ' +
        'no adjudica plazos. SOLO LECTURA: nunca acepta ni reclama un documento. Acepta "rut" ' +
        'para leer una empresa representada (RCV es body-RUT).',
      inputSchema: { periodo: z.string(), rut: z.string().optional() },
      annotations: { readOnlyHint: true },
    },
    ({ periodo, rut }) =>
      toolText(async () =>
        JSON.stringify(
          await dteAcuse(runtime, { periodo, ...(rut !== undefined ? { rut } : {}) }),
          null,
          2,
        ),
      ),
  );
}
