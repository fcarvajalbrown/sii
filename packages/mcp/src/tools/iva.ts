// `iva` MCP tool — the monthly VAT reconciliation (ADR-022). Thin call into the `ivaMensual`
// composite task (ADR-003), read-only. zod input schema (ADR-011). SESSION-KEYED (ADR-005):
// reads the session principal, so no `rut` argument.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ivaMensual, type Runtime } from '@dostertags/sii-core';
import { toolText } from '../tool-helpers.js';

export function registerIvaTools(server: McpServer, runtime: Runtime): void {
  server.registerTool(
    'iva',
    {
      title: 'Cuadre de IVA mensual',
      description:
        'Cuadre de IVA de un período (YYYYMM/YYYY-MM): cruza el IVA del RCV — débito de las ' +
        'ventas, crédito de las compras — contra los totales del F29 (código 538 TOTAL DÉBITOS, ' +
        '537 TOTAL CRÉDITOS) y devuelve la diferencia por lado más el desglose por tipo de ' +
        'documento para ubicarla. IMPORTANTE: compara contra la PROPUESTA del SII, no contra el ' +
        'formulario presentado. `cuadra` tiene TRES estados: true (coinciden), false (diferencia ' +
        'real) y null (INDETERMINADO: la propuesta no trae cifra comparable — observado en vivo, ' +
        'la propuesta suele traer los códigos componentes 511/562 y no los totales 538/537). ' +
        'null NO significa que los libros estén mal; significa que no hay con qué comparar, así ' +
        'que NO lo reportes como un descuadre. `debitoCodigo`/`creditoCodigo` dicen qué código se ' +
        'comparó. Un período sin propuesta devuelve valores null (no es un error). ' +
        'SESSION-KEYED: lee SIEMPRE el titular de la sesión; para el IVA de una empresa ' +
        'representada, inicia sesión como ella.',
      inputSchema: { periodo: z.string(), refresh: z.boolean().optional() },
      annotations: { readOnlyHint: true },
    },
    ({ periodo, refresh }) =>
      toolText(async () =>
        JSON.stringify(
          await ivaMensual(runtime, {
            periodo,
            ...(refresh !== undefined ? { refresh } : {}),
          }),
          null,
          2,
        ),
      ),
  );
}
