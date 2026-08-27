// `profile` — perfil del contribuyente con domicilio propio + socios/representantes con opt-in
// explícito (ADR-041). Session-keyed: mismo criterio que `situacion` (ADR-035).
import { withSession } from '../auth/index.js';
import { recordAudit } from '../audit/index.js';
import { SituacionError } from '../errors/index.js';
import { readOperateState } from '../identity/index.js';
import { Rut } from '../rut/index.js';
import {
  fetchPerfilCompleto,
  type ActividadEconomica,
  type ConteosPerfil,
  type Direccion,
  type Representante,
  type Socio,
  type Timbraje,
} from '../portal/situacion.js';
import type { AuditEntry, Runtime } from '../seams/index.js';

export type { ActividadEconomica, ConteosPerfil, Direccion, Representante, Socio, Timbraje };

function audit(runtime: Runtime, action: string, result: string, extra: Partial<AuditEntry>): void {
  recordAudit(runtime, { action, result, ...extra });
}

async function assertSelfOperating(runtime: Runtime): Promise<void> {
  const op = await readOperateState(runtime.store);
  if (op && op.operatingRut !== op.selfRut) {
    throw new SituacionError(
      `El perfil es session-keyed: el SII responde por el titular de la sesión, no por el RUT ` +
        `operado (${Rut.parse(op.operatingRut).formatted}). Para el de esa empresa, inicia ` +
        'sesión como ella (`sii auth logout` y luego `sii auth login`).',
    );
  }
}

export interface ProfileResult {
  readonly rut: string;
  readonly razonSocial: string | null;
  readonly tipoContribuyente: string | null;
  readonly subtipoContribuyente: string | null;
  readonly segmento: string | null;
  readonly glosaActividad: string | null;
  readonly fechaConstitucion: string | null;
  readonly fechaInicioActividades: string | null;
  readonly fechaTerminoGiro: string | null;
  readonly actividades: readonly ActividadEconomica[];
  readonly timbrajes: readonly Timbraje[];
  /** Domicilio(s) del CONTRIBUYENTE mismo — siempre presente. `rutPropietario`/`dvPropietario`
   *  (el arrendador, un tercero) se redactan a `null` a menos que `incluyoTerceros` sea `true`. */
  readonly direcciones: readonly Direccion[];
  readonly conteos: ConteosPerfil;
  /** `true` cuando se pidió `incluirTerceros` — distingue "sin socios" de "no se pidieron". */
  readonly incluyoTerceros: boolean;
  /** `[]` a menos que `incluyoTerceros` sea `true` (ADR-041) — mismo criterio de opt-in que
   *  `notificaciones_detalle`/`peticiones_list`: el dato de terceros nunca sale por defecto. */
  readonly socios: readonly Socio[];
  readonly representantes: readonly Representante[];
}

/** Perfil del titular: identidad, actividades, timbrajes y domicilio propio SIEMPRE; socios y
 *  representantes (identidad de TERCEROS) solo con `incluirTerceros: true` (ADR-041). */
export async function profile(
  runtime: Runtime,
  args: { incluirTerceros?: boolean } = {},
): Promise<ProfileResult> {
  await assertSelfOperating(runtime);
  const incluyoTerceros = args.incluirTerceros === true;
  const start = runtime.clock.now().getTime();
  try {
    const result = await withSession(runtime, async (session, ctx) => {
      const rut = Rut.parse(ctx.sessionRut); // session-keyed: siempre el titular
      const perfil = await fetchPerfilCompleto(session);

      return {
        rut: rut.canonical,
        razonSocial: perfil.razonSocial,
        tipoContribuyente: perfil.tipoContribuyente,
        subtipoContribuyente: perfil.subtipoContribuyente,
        segmento: perfil.segmento,
        glosaActividad: perfil.glosaActividad,
        fechaConstitucion: perfil.fechaConstitucion,
        fechaInicioActividades: perfil.fechaInicioActividades,
        fechaTerminoGiro: perfil.fechaTerminoGiro,
        actividades: perfil.actividades,
        timbrajes: perfil.timbrajes,
        direcciones: perfil.direcciones.map((d) =>
          incluyoTerceros ? d : { ...d, rutPropietario: null, dvPropietario: null },
        ),
        conteos: perfil.conteos,
        incluyoTerceros,
        socios: incluyoTerceros ? perfil.socios : [],
        representantes: incluyoTerceros ? perfil.representantes : [],
      } satisfies ProfileResult;
    });

    // Recibo: rut + si se incluyeron terceros + cuántos. NUNCA su RUT ni nombre (ADR-006).
    audit(runtime, 'profile', 'ok', {
      rut: result.rut,
      incluyoTerceros,
      socios: result.socios.length,
      representantes: result.representantes.length,
      durationMs: runtime.clock.now().getTime() - start,
    });
    return result;
  } catch (e) {
    audit(runtime, 'profile', 'failed', {});
    throw e;
  }
}
