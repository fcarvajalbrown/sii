// API pública de situación tributaria (ADR-003 / ADR-035). Compone TRES consultas del mismo CGI
// de Mi SII en UNA sola sesión, paceadas: cumplimiento Ley COT (opc=118), régimen vigente
// (opc=22) y perfil del contribuyente (opc=112).
//
// SESSION-KEYED: `CViewCarta.cgi` responde siempre por el titular de la sesión, sin parámetro de
// RUT — igual que `notificaciones` (ADR-032).
import { withSession } from '../auth/index.js';
import { recordAudit } from '../audit/index.js';
import { DEFAULT_SETTINGS } from '../config/index.js';
import { SituacionError } from '../errors/index.js';
import { readOperateState } from '../identity/index.js';
import { Rut } from '../rut/index.js';
import {
  fetchCumplimientoCot,
  fetchPerfilContribuyente,
  fetchRegimenes,
  type CumplimientoCot,
  type PerfilContribuyente,
  type RegimenTributario,
} from '../portal/situacion.js';
import type { AuditEntry, Runtime } from '../seams/index.js';

export type {
  CumplimientoCot,
  RequisitoCot,
  RegimenTributario,
  PerfilContribuyente,
  ActividadEconomica,
  Timbraje,
  ConteosPerfil,
} from '../portal/situacion.js';

const pacingMs = (): number => Math.round(1000 / DEFAULT_SETTINGS.rateLimitRps);

function audit(runtime: Runtime, action: string, result: string, extra: Partial<AuditEntry>): void {
  recordAudit(runtime, { action, result, ...extra });
}

async function assertSelfOperating(runtime: Runtime): Promise<void> {
  const op = await readOperateState(runtime.store);
  if (op && op.operatingRut !== op.selfRut) {
    throw new SituacionError(
      `La situación tributaria es session-keyed: el SII responde por el titular de la sesión, no ` +
        `por el RUT operado (${Rut.parse(op.operatingRut).formatted}). Para la de esa empresa, ` +
        'inicia sesión como ella (`sii auth logout` y luego `sii auth login`).',
    );
  }
}

export interface SituacionResult {
  readonly rut: string;
  readonly perfil: PerfilContribuyente;
  readonly cumplimiento: CumplimientoCot;
  readonly regimenes: readonly RegimenTributario[];
  /** Requisitos de la Ley COT con `cumple === false`, para no obligar a filtrar a mano. */
  readonly requisitosIncumplidos: readonly string[];
}

/** Situación tributaria del titular: en qué régimen está, desde cuándo existe, qué actividades
 *  declara, qué documentos tiene timbrados, y si cumple las obligaciones de la Ley COT. */
export async function situacionTributaria(runtime: Runtime): Promise<SituacionResult> {
  await assertSelfOperating(runtime);
  const start = runtime.clock.now().getTime();
  try {
    const result = await withSession(runtime, async (session, ctx) => {
      const rut = Rut.parse(ctx.sessionRut); // session-keyed: siempre el titular
      const pace = (): Promise<void> => runtime.clock.sleep(pacingMs());

      const perfil = await fetchPerfilContribuyente(session);
      await pace();
      const cumplimiento = await fetchCumplimientoCot(session);
      await pace();
      const regimenes = await fetchRegimenes(session);

      const requisitosIncumplidos = cumplimiento.requisitos
        .filter((r) => r.cumple === false)
        .map((r) => r.titulo ?? r.codigo ?? '')
        .filter((s) => s !== '');

      return { rut: rut.canonical, perfil, cumplimiento, regimenes, requisitosIncumplidos };
    });

    // Recibo: rut + si cumple + cuántos regímenes. NUNCA razón social, actividades ni fechas
    // (ADR-006) — el recibo registra que se leyó, no lo leído.
    audit(runtime, 'situacion_tributaria', 'ok', {
      rut: result.rut,
      incumplidos: result.requisitosIncumplidos.length,
      durationMs: runtime.clock.now().getTime() - start,
    });
    return result;
  } catch (e) {
    audit(runtime, 'situacion_tributaria', 'failed', {});
    throw e;
  }
}
