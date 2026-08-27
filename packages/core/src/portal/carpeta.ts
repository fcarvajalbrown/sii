// Carpeta Tributaria Regular — historial of "carpeta tributaria" credit-application dossiers the
// taxpayer has generated (ADR-033). Full contract: docs/sii-contract/carpeta-tributaria.md.
//
// A plain REST JSON API on `www2.sii.cl`, RUT embedded in the URL path — the SAME wire-shape
// family as `dj.ts` (ADR-030): a direct GET returns a bare HTTP 401 unless the caller FIRST
// navigates to the UI page and paces before the request. Response here is SIMPLER than DJ's:
// a BARE JSON ARRAY, no `{estado,...}`/`{data,...}` wrapper — no business-error envelope has
// been observed live for this endpoint.
//
// READ-ONLY BY DESIGN: this facade reads the HISTORIAL of already-issued dossiers. It does NOT
// generate a new one ("Generar Carpeta Tributaria Regular") or annul an existing one ("Anular")
// — both are write actions on the same SII product, explicitly out of scope (ADR-033 / the hard
// "solo lectura" rule for this spike).
import { z } from 'zod';
import { HOSTS, LOGIN_HOST } from '../config/index.js';
import { CarpetaTributariaError, NotAuthenticatedError, RateLimitError, SessionExpiredError } from '../errors/index.js';
import type { Rut } from '../rut/index.js';
import type { PortalSession } from '../seams/index.js';

const HEADERS: Record<string, string> = { Accept: 'application/json' };

/** The dossier's declared composition — WHICH sections were included when it was generated
 *  (representante legal, sucursales, boletas, …) and, for some, a period window in months.
 *  Parsed from `carpParametros`, a JSON-ENCODED STRING on the wire (ADR-033). Only observed for
 *  `carpTipo: 1` ("Solicitar Credito") — the key set for other tipos is unconfirmed, so this is
 *  a tolerant bag of unknown booleans/numbers, not a closed shape. */
export type CarpetaTributariaParametros = Readonly<Record<string, boolean | number | string | null>>;

/** One issued Carpeta Tributaria Regular. `receptorNombre`/`receptorRut`/`receptorDv` are the
 *  DECLARED RECIPIENT of the dossier — the taxpayer itself when self-addressed, or a THIRD
 *  PARTY (observed live: a named bank contact person, own RUT) when addressed to an
 *  institution's representative. Surfaced verbatim, not dropped (ADR-033) — knowing who has a
 *  copy of your own tax dossier is exactly the audit value of this facade — but this is a real
 *  third-party PII exposure, declared explicitly at every surface (same posture as
 *  `peticiones_list`). `estado`/`tipo` pass through as SII's own numeric codes, no closed enum
 *  (only `estado` 1 and 3 observed live; no authoritative label for either was found — do not
 *  assume 1="Vigente"/3="No Vigente" beyond what the UI showed for THIS capture). */
export interface CarpetaTributariaItem {
  readonly codigoRepositorio: number | null;
  readonly claveCarpeta: string | null;
  readonly codigoBarras: string | null;
  readonly fechaGeneracion: string | null;
  readonly fechaVencimiento: string | null;
  readonly fechaAnulacion: string | null;
  readonly nombreArchivo: string | null;
  readonly estado: number | null;
  readonly tipo: number | null;
  readonly institucionCodigo: string | null;
  readonly institucionDescripcion: string | null;
  readonly institucionAbreviacion: string | null;
  readonly otraInstitucion: string | null;
  readonly nombreOtraInstitucion: string | null;
  readonly receptorNombre: string | null;
  readonly receptorRut: string | null;
  readonly receptorDv: string | null;
  readonly comentario: string | null;
  readonly codigoXml: number | null;
  readonly unidadFuncionario: string | null;
  readonly rutFuncionario: number | null;
  readonly dvFuncionario: string | null;
  readonly inicioVigencia: string | null;
  readonly ultimaModificacionVigencia: string | null;
  readonly finVigencia: string | null;
  readonly revisionesCantidad: number | null;
  readonly revisionesFechaUltima: string | null;
  readonly parametros: CarpetaTributariaParametros | null;
}

export interface CarpetaTributariaHistorial {
  readonly rut: string;
  /** The `agno` filter sent, or `null` for every año (the default — the full historial). */
  readonly anio: string | null;
  readonly items: readonly CarpetaTributariaItem[];
}

const asStr = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
};
const asNumber = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

function parseParametros(raw: unknown): CarpetaTributariaParametros | null {
  if (typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    const out: Record<string, boolean | number | string | null> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'boolean' || typeof v === 'number' || typeof v === 'string' || v === null) {
        out[k] = v;
      }
    }
    return out;
  } catch {
    return null;
  }
}

