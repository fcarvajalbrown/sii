// `monitor` MCP tool — the compliance sweep (ADR-024). Thin call into the task (ADR-003).
// NOT readOnly: it writes a baseline snapshot to local disk (identifiers/states only, never SII
// free text). zod input schema (ADR-011). SESSION-KEYED (ADR-005): no `rut` argument.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { monitorSweep, type Runtime } from '@dostertags/sii-core';
import { toolText } from '../tool-helpers.js';

export function registerMonitorTools(server: McpServer, runtime: Runtime): void {
  server.registerTool(
    'monitor',
    {
      title: 'Monitor de cumplimiento (barrido + diff)',
      description:
        'Barrido de cumplimiento tributario: revisa observaciones e historial del F22 (últimos ' +
        '`anios`, por defecto 3), meses sin declaración de F29 (últimos `meses`, por defecto 12) ' +
        'y las peticiones administrativas, y reporta QUÉ CAMBIÓ respecto de la corrida anterior. ' +
        'La PRIMERA corrida fija la línea base y no reporta cambios — pero sí reporta las ' +
        'deficiencias actuales (meses sin F29), que son estado, no cambio. Severidades: alta ' +
        '(observación nueva, evento nuevo del SII, mes sin declarar), media (petición cambió de ' +
        'estado), info (observación resuelta). Sobre MCP el default es dryRun=true (reporta sin ' +
        'mover la línea base); pasa dryRun=false explícitamente para avanzarla. ' +
        'base. GUARDA estado local (~/.sii/monitor.json) con sólo códigos, huellas y estados — ' +
        'nunca texto libre del SII. SESSION-KEYED: lee SIEMPRE el titular de la sesión. Expone ' +
        'datos tributarios del contribuyente.',
      inputSchema: {
        anios: z.number().int().positive().optional(),
        meses: z.number().int().positive().optional(),
        dryRun: z.boolean().optional(),
      },
      // Writes a local baseline file, so not readOnly — but it touches no SII state.
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    ({ anios, meses, dryRun }) =>
      toolText(async () =>
        JSON.stringify(
          await monitorSweep(runtime, {
            ...(anios !== undefined ? { anios } : {}),
            ...(meses !== undefined ? { meses } : {}),
            // INVERTED at the MCP boundary (the CLI keeps the advancing default, where a
            // human typed the command). Advancing the baseline is how the NEXT sweep decides
            // what counts as "new", so an injected `monitor` call with the default would
            // silently absorb whatever changed since the user last looked. Model-reachable
            // default must therefore be the non-mutating one.
            dryRun: dryRun !== false,
          }),
          null,
          2,
        ),
      ),
  );
}
