// `bancario` — informe de abonos por semestre (ADR-039). Session-keyed: `CViewCarta.cgi`
// responde siempre por el titular de la sesión, sin parámetro de RUT — igual que `situacion`
// (ADR-035) y `notificaciones` (ADR-032).
import { withSession } from '../auth/index.js';
import { recordAudit } from '../audit/index.js';
import { BancarioError } from '../errors/index.js';
import { readOperateState } from '../identity/index.js';
import { Rut } from '../rut/index.js';
import { fetchInformeBancario, type InformeBancarioSemestre } from '../portal/bancario.js';
import type { AuditEntry, Runtime } from '../seams/index.js';

export type { InformeBancarioSemestre } from '../portal/bancario.js';

function audit(runtime: Runtime, action: string, result: string, extra: Partial<AuditEntry>): void {
  recordAudit(runtime, { action, result, ...extra });
}

async function assertSelfOperating(runtime: Runtime): Promise<void> {
  const op = await readOperateState(runtime.store);
  if (op && op.operatingRut !== op.selfRut) {
    throw new BancarioError(
      `El informe bancario es session-keyed: el SII responde por el titular de la sesión, no por ` +
        `el RUT operado (${Rut.parse(op.operatingRut).formatted}). Para el de esa empresa, inicia ` +
        'sesión como ella (`sii auth logout` y luego `sii auth login`).',
    );
  }
}

export interface BancarioInformeResult {
  readonly rut: string;
  readonly semestres: readonly InformeBancarioSemestre[];
}

/** Informe bancario del titular: abonos por semestre, banco y tipo de cuenta — el insumo del
 *  cruce de fiscalización que compara depósitos bancarios contra ventas declaradas (ADR-039). */
export async function bancarioInforme(runtime: Runtime): Promise<BancarioInformeResult> {
  await assertSelfOperating(runtime);
  const start = runtime.clock.now().getTime();
  try {
    const result = await withSession(runtime, async (session, ctx) => {
      const rut = Rut.parse(ctx.sessionRut); // session-keyed: siempre el titular
      const semestres = await fetchInformeBancario(session);
      return { rut: rut.canonical, semestres };
    });

    // Recibo: rut + cuántos semestres. NUNCA un monto ni un banco (ADR-006/ADR-024) — el recibo
    // registra que se leyó, no lo leído.
    audit(runtime, 'bancario_informe', 'ok', {
      rut: result.rut,
      semestres: result.semestres.length,
      durationMs: runtime.clock.now().getTime() - start,
    });
    return result;
  } catch (e) {
    audit(runtime, 'bancario_informe', 'failed', {});
    throw e;
  }
}
