// `bte_*` MCP tools — Boletas de Honorarios Electrónicas. Thin calls into @dostertags/sii-core tasks
// (ADR-003), read-only. zod input schemas (ADR-011). SESSION-KEYED (ADR-005): reads the
// session principal; no `rut` argument.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  bteEmit,
  bteEmitPreview,
  bteList,
  type BteEmitArgs,
  type BteRetiene,
  type BteSide,
  type Runtime,
} from '@dostertags/sii-core';
import { toolText } from '../tool-helpers.js';

const sideOf = (recibidas?: boolean): BteSide => (recibidas ? 'RECIBIDAS' : 'EMITIDAS');

// Shared emit input fields (zod raw shape). The emisor fields are read from the live form; the
// caller supplies only receptor + líneas + fecha + who-withholds.
const emitFields = {
  receptor: z.string(),
  nombre: z.string(),
  domicilio: z.string(),
  region: z.number().int(),
  comuna: z.number().int(),
  lineas: z
    .array(z.object({ glosa: z.string(), monto: z.number().int().positive() }))
    .min(1)
    .max(4),
  fecha: z
    .object({ dia: z.number().int(), mes: z.number().int(), anio: z.number().int() })
    .optional(),
  retiene: z.enum(['receptor', 'emisor']),
  mostrarDetalle: z.boolean().optional(),
};

type EmitInput = {
  receptor: string;
  nombre: string;
  domicilio: string;
  region: number;
  comuna: number;
  lineas: { glosa: string; monto: number }[];
  fecha?: { dia: number; mes: number; anio: number } | undefined;
  retiene: 'receptor' | 'emisor';
  mostrarDetalle?: boolean | undefined;
};

const toArgs = (i: EmitInput): BteEmitArgs => ({
  receptor: i.receptor,
  receptorNombre: i.nombre,
  receptorDomicilio: i.domicilio,
  region: i.region,
  comuna: i.comuna,
  lineas: i.lineas,
  retiene: (i.retiene === 'emisor' ? 'EMISOR' : 'RECEPTOR') as BteRetiene,
  ...(i.fecha ? { fecha: i.fecha } : {}),
  ...(i.mostrarDetalle !== undefined ? { mostrarDetalle: i.mostrarDetalle } : {}),
});

export function registerBteTools(
  server: McpServer,
  runtime: Runtime,
  /** ADR-026: when false (the DEFAULT) `bte_emit` is not registered at all — it does not appear
   *  in listTools, so no injected instruction can reach a tool that is absent. This is the
   *  primary control; the preview-bound nonce below hardens the path for operators who opt in. */
  allowWrites = false,
): void {
  server.registerTool(
    'bte_list',
    {
      title: 'BHE/BTE — boletas de honorarios',
      description:
        'Lista las boletas de honorarios electrónicas de un período (YYYYMM/YYYY-MM), donde el ' +
        'titular de la sesión es el PROFESIONAL que emite su PROPIA boleta. EMITIDAS por defecto; ' +
        'recibidas=true para las RECIBIDAS. SESSION-KEYED: lee SIEMPRE el titular de la sesión (no ' +
        'acepta otro RUT; para las BHE de una empresa, inicia sesión como ella). ' +
        'SI ESTO DEVUELVE 0 BOLETAS para una empresa que efectivamente emite boletas de honorarios: ' +
        'prueba `bpst_list` en su lugar — es un producto SII DISTINTO (aunque el propio portal SII ' +
        'llama "BTE" a ambos) para cuando la empresa emite la boleta A NOMBRE DE un tercero ' +
        '(modalidad "Emisor de Boleta de Honorarios de Terceros").',
      inputSchema: { periodo: z.string(), recibidas: z.boolean().optional() },
      annotations: { readOnlyHint: true },
    },
    ({ periodo, recibidas }) =>
      toolText(async () =>
        JSON.stringify(await bteList(runtime, { periodo, side: sideOf(recibidas) }), null, 2),
      ),
  );

  // --- emit preview (does NOT issue) — safe to call freely ---
  server.registerTool(
    'bte_emit_preview',
    {
      title: 'BHE — vista previa de emisión (NO emite)',
      description:
        'Calcula una boleta de honorarios (total, retención de PPM y líquido) SIN EMITIRLA. Usa ' +
        'esto para cotizar/preparar antes de emitir. Recibe: receptor (RUT), nombre, domicilio, ' +
        'region+comuna (códigos SII), lineas [{glosa, monto bruto}] (1–4), retiene ' +
        '("receptor"|"emisor"), fecha opcional. SESSION-KEYED: emite como el titular de la sesión.',
      inputSchema: emitFields,
      annotations: { readOnlyHint: true },
    },
    (input) =>
      toolText(async () => JSON.stringify(await bteEmitPreview(runtime, toArgs(input)), null, 2)),
  );

  // --- emit (ISSUES a legally-binding boleta) — OPT-IN ONLY (ADR-026) ---
  // Not registered unless the operator set SII_MCP_ALLOW_WRITES=1. An argument-shaped gate cannot
  // secure an LLM-callable destructive tool, because the caller authors every argument; the only
  // robust control is for the tool to be absent. ADR-017's confirmar+amount echo compared the
  // model's arithmetic against the model's own input and is replaced here.
  if (!allowWrites) return;

  server.registerTool(
    'bte_emit',
    {
      title: 'BHE — EMITIR boleta de honorarios (acto legal)',
      description:
        'EMITE una boleta de honorarios electrónica: un DOCUMENTO CON VALOR LEGAL, reportado al SII ' +
        'y que solo se revierte con una anulación posterior. FLUJO OBLIGATORIO: (1) llama a ' +
        'bte_emit_preview con los MISMOS datos, (2) MUÉSTRALE al usuario el total/retención/líquido ' +
        'y ESPERA su aprobación explícita, (3) emite pasando en `confirmacion` el valor que ' +
        'devolvió la vista previa. Esa confirmación es de un solo uso, expira en 10 minutos y está ' +
        'ligada a ESTA boleta exacta: si cambias monto, receptor, fecha o retención, deja de ser ' +
        'válida y debes volver a la vista previa. Devuelve el código de barras (folio) + el PDF. ' +
        'NO envía correos: el envío por email solo existe en la CLI. SESSION-KEYED.',
      inputSchema: {
        ...emitFields,
        // The ONLY confirmation. Server-minted by the preview, so the caller cannot author it —
        // unlike the removed `confirmar`/`montoTotalConfirmacion` pair.
        confirmacion: z.string().min(1),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    (input) =>
      toolText(async () => {
        // `enviarA`/`copiaEmisor` are deliberately absent: mailing the issued PDF to an
        // arbitrary address is a data-exfiltration primitive distinct from — and worse than —
        // the issuance itself. It stays CLI-only, where a human typed the address (ADR-026).
        const args: BteEmitArgs = { ...toArgs(input), confirmacion: input.confirmacion };
        return JSON.stringify(await bteEmit(runtime, args), null, 2);
      }),
  );
}
