// Situación tributaria — cumplimiento Ley COT, régimen vigente y perfil del contribuyente
// (ADR-035). Contrato completo: docs/sii-contract/situacion.md.
//
// Va sobre el MISMO CGI que `notificaciones.ts` (Mi SII `CViewCarta.cgi`, ADR-032) pero con
// otros `opc`. HALLAZGO ESTRUCTURAL: ese CGI **no tiene un envelope común** — es un despachador
// donde CADA `opc` responde con su propia forma. Observadas en vivo 2026-08-04:
//   opc=118 → { estado, atributos[], semestreActual, historicos, mostrarObligacionTributaria }
//   opc=22  → { codigoError, descripcionError, sysdate, atributos[] }
//   opc=112 → { codigoError, descripcionError, sysdate, contribuyente{}, actEcos[], … }
//   opc=29  → { data{}, metaData }         (y NO son "Alertas": son reportes de destino de
//                                           impuestos — la etiqueta del MISII_OPC_MAP miente)
//   opc=8   → cuerpo VACÍO (no es la fuente de situación tributaria pese a su nombre)
// Por eso hay tres funciones con tres esquemas, no una con uno.
//
// PII (ADR-006 / ADR-035): `opc=112` devuelve socios, representantes y direcciones — RUT y
// nombres de TERCEROS, y el RUT del propietario del inmueble. Esta fachada NO los expone; solo
// informa CUÁNTOS hay. Tampoco expone email/teléfono propios (eso es territorio de `whoami`,
// que declara su exposición explícitamente).
import { z } from 'zod';
import { HOSTS } from '../config/index.js';
import { SituacionError } from '../errors/index.js';
import type { PortalSession } from '../seams/index.js';

const post = async (session: PortalSession, opc: string, accion: string): Promise<unknown> => {
  const res = await session.requestForm(HOSTS.notificacionesCgi, {
    method: 'POST',
    form: { opc, VIEW: '1' },
  });
  try {
    return JSON.parse(res.body) as unknown;
  } catch {
    throw new SituacionError(`Respuesta inesperada de SII (no es JSON) al ${accion}.`);
  }
};

const asStr = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
};
const asNum = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// SII sirve su propio texto con ligaduras de un tipo de letra en el Área de Uso Privado Unicode:
// "tiempo" llega como "\u{10019F}empo" y "artículo" como "ar\u{1001A1}culo" (observado 2026-08-04
// en opc=118). Es corrupción de SII, no información: se normalizan SOLO los dos puntos de código
// OBSERVADOS. Cualquier otro carácter PUA pasa intacto — no se adivina (ADR-004).
const LIGADURAS_PUA: ReadonlyArray<readonly [string, string]> = [
  ['\u{10019F}', 'ti'],
  ['\u{1001A1}', 'tí'],
];
function normalizaLigaduras(s: string | null): string | null {
  if (s === null) return null;
  let out = s;
  for (const [pua, real] of LIGADURAS_PUA) out = out.split(pua).join(real);
  return out;
}

/** `SI`/`NO` observados; cualquier otro valor NO se coerce a booleano (ADR-004). */
function siNo(v: unknown): boolean | null {
  const s = asStr(v)?.toUpperCase();
  if (s === 'SI' || s === 'S') return true;
  if (s === 'NO' || s === 'N') return false;
  return null;
}

// --- opc=118 — cumplimiento de obligaciones tributarias (Ley COT) ------------------------------

/** Un requisito de la Ley COT. `codigo` observados: `NDIR`, `DQDT`, `ATPJ` — sin enum cerrado. */
export interface RequisitoCot {
  readonly codigo: string | null;
  readonly titulo: string | null;
  /** `true`/`false` para los `SI`/`NO` observados; `null` para un valor no observado. */
  readonly cumple: boolean | null;
  /** El valor verbatim de SII, por si aparece uno distinto de SI/NO. */
  readonly cumpleTexto: string | null;
  readonly condicion: string | null;
  /** Texto de SII con las ligaduras PUA normalizadas (ver arriba). */
  readonly descripcion: string | null;
}

export interface CumplimientoCot {
  /** Verbatim, ej. `"Cumple sus obligaciones tributarias"`. Sin enum cerrado. */
  readonly estado: string | null;
  readonly semestre: string | null;
  readonly requisitos: readonly RequisitoCot[];
}