const CarpetaSchema = z
  .object({
    carpCodigoRepositorio: z.unknown().optional(),
    carpClaveCarpeta: z.unknown().optional(),
    carpCodigoBarras: z.unknown().optional(),
    carpFechaGeneracion: z.unknown().optional(),
    carpFechaVencimiento: z.unknown().optional(),
    carpFechaAnulacion: z.unknown().optional(),
    carpNombreArchivo: z.unknown().optional(),
    carpEstado: z.unknown().optional(),
    carpTipo: z.unknown().optional(),
    enfinCodigo: z.unknown().optional(),
    carpOtraInstitucion: z.unknown().optional(),
    carpNombreOtraInstitucion: z.unknown().optional(),
    carpNombreReceptor: z.unknown().optional(),
    carpRutReceptor: z.unknown().optional(),
    carpDvReceptor: z.unknown().optional(),
    carpComentario: z.unknown().optional(),
    carpCodigoXml: z.unknown().optional(),
    carpUnidadFuncionario: z.unknown().optional(),
    carpRutFuncionario: z.unknown().optional(),
    carpDvFuncionario: z.unknown().optional(),
    carpParametros: z.unknown().optional(),
    dlInicioVigencia: z.unknown().optional(),
    dlUltimaModificacionVigencia: z.unknown().optional(),
    dlFinVigencia: z.unknown().optional(),
  })
  .loose();
const RowSchema = z
  .object({
    carpetaTributaria: CarpetaSchema.nullish(),
    enfinDescripcion: z.unknown().optional(),
    enfinAbreviacion: z.unknown().optional(),
    revCantidad: z.unknown().optional(),
    revFechaUltimaRevision: z.unknown().optional(),
  })
  .loose();
const ListSchema = z.array(RowSchema);

function projectRow(r: z.infer<typeof RowSchema>): CarpetaTributariaItem {
  const c = r.carpetaTributaria ?? {};
  return {
    codigoRepositorio: asNumber(c.carpCodigoRepositorio),
    claveCarpeta: asStr(c.carpClaveCarpeta),
    codigoBarras: asStr(c.carpCodigoBarras),
    fechaGeneracion: asStr(c.carpFechaGeneracion),
    fechaVencimiento: asStr(c.carpFechaVencimiento),
    fechaAnulacion: asStr(c.carpFechaAnulacion),
    nombreArchivo: asStr(c.carpNombreArchivo),
    estado: asNumber(c.carpEstado),
    tipo: asNumber(c.carpTipo),
    institucionCodigo: asStr(c.enfinCodigo),
    institucionDescripcion: asStr(r.enfinDescripcion),
    institucionAbreviacion: asStr(r.enfinAbreviacion),
    otraInstitucion: asStr(c.carpOtraInstitucion),
    nombreOtraInstitucion: asStr(c.carpNombreOtraInstitucion),
    receptorNombre: asStr(c.carpNombreReceptor),
    receptorRut: asStr(c.carpRutReceptor),
    receptorDv: asStr(c.carpDvReceptor),
    comentario: asStr(c.carpComentario),
    codigoXml: asNumber(c.carpCodigoXml),
    unidadFuncionario: asStr(c.carpUnidadFuncionario),
    rutFuncionario: asNumber(c.carpRutFuncionario),
    dvFuncionario: asStr(c.carpDvFuncionario),
    inicioVigencia: asStr(c.dlInicioVigencia),
    ultimaModificacionVigencia: asStr(c.dlUltimaModificacionVigencia),
    finVigencia: asStr(c.dlFinVigencia),
    revisionesCantidad: asNumber(r.revCantidad),
    revisionesFechaUltima: asStr(r.revFechaUltimaRevision),
    parametros: parseParametros(c.carpParametros),
  };
}

/** Bootstrap (`goto` the UI page + `pace()`) then GET — the SAME precondition DJ needs
 *  (ADR-030/ADR-033): a direct GET, even with a fresh session, returns a bare HTTP 401. */
async function bootstrapAndGet(
  session: PortalSession,
  url: string,
  pace: () => Promise<void>,
): Promise<unknown> {
  const landed = await session.goto(HOSTS.carpetaTributariaUi);
  if (new URL(landed).hostname === LOGIN_HOST) {
    throw new SessionExpiredError('La sesión expiró. Ejecuta `sii auth login`.');
  }
  await pace();
  try {
    return await session.requestJson(url, { method: 'GET', headers: HEADERS });
  } catch (e) {
    // Session death and a server-side block are both actionable — never rewrapped (ADR-004).
    if (e instanceof NotAuthenticatedError || e instanceof RateLimitError) throw e;
    throw new CarpetaTributariaError(
      'Respuesta inesperada de SII (no es JSON) al consultar el historial de carpetas tributarias.',
    );
  }
}

/** `buscar`: the historial of Carpetas Tributarias Regulares this taxpayer has GENERATED —
 *  READ ONLY (never `generarcteregular`/`anular`). No `anio` = every año (the response is a bare
 *  array; empty = no carpetas ever issued, a legitimate result, not an error). */
export async function fetchCarpetaTributariaHistorial(
  session: PortalSession,
  params: { rut: Rut; anio?: string },
  pace: () => Promise<void>,
): Promise<CarpetaTributariaHistorial> {
  const { rut, anio } = params;
  const url = anio
    ? `${HOSTS.carpetaTributariaApi}/${rut.canonical}/recurso/v2/carpeta-tributaria/buscar?agno=${encodeURIComponent(anio)}`
    : `${HOSTS.carpetaTributariaApi}/${rut.canonical}/recurso/v2/carpeta-tributaria/buscar`;
  const raw = await bootstrapAndGet(session, url, pace);
  const parsed = ListSchema.safeParse(raw);
  if (!parsed.success) {
    throw new CarpetaTributariaError(
      'Respuesta inesperada de SII (formato no reconocido) al consultar el historial de carpetas tributarias.',
    );
  }
  return {
    rut: rut.canonical,
    anio: anio ?? null,
    items: parsed.data.map(projectRow),
  };
}
