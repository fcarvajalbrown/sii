// `bancario_resumen` MCP tool (ADR-039). Llamada fina a un task de @dostertags/sii-core
// (ADR-003), solo lectura. SESSION-KEYED, sin argumentos.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { bancarioInforme, type Runtime } from '@dostertags/sii-core';
import { toolText } from '../tool-helpers.js';

export function registerBancarioTools(server: McpServer, runtime: Runtime): void {
  server.registerTool(
    'bancario_resumen',
    {
      title: 'Informe bancario del titular (abonos por semestre)',
      description:
        'Informe bancario del titular: cantidad y MONTO TOTAL de abonos recibidos, agrupado por ' +
        'semestre, banco y tipo de cuenta. Es el insumo del cruce de fiscalización que compara ' +
        'depósitos bancarios contra ventas declaradas — expone montos agregados propios (no de ' +
        'terceros), no transacciones individuales. SESSION-KEYED: lee SIEMPRE el titular de la ' +
        'sesión (no acepta otro RUT).',
      annotations: { readOnlyHint: true },
    },
    () => toolText(async () => JSON.stringify(await bancarioInforme(runtime), null, 2)),
  );
}