const CotSchema = z
  .object({
    estado: z.unknown().optional(),
    semestreActual: z.unknown().optional(),
    atributos: z
      .array(
        z
          .object({
            atrCodigo: z.unknown().optional(),
            titulo: z.unknown().optional(),
            cumple: z.unknown().optional(),
            condicion: z.unknown().optional(),
            descripcion: z.unknown().optional(),
          })
          .loose(),
      )
      .nullish(),
  })
  .loose();

export async function fetchCumplimientoCot(session: PortalSession): Promise<CumplimientoCot> {
  const raw = await post(session, '118', 'consultar el cumplimiento de obligaciones tributarias');
  const parsed = CotSchema.safeParse(raw);
  if (!parsed.success) {
    throw new SituacionError(
      'Respuesta inesperada de SII (formato no reconocido) al consultar el cumplimiento de obligaciones tributarias.',
    );
  }
  return {
    estado: asStr(parsed.data.estado),
    semestre: asStr(parsed.data.semestreActual),
    requisitos: (parsed.data.atributos ?? []).map((a) => ({
      codigo: asStr(a.atrCodigo),
      titulo: normalizaLigaduras(asStr(a.titulo)),
      cumple: siNo(a.cumple),
      cumpleTexto: asStr(a.cumple),
      condicion: asStr(a.condicion),
      descripcion: normalizaLigaduras(asStr(a.descripcion)),
    })),
  };
}

// --- opc=22 — régimen tributario vigente --------------------------------------------------------

/** Un atributo de régimen. Observado en vivo: `M14A` = "REGIMEN GENERAL SEMI INTEGRADO (14A)". */
export interface RegimenTributario {
  readonly codigo: string | null;
  readonly descripcion: string | null;
  readonly fechaInicio: string | null;
  readonly fechaTermino: string | null;
  /** El campo `valor` de SII: por qué aplica (ej. tramo de ingresos). */
  readonly detalle: string | null;
}

const RegimenSchema = z
  .object({
    atributos: z
      .array(
        z
          .object({
            atrCodigo: z.unknown().optional(),
            descAtrCodigo: z.unknown().optional(),
            fechaInicio: z.unknown().optional(),
            fechaTermino: z.unknown().optional(),
            valor: z.unknown().optional(),
          })
          .loose(),
      )
      .nullish(),
  })
  .loose();

export async function fetchRegimenes(session: PortalSession): Promise<readonly RegimenTributario[]> {
  const raw = await post(session, '22', 'consultar el régimen tributario');
  const parsed = RegimenSchema.safeParse(raw);
  if (!parsed.success) {
    throw new SituacionError(
      'Respuesta inesperada de SII (formato no reconocido) al consultar el régimen tributario.',
    );
  }
  // `usuarioActivacion`/`usuarioDesactivacion` traen el id del FUNCIONARIO SII que hizo el
  // cambio — PII interna, se descarta como en `peticiones.ts` (ADR-006).
  return (parsed.data.atributos ?? []).map((a) => ({
    codigo: asStr(a.atrCodigo),
    descripcion: asStr(a.descAtrCodigo),
    fechaInicio: asStr(a.fechaInicio),
    fechaTermino: asStr(a.fechaTermino),
    detalle: asStr(a.valor),
  }));
}

// --- opc=112 — perfil del contribuyente ---------------------------------------------------------

export interface ActividadEconomica {
  readonly codigo: string | null;
  readonly descripcion: string | null;
  readonly categoriaTributaria: number | null;
  readonly afectoIva: boolean | null;
  readonly fechaInicio: string | null;
}

export interface Timbraje {
  readonly codigo: string | null;
  readonly descripcion: string | null;
  readonly fechaLegalizacion: string | null;
}

/** Cuántos socios / representantes / direcciones tiene el contribuyente, SIN identificarlos:
 *  saber que existen es útil; sus RUT y nombres son PII de terceros (ADR-035). */
export interface ConteosPerfil {
  readonly socios: number;
  readonly representantes: number;
  readonly direcciones: number;
}

