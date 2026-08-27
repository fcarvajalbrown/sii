// Public Notificaciones/Correspondencia task API the surfaces call (ADR-003 / ADR-032).
// Read-only. SESSION-KEYED (no represented-empresa reach observed live — same caution as
// F22/F29/BTE/BPST/DJ): reads the session principal only.
import { withSession } from '../auth/index.js';
import { recordAudit } from '../audit/index.js';
import { NotificacionesError } from '../errors/index.js';
import { readOperateState } from '../identity/index.js';
import { Rut } from '../rut/index.js';
import {
  fetchComunicacionDetalle,
  fetchComunicacionesList,
  type NotificacionCategoria,
  type NotificacionDetalle,
  type NotificacionesLista,
} from '../portal/notificaciones.js';
import type { AuditEntry, Runtime } from '../seams/index.js';

export type {
  NotificacionCategoria,
  NotificacionesLista,
  NotificacionItem,
  NotificacionDetalle,
  NotificacionAdjunto,
} from '../portal/notificaciones.js';

function audit(runtime: Runtime, action: string, result: string, extra: Partial<AuditEntry>): void {
  recordAudit(runtime, { action, result, ...extra });
}

/** Reject a representing operate pointer BEFORE opening a session (ADR-005 / ADR-032): no
 *  represented-empresa reach has been observed for this endpoint, so it stays self-only until a
 *  future spike proves otherwise, same caution as F22/F29/BTE/BPST/DJ. */
async function assertSelfOperating(runtime: Runtime): Promise<void> {
  const op = await readOperateState(runtime.store);
  if (op && op.operatingRut !== op.selfRut) {
    throw new NotificacionesError(
      `Notificaciones/Correspondencia es session-keyed: el SII autoriza por el titular de la ` +
        `sesión, no por el RUT operado (${Rut.parse(op.operatingRut).formatted}). Para las de esa ` +
        'empresa, inicia sesión como ella (`sii auth logout` y luego `sii auth login`).',
    );
  }
}

function parseCategoria(input: 'formal' | 'correspondencia' | undefined): NotificacionCategoria {
  return input === 'correspondencia' ? 'CORRESPONDENCIA' : 'FORMAL';
}

export interface NotificacionesListArgs {
  readonly categoria?: 'formal' | 'correspondencia';
}

/** List Notificaciones formales (default — "Mis Notificaciones Vigentes", the audit-relevant
 *  citación/liquidación/resolución channel) or Correspondencia (cartas/avisos/correos). */
export async function notificacionesList(
  runtime: Runtime,
  args: NotificacionesListArgs,
): Promise<NotificacionesLista> {
  const categoria = parseCategoria(args.categoria);
  await assertSelfOperating(runtime);
  const start = runtime.clock.now().getTime();
  try {
    const result = await withSession(runtime, async (session, ctx) => {
      const rut = Rut.parse(ctx.sessionRut); // session-keyed: always the principal
      return fetchComunicacionesList(session, { rut, categoria });
    });
    // Receipt: rut, categoria, count. NEVER a descripción/tipo value (ADR-006).
    audit(runtime, 'notificaciones_list', 'ok', {
      rut: result.rut,
      categoria: result.categoria,
      count: result.items.length,
      durationMs: runtime.clock.now().getTime() - start,
    });
    return result;
  } catch (e) {
    audit(runtime, 'notificaciones_list', 'failed', { categoria });
    throw e;
  }
}

export interface NotificacionesDetalleArgs {
  readonly categoria?: 'formal' | 'correspondencia';
  readonly id: number;
  readonly tipo: string;
}

/** Detail (asunto/from/to/bodyHtml/adjuntos) for one item, identified by `id` + `tipo` from a
 *  prior `notificacionesList` call. */
export async function notificacionesDetalle(
  runtime: Runtime,
  args: NotificacionesDetalleArgs,
): Promise<NotificacionDetalle> {
  const categoria = parseCategoria(args.categoria);
  await assertSelfOperating(runtime);
  const start = runtime.clock.now().getTime();
  try {
    const result = await withSession(runtime, async (session, ctx) => {
      const rut = Rut.parse(ctx.sessionRut); // session-keyed: always the principal
      return fetchComunicacionDetalle(session, { rut, categoria, id: args.id, tipo: args.tipo });
    });
    // Receipt: rut, id, categoria. NEVER asunto/from/to/bodyHtml (ADR-006) — the whole point of
    // this task is to read the letter's own content, none of which belongs in a receipt.
    audit(runtime, 'notificaciones_detalle', 'ok', {
      rut: result.rut,
      categoria: result.categoria,
      id: args.id,
      durationMs: runtime.clock.now().getTime() - start,
    });
    return result;
  } catch (e) {
    audit(runtime, 'notificaciones_detalle', 'failed', { categoria, id: args.id });
    throw e;
  }
}
