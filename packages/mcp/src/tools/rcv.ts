// `rcv_*` MCP tools — Registro de Compras y Ventas. Thin calls into @dostertags/sii-core tasks
// (ADR-003), read-only. Body-RUT (ADR-005): `rut` selects a represented empresa.
// zod input schemas (ADR-011) — the SDK derives the protocol JSON Schema.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  rcvList,
  rcvListAll,
  rcvSummary,
  type RcvSide,
  type Runtime,
} from '@dostertags/sii-core';
import { toolText } from '../tool-helpers.js';

const sideOf = (venta?: boolean): RcvSide => (venta ? 'VENTA' : 'COMPRA');
// exactOptionalPropertyTypes: only carry `rut` when the override was passed.
const rutOpt = (rut?: string): { rut?: string } => (rut ? { rut } : {});

export function registerRcvTools(server: McpServer, runtime: Runtime): void {
  server.registerTool(
    'rcv_summary',
    {
      title: 'RCV resumen',
      description:
        'Resumen del Registro de Compras y Ventas por tipo de documento, para un período (YYYYMM/YYYY-MM). ' +
        'COMPRAS por defecto; venta=true para VENTAS. Body-RUT: usa rut para una empresa representada.',
      inputSchema: {
        periodo: z.string(),
        venta: z.boolean().optional(),
        rut: z.string().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    ({ periodo, venta, rut }) =>
      toolText(async () =>
        JSON.stringify(
          await rcvSummary(runtime, { periodo, side: sideOf(venta), ...rutOpt(rut) }),
          null,
          2,
        ),
      ),
  );

  server.registerTool(
    'rcv_list',
    {
      title: 'RCV detalle',
      description:
        'Detalle de documentos de un tipo (codigoTipoDoc, ej. "33") del RCV para un período. ' +
        'COMPRAS por defecto; venta=true para VENTAS. Body-RUT: usa rut para una empresa representada. ' +
        'raw=true agrega la fila COMPLETA sin curar (~50 campos con datos de terceros); por defecto ' +
        'va apagado y devuelve solo los campos curados (ADR-028).',
      inputSchema: {
        periodo: z.string(),
        codigoTipoDoc: z.string(),
        venta: z.boolean().optional(),
        rut: z.string().optional(),
        raw: z.boolean().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    ({ periodo, codigoTipoDoc, venta, rut, raw }) =>
      toolText(async () =>
        JSON.stringify(
          await rcvList(runtime, {
            periodo,
            side: sideOf(venta),
            codigoTipoDoc,
            ...rutOpt(rut),
            ...(raw !== undefined ? { raw } : {}),
          }),
          null,
          2,
        ),
      ),
  );

  server.registerTool(
    'rcv_all',
    {
      title: 'RCV detalle — todos los tipos',
      description:
        'Detalle de TODOS los documentos de un período (YYYYMM/YYYY-MM) en una sola consulta: ' +
        'aplana el detalle de cada tipo que reporta el resumen, cada fila con su codigoTipoDoc. ' +
        'COMPRAS por defecto; venta=true para VENTAS. Body-RUT: usa rut para una empresa representada. ' +
        'Si SII rechaza un tipo puntual, incomplete=true y rejectedTypes lista los códigos omitidos (el resto igual vuelve). ' +
        'raw=true agrega la fila COMPLETA sin curar de cada documento: son ~50 campos por fila con ' +
        'DATOS DE TERCEROS (identificación de la contraparte) multiplicados por todos los tipos del ' +
        'período. Pídelo solo si necesitas un campo tributario especial (activo fijo, IVA uso común, ' +
        'Ley 18211); por defecto va apagado.',
      inputSchema: {
        periodo: z.string(),
        venta: z.boolean().optional(),
        rut: z.string().optional(),
        raw: z.boolean().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    ({ periodo, venta, rut, raw }) =>
      toolText(async () =>
        JSON.stringify(
          await rcvListAll(runtime, {
            periodo,
            side: sideOf(venta),
            ...rutOpt(rut),
            ...(raw !== undefined ? { raw } : {}),
          }),
          null,
          2,
        ),
      ),
  );
}