export interface PerfilContribuyente {
  readonly razonSocial: string | null;
  readonly tipoContribuyente: string | null;
  readonly subtipoContribuyente: string | null;
  readonly segmento: string | null;
  readonly glosaActividad: string | null;
  readonly fechaConstitucion: string | null;
  /** **El dato que `monitor.ts` no tenía** (ADR-035). Verbatim de SII, con el sufijo horario que
   *  SII incluye (`"2019-06-19 00:00:00.0"`) — ojo: `actEcos.fechaInicio` usa OTRO formato
   *  (`"19-06-2019"`). Ambos se pasan tal cual; el consumidor decide cómo parsear. */
  readonly fechaInicioActividades: string | null;
  readonly fechaTerminoGiro: string | null;
  /** Define si el plazo mensual de F29 es el día 12 o el 20 (declarante electrónico). Observado
   *  en vivo (ADR-035/037); `null` cuando SII no lo informa — nunca se asume un valor. */
  readonly autorizadoDeclararDia20: boolean | null;
  readonly actividades: readonly ActividadEconomica[];
  readonly timbrajes: readonly Timbraje[];
  readonly conteos: ConteosPerfil;
}

const PerfilSchema = z
  .object({
    contribuyente: z
      .object({
        razonSocial: z.unknown().optional(),
        tipoContribuyenteDescripcion: z.unknown().optional(),
        subtipoContribuyenteDescrip: z.unknown().optional(),
        segmentoDescripcion: z.unknown().optional(),
        glosaActividad: z.unknown().optional(),
        fechaConstitucion: z.unknown().optional(),
        fechaInicioActividades: z.unknown().optional(),
        fechaTerminoGiro: z.unknown().optional(),
        autorizadoDeclararDia20: z.unknown().optional(),
      })
      .loose()
      .nullish(),
    actEcos: z.array(z.looseObject({})).nullish(),
    timbrajes: z.array(z.looseObject({})).nullish(),
    socios: z.array(z.unknown()).nullish(),
    representantes: z.array(z.unknown()).nullish(),
    direcciones: z.array(z.unknown()).nullish(),
  })
  .loose();

// --- opc=112 — perfil COMPLETO: socios/representantes/direcciones (ADR-041) ---------------------
//
// `fetchPerfilContribuyente` (arriba) es la superficie de `situacion` — deliberadamente reduce
// estos tres bloques a un conteo (ADR-035). Esto NO cambia ese contrato: es una función NUEVA,
// misma petición `opc=112`, para la superficie `profile` (ADR-041), que SÍ los cura — el opt-in
// para socios/representantes vive en la TAREA (`tasks/profile.ts`), no aquí.

export interface Socio {
  readonly rut: string | null;
  readonly dv: string | null;
  /** `razonSocial` si el socio es una empresa; si es persona, `nombres + apellidos`. */
  readonly nombre: string | null;
  readonly participacionCapital: number | null;
  readonly participacionUtilidades: number | null;
  readonly fechaIncorporacion: string | null;
  readonly fechaFinParticipacion: string | null;
  readonly vigente: boolean | null;
}

export interface Representante {
  readonly rut: string | null;
  readonly dv: string | null;
  readonly nombre: string | null;
  readonly fechaInicio: string | null;
  readonly fechaTermino: string | null;
  readonly vigente: boolean | null;
}

/** Domicilio del CONTRIBUYENTE mismo (no de terceros) — `rutPropietario`/`dvPropietario` son la
 *  ÚNICA identidad de tercero en esta forma (el arrendador); se exponen como campos separados
 *  para que el consumidor (la tarea) decida si los incluye según el opt-in (ADR-041). */
export interface Direccion {
  readonly calle: string | null;
  readonly comuna: string | null;
  readonly region: string | null;
  readonly tipoDomicilio: string | null;
  readonly tipoPropiedad: string | null;
  readonly telefono: string | null;
  readonly rutPropietario: string | null;
  readonly dvPropietario: string | null;
}

export interface PerfilCompleto extends PerfilContribuyente {
  readonly socios: readonly Socio[];
  readonly representantes: readonly Representante[];
  readonly direcciones: readonly Direccion[];
}

const nombreDe = (o: Record<string, unknown>): string | null => {
  const razonSocial = asStr(o['razonSocial']);
  if (razonSocial) return razonSocial;
  const partes = [o['nombres'], o['apellidoPaterno'], o['apellidoMaterno']]
    .map((v) => asStr(v))
    .filter((v): v is string => v !== null);
  return partes.length > 0 ? partes.join(' ') : null;
};

