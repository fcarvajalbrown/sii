// Public Carpeta Tributaria Regular task API the surfaces call (ADR-003 / ADR-033). Read-only —
// the historial of already-issued dossiers, never `generar`/`anular`. SESSION-KEYED (same
// caution as F22/F29/BTE/BPST/DJ/notificaciones — no represented-empresa reach observed).
import { withSession } from '../auth/index.js';
import { recordAudit } from '../audit/index.js';
import { CarpetaTributariaError } from '../errors/index.js';
import { readOperateState } from '../identity/index.js';
import { DEFAULT_SETTINGS } from '../config/index.js';
import { Rut } from '../rut/index.js';
import { fetchCarpetaTributariaHistorial, type CarpetaTributariaHistorial } from '../portal/carpeta.js';
import type { AuditEntry, Runtime } from '../seams/index.js';

export type {
  CarpetaTributariaHistorial,
  CarpetaTributariaItem,
  CarpetaTributariaParametros,
} from '../portal/carpeta.js';

const pacingMs = (): number => Math.round(1000 / DEFAULT_SETTINGS.rateLimitRps);

function audit(runtime: Runtime, action: string, result: string, extra: Partial<AuditEntry>): void {
  recordAudit(runtime, { action, result, ...extra });
}

/** Reject a representing operate pointer BEFORE opening a session (ADR-005 / ADR-033): no
 *  represented-empresa reach has been observed for this endpoint. */
async function assertSelfOperating(runtime: Runtime): Promise<void> {
  const op = await readOperateState(runtime.store);
  if (op && op.operatingRut !== op.selfRut) {
    throw new CarpetaTributariaError(
      `Carpeta Tributaria es session-keyed: el SII autoriza por el titular de la sesión, no por el ` +
        `RUT operado (${Rut.parse(op.operatingRut).formatted}). Para las de esa empresa, inicia ` +
        'sesión como ella (`sii auth logout` y luego `sii auth login`).',
    );
  }
}

export interface CarpetaTributariaArgs {
  readonly anio?: string;
}

/** Historial of Carpetas Tributarias Regulares (credit-application dossiers) this taxpayer has
 *  GENERATED — every año by default, or one año with `anio`. READ ONLY: never generates a new
 *  dossier or annuls an existing one. */
export async function carpetaTributariaHistorial(
  runtime: Runtime,
  args: CarpetaTributariaArgs,
): Promise<CarpetaTributariaHistorial> {
  await assertSelfOperating(runtime);
  const start = runtime.clock.now().getTime();
  try {
    const result = await withSession(runtime, async (session, ctx) => {
      const rut = Rut.parse(ctx.sessionRut); // session-keyed: always the principal
      const pace = (): Promise<void> => runtime.clock.sleep(pacingMs());
      return fetchCarpetaTributariaHistorial(session, { rut, ...(args.anio ? { anio: args.anio } : {}) }, pace);
    });
    // Receipt: rut, anio filter, count. NEVER a claveCarpeta/receptor value (ADR-006).
    audit(runtime, 'carpeta_tributaria_historial', 'ok', {
      rut: result.rut,
      anio: result.anio ?? 'todos',
      count: result.items.length,
      durationMs: runtime.clock.now().getTime() - start,
    });
    return result;
  } catch (e) {
    audit(runtime, 'carpeta_tributaria_historial', 'failed', { anio: args.anio ?? 'todos' });
    throw e;
  }
}
