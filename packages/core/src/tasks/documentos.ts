// Public documentos task API the surfaces call (ADR-003 / ADR-042). PDF de cartas/notificaciones,
// keyed by `codCarta` (already exposed by `f22 historial`). SESSION-KEYED (same caution as the
// other `misiir.sii.cl`/`www3.sii.cl` legacy CGIs — no represented-empresa reach observed; no RUT
// travels in the request, only the session cookie).
import { withSession } from '../auth/index.js';
import { recordAudit } from '../audit/index.js';
import { DocumentoError } from '../errors/index.js';
import { readOperateState } from '../identity/index.js';
import { Rut } from '../rut/index.js';
import { fetchCartaPdf, type CartaPdf } from '../portal/documentos.js';
import type { AuditEntry, Runtime } from '../seams/index.js';

export type { CartaPdf } from '../portal/documentos.js';

function audit(runtime: Runtime, action: string, result: string, extra: Partial<AuditEntry>): void {
  recordAudit(runtime, { action, result, ...extra });
}

/** Reject a representing operate pointer BEFORE opening a session (ADR-005): no
 *  represented-empresa reach has been observed for this endpoint. */
async function assertSelfOperating(runtime: Runtime): Promise<void> {
  const op = await readOperateState(runtime.store);
  if (op && op.operatingRut !== op.selfRut) {
    throw new DocumentoError(
      `La descarga de PDF es session-keyed: el SII autoriza por el titular de la sesión, no por el ` +
        `RUT operado (${Rut.parse(op.operatingRut).formatted}). Para las de esa empresa, inicia ` +
        'sesión como ella (`sii auth logout` y luego `sii auth login`).',
    );
  }
}

export interface DescargarCartaPdfArgs {
  readonly codCarta: string;
}

/** Download the PDF of a carta/notificación by its `codCarta`. */
export async function descargarCartaPdf(
  runtime: Runtime,
  args: DescargarCartaPdfArgs,
): Promise<CartaPdf> {
  await assertSelfOperating(runtime);
  const start = runtime.clock.now().getTime();
  let sessionRut = '';
  try {
    const result = await withSession(runtime, async (session, ctx) => {
      sessionRut = ctx.sessionRut;
      return fetchCartaPdf(session, { codCarta: args.codCarta });
    });
    // Receipt: rut, codCarta, byte SIZE — NEVER the PDF content (ADR-006 / ADR-042).
    audit(runtime, 'descargar_carta_pdf', 'ok', {
      rut: sessionRut,
      codCarta: result.codCarta,
      bytes: result.bytes.length,
      durationMs: runtime.clock.now().getTime() - start,
    });
    return result;
  } catch (e) {
    audit(runtime, 'descargar_carta_pdf', 'failed', { codCarta: args.codCarta });
    throw e;
  }
}