export async function fetchPerfilCompleto(session: PortalSession): Promise<PerfilCompleto> {
  const raw = await post(session, '112', 'consultar el perfil del contribuyente');
  const parsed = PerfilSchema.safeParse(raw);
  if (!parsed.success) {
    throw new SituacionError(
      'Respuesta inesperada de SII (formato no reconocido) al consultar el perfil del contribuyente.',
    );
  }
  const base = projectPerfilContribuyente(parsed.data);
  const rec = (o: unknown): Record<string, unknown> =>
    typeof o === 'object' && o !== null ? (o as Record<string, unknown>) : {};

  return {
    ...base,
    socios: (parsed.data.socios ?? []).map((x) => {
      const s = rec(x);
      return {
        rut: asStr(s['rut']),
        dv: asStr(s['dv']),
        nombre: nombreDe(s),
        participacionCapital: asNum(s['participacionCapital']),
        participacionUtilidades: asNum(s['participacionUtilidades']),
        fechaIncorporacion: asStr(s['fechaIncorporacion']),
        fechaFinParticipacion: asStr(s['fechaFinParticipacion']),
        vigente: siNo(s['vigente']),
      } satisfies Socio;
    }),
    representantes: (parsed.data.representantes ?? []).map((x) => {
      const r = rec(x);
      return {
        rut: asStr(r['rut']),
        dv: asStr(r['dv']),
        nombre: nombreDe(r),
        fechaInicio: asStr(r['fechaInicio']),
        fechaTermino: asStr(r['fechaTermino']),
        vigente: siNo(r['vigente']),
      } satisfies Representante;
    }),
    direcciones: (parsed.data.direcciones ?? []).map((x) => {
      const d = rec(x);
      return {
        calle: asStr(d['calle']),
        comuna: asStr(d['comunaDescripcion']),
        region: asStr(d['regionDescripcion']),
        tipoDomicilio: asStr(d['tipoDomicilioDescripcion']),
        tipoPropiedad: asStr(d['tipoPropiedadDescripcion']),
        telefono: asStr(d['telefono']),
        rutPropietario: asStr(d['rutPropietario']),
        dvPropietario: asStr(d['dvPropietario']),
      } satisfies Direccion;
    }),
  };
}

function projectPerfilContribuyente(parsed: z.infer<typeof PerfilSchema>): PerfilContribuyente {
  const c = parsed.contribuyente ?? {};
  const rec = (o: unknown): Record<string, unknown> =>
    typeof o === 'object' && o !== null ? (o as Record<string, unknown>) : {};

  return {
    razonSocial: asStr(c.razonSocial),
    tipoContribuyente: asStr(c.tipoContribuyenteDescripcion),
    subtipoContribuyente: asStr(c.subtipoContribuyenteDescrip),
    segmento: asStr(c.segmentoDescripcion),
    glosaActividad: asStr(c.glosaActividad),
    fechaConstitucion: asStr(c.fechaConstitucion),
    fechaInicioActividades: asStr(c.fechaInicioActividades),
    fechaTerminoGiro: asStr(c.fechaTerminoGiro),
    autorizadoDeclararDia20: siNo(c.autorizadoDeclararDia20),
    actividades: (parsed.actEcos ?? []).map((x) => {
      const a = rec(x);
      return {
        codigo: asStr(a['codigo']),
        descripcion: asStr(a['descripcion']),
        categoriaTributaria: asNum(a['categoriaTributaria']),
        afectoIva: siNo(a['afectoIva']),
        fechaInicio: asStr(a['fechaInicio']),
      } satisfies ActividadEconomica;
    }),
    timbrajes: (parsed.timbrajes ?? []).map((x) => {
      const t = rec(x);
      return {
        codigo: asStr(t['codigo']),
        descripcion: asStr(t['descripcion']),
        fechaLegalizacion: asStr(t['fechaLegalizacion']),
      } satisfies Timbraje;
    }),
    // Solo el CONTEO: los RUT/nombres de socios, representantes y del propietario del
    // domicilio son PII de terceros y no salen de aquí (ADR-035).
    conteos: {
      socios: (parsed.socios ?? []).length,
      representantes: (parsed.representantes ?? []).length,
      direcciones: (parsed.direcciones ?? []).length,
    },
  };
}

export async function fetchPerfilContribuyente(
  session: PortalSession,
): Promise<PerfilContribuyente> {
  const raw = await post(session, '112', 'consultar el perfil del contribuyente');
  const parsed = PerfilSchema.safeParse(raw);
  if (!parsed.success) {
    throw new SituacionError(
      'Respuesta inesperada de SII (formato no reconocido) al consultar el perfil del contribuyente.',
    );
  }
  return projectPerfilContribuyente(parsed.data);
}
