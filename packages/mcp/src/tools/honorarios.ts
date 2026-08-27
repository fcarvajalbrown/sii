// `honorarios` MCP tool — annual honorarios & retenciones reconciliation (ADR-023). Thin call
// into the composite task (ADR-003), read-only. zod input schema (ADR-011). SESSION-KEYED
// (ADR-005): no `rut` argument. The description states the two things a model must not get
// wrong: only the receptor side is reconciled, and the F22 códigos are surfaced, not adjudicated.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { honorariosAnual, type Runtime } from '@dostertags/sii-core';
import { toolText } from '../tool-helpers.js';

export function registerHonorariosTools(server: McpServer, runtime: Runtime): void {
  server.registerTool(
    'honorarios',
    {
      title: 'Cuadre anual de honorarios y retenciones',
      description:
        'Cuadre anual de honorarios: cruza la retención de las boletas de honorarios RECIBIDAS ' +
        'contra el código 151 del F29 (retención 10% Art. 42 Nº2 vía Art. 74 Nº2), mes a mes. ' +
        'El argumento es el AÑO COMERCIAL; el F22 leído es el del año tributario siguiente. ' +
        'IMPORTANTE: sólo se concilia `retencionReceptor` (la que retuvo el contribuyente); ' +
        '`retencionEmisor` se informa pero NO es declarable por él. Los códigos de honorarios ' +
        'del F22 (110/461/467/492/545 y 1412) se muestran para comparación y NO se les calcula ' +
        'diferencia: 1412 no está en la taxonomía observada y se entrega verbatim con ' +
        'enTaxonomia:false. Compara contra la PROPUESTA del F29, no el formulario presentado. ' +
        'SESSION-KEYED: lee SIEMPRE el titular de la sesión. Expone datos tributarios y RUT de ' +
        'contrapartes.',
      inputSchema: { anio: z.string(), refresh: z.boolean().optional() },
      annotations: { readOnlyHint: true },
    },
    ({ anio, refresh }) =>
      toolText(async () =>
        JSON.stringify(
          await honorariosAnual(runtime, { anio, ...(refresh !== undefined ? { refresh } : {}) }),
          null,
          2,
        ),
      ),
  );
}
