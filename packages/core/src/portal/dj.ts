// DJ — Estado de Declaraciones Juradas (ADR-030). First observation of this SII product in this
// codebase: a SIXTH wire shape, distinct from SDI-JSON (RCV/F22/F29), inline-JS-map (BTE/BHE),
// form-POST→HTML (BPST), GWT-RPC (peticiones) and public HTML (DTE authorized). Full contract:
// docs/sii-contract/dj-status.md.
//
// A plain REST JSON API on `www2.sii.cl`, the subject RUT embedded in the URL path — but NOT the
// SDI envelope family (no `respEstado`, no `facadeAdapterService` namespace). Reached via the
// EXISTING `PortalSession.requestJson` seam; no new primitive needed.
import { z } from 'zod';
import { HOSTS, LOGIN_HOST } from '../config/index.js';
import { DjError, NotAuthenticatedError, RateLimitError, SessionExpiredError } from '../errors/index.js';
import type { Anio } from '../periodo/index.js';
import type { Rut } from '../rut/index.js';
import type { PortalSession } from '../seams/index.js';

// The UI page this REST API backs — observed 2026-08-03. Sending the actual page as Referer
// (not just the bare `sii.cl` origin) is REQUIRED live: without it the backend answers with a
// non-JSON response instead of the expected envelope (confirmed live, ADR-030).
const DJ_CONSULTA_PAGE = 'https://www2.sii.cl/djconsulta/consultaddjjs';

const HEADERS: Record<string, string> = {
  'Content-Type': 'application/json',
  Accept: 'application/json',
  Referer: DJ_CONSULTA_PAGE,
};

/** One DJ (form family) row: which DJ number, its SII title, and its estado per año tributario.
 *  `estados` omits any año the taxpayer had no obligation/filing for (ABSENCE, never `null`/`0` —
 *  same posture as every other facade in this codebase). Values pass through verbatim: only
 *  `"Aceptada"`/`"Observada"` observed live (docs/sii-contract/dj-status.md) — NOT a closed enum. */
export interface DjEstadoRow {
  readonly id: number | null;
  readonly dj: number | null;
  readonly titulo: string | null;
  readonly estados: Readonly<Record<string, string>>;
}

/** One `getDjIntegralAnual` call's result — covers a ROLLING 3-YEAR WINDOW ending at `periodo`,
 *  not a single año (the load-bearing trap this facade exists to get right). */
export interface DjEstadoAnual {
  readonly rut: string;
  /** The END año tributario of the 3-year window queried (what was sent, not what came back). */
  readonly periodo: string;
  readonly rows: readonly DjEstadoRow[];
}

// --- Wire envelope (zod-at-the-boundary, ADR-011) ---------------------------------------------
// Two DISTINCT failure shapes observed live (docs/sii-contract/dj-status.md): the business
// "out of range" error uses `errorMsg` (`data: null`); the malformed-request-body error uses a
// DIFFERENT field, `error`. Both are handled; anything else is an unrecognized envelope.
const RowSchema = z
  .object({
    id: z.unknown().optional(),
    dj: z.unknown().optional(),
    titulo: z.unknown().optional(),
    estados: z.record(z.string(), z.unknown()).optional(),
  })
  .loose();
const Envelope = z
  .object({
    data: z.array(RowSchema).nullish(),
    errorMsg: z.string().nullish(),
    error: z.string().nullish(),
  })
  .loose();

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

function projectRow(r: z.infer<typeof RowSchema>): DjEstadoRow {
  const estados: Record<string, string> = {};
  if (r.estados) {
    for (const [year, val] of Object.entries(r.estados)) {
      if (typeof val === 'string') estados[year] = val;
    }
  }
  return { id: asNumber(r.id), dj: asNumber(r.dj), titulo: asStr(r.titulo), estados };
}

/** Bootstrap (`goto` the UI page + `pace()`) then POST — the precondition EVERY endpoint in this
 *  family shares (ADR-030): a direct POST, even with a fresh session and the correct Referer,
 *  returns a bare HTTP 401. The `www2.sii.cl` djconsulta SPA does its OWN async session bootstrap
 *  on load (observed: it pings `www2.sii.cl/app/session/status`) that the REST API depends on; a
 *  `goto` alone is not enough — the bootstrap is asynchronous, so a brief pace AFTER the goto and
 *  BEFORE the POST is required too (confirmed live: 0ms fails every time, 500ms succeeds
 *  consistently; this facade paces at the project standard, 1000ms, for margin). */
async function bootstrapAndPost(
  session: PortalSession,
  url: string,
  body: Record<string, unknown>,
  pace: () => Promise<void>,
): Promise<unknown> {
  const landed = await session.goto(DJ_CONSULTA_PAGE);
  if (new URL(landed).hostname === LOGIN_HOST) {
    throw new SessionExpiredError('La sesión expiró. Ejecuta `sii auth login`.');
  }
  await pace();
  try {
    return await session.requestJson(url, { method: 'POST', headers: HEADERS, body });
  } catch (e) {
    // Session death and a server-side block are both actionable — never rewrapped (ADR-004).
    if (e instanceof NotAuthenticatedError || e instanceof RateLimitError) throw e;
    throw new DjError('Respuesta inesperada de SII (no es JSON) al consultar declaraciones juradas.');
  }
}

/** `errorMsg` (business error) or `error` (malformed request) — the two DISTINCT failure field
 *  names observed across this whole endpoint family (docs/sii-contract/dj-status.md /
 *  dj-detalle.md). Returns the verbatim message to raise, or null when the envelope is clean. */
function envelopeError(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o['error'] === 'string' && o['error']) return o['error'];
  if (typeof o['errorMsg'] === 'string' && o['errorMsg']) return o['errorMsg'];
  return null;
}

const hasKnownEnvelopeKey = (raw: unknown, keys: readonly string[]): boolean =>
  typeof raw === 'object' && raw !== null && keys.some((k) => k in raw);

/** One `getDjIntegralAnual` call: the DJ estado for the 3-year window ending at `periodo`
 *  (año tributario). Raises `DjError` verbatim for any SII-side failure — including the
 *  documented "out of range" shape; the CALLER (task layer) decides whether an out-of-range
 *  result at the edge of a multi-year sweep is a soft stop or a real problem (ADR-030). */
export async function fetchDjEstadoAnual(
  session: PortalSession,
  params: { rut: Rut; periodo: Anio },
  pace: () => Promise<void>,
): Promise<DjEstadoAnual> {
  const { rut, periodo } = params;
  const url = `${HOSTS.djConsulta}/${rut.canonical}/recurso/v1/dj/getDjIntegralAnual`;
  // THE WIRE TRAP (ADR-030): `periodo` MUST be a JSON STRING here. A bare number, an array, or
  // any other key name (`anio`, `periodoAnual`) all failed live with a generic "formato del
  // cuerpo" error — silently and without a hint at the real cause.
  const raw = await bootstrapAndPost(session, url, { periodo: periodo.canonical }, pace);
  if (!hasKnownEnvelopeKey(raw, ['data', 'errorMsg', 'error'])) {
    throw new DjError(
      'Respuesta inesperada de SII (formato no reconocido) al consultar declaraciones juradas.',
    );
  }
  const err = envelopeError(raw);
  if (err) throw new DjError(err);
  const parsed = Envelope.safeParse(raw);
  const rows = parsed.success ? (parsed.data.data ?? []).map(projectRow) : [];
  return { rut: rut.canonical, periodo: periodo.canonical, rows };
}

// --- Endpoint 2 (ADR-031): getDjIntegralAnualDetalle — presentation history per DJ -------------

/** One presented/anulada/rectificatoria instance of a DJ for one año. `key` is what
 *  `fetchDjDetalle` needs (distinct from the DJ-family-level `id` when a rectificatoria exists —
 *  docs/sii-contract/dj-detalle.md). `estado`/`codEstado` pass through verbatim, no closed enum. */
export interface DjHistorialItem {
  readonly key: number | null;
  readonly codEstado: number | null;
  readonly estado: string | null;
  readonly fecha: string | null;
  readonly mes: number | null;
  readonly mesNombre: string | null;
  readonly folio: number | null;
  readonly medioPresentacion: string | null;
  readonly tipoDeclaracion: string | null;
  readonly casos: number | null;
}

export interface DjHistorialRow {
  readonly id: number | null;
  readonly dj: number | null;
  readonly titulo: string | null;
  readonly presentaciones: readonly DjHistorialItem[];
}

export interface DjHistorialAnual {
  readonly rut: string;
  readonly periodo: string;
  readonly rows: readonly DjHistorialRow[];
}

const HistorialItemSchema = z
  .object({
    key: z.unknown().optional(),
    codEstado: z.unknown().optional(),
    estado: z.unknown().optional(),
    fecha: z.unknown().optional(),
    mes: z.unknown().optional(),
    mesNombre: z.unknown().optional(),
    folio: z.unknown().optional(),
    medioPresentacion: z.unknown().optional(),
    tipoDeclaracion: z.unknown().optional(),
    casos: z.unknown().optional(),
  })
  .loose();
const HistorialRowSchema = z
  .object({
    id: z.unknown().optional(),
    dj: z.unknown().optional(),
    titulo: z.unknown().optional(),
    result: z.array(HistorialItemSchema).optional(),
  })
  .loose();
const HistorialEnvelope = z
  .object({ data: z.array(HistorialRowSchema).nullish(), errorMsg: z.string().nullish() })
  .loose();

function projectHistorialItem(r: z.infer<typeof HistorialItemSchema>): DjHistorialItem {
  return {
    key: asNumber(r.key),
    codEstado: asNumber(r.codEstado),
    estado: asStr(r.estado),
    fecha: asStr(r.fecha),
    mes: asNumber(r.mes),
    mesNombre: asStr(r.mesNombre),
    folio: asNumber(r.folio),
    medioPresentacion: asStr(r.medioPresentacion),
    tipoDeclaracion: asStr(r.tipoDeclaracion),
    casos: asNumber(r.casos),
  };
}

/** `getDjIntegralAnualDetalle`: presentation history (folio/key/estado/tipoDeclaracion) per DJ
 *  for one año — INCLUDING anuladas/superseded folios (a rectificatoria trail). `key` from a row
 *  here is what `fetchDjDetalle` needs. `periodo` here is a BARE NUMBER — the OPPOSITE convention
 *  from `fetchDjEstadoAnual`'s string requirement (ADR-031; confirmed live by capturing the SPA's
 *  own real request). */
export async function fetchDjHistorialAnual(
  session: PortalSession,
  params: { rut: Rut; periodo: Anio },
  pace: () => Promise<void>,
): Promise<DjHistorialAnual> {
  const { rut, periodo } = params;
  const url = `${HOSTS.djConsulta}/${rut.canonical}/recurso/v1/dj/getDjIntegralAnualDetalle`;
  const raw = await bootstrapAndPost(session, url, { periodo: periodo.value }, pace);
  if (!hasKnownEnvelopeKey(raw, ['data', 'errorMsg', 'error'])) {
    throw new DjError(
      'Respuesta inesperada de SII (formato no reconocido) al consultar el historial de declaraciones juradas.',
    );
  }
  const err = envelopeError(raw);
  if (err) throw new DjError(err);
  const parsed = HistorialEnvelope.safeParse(raw);
  const rows: DjHistorialRow[] = parsed.success
    ? (parsed.data.data ?? []).map((r) => ({
        id: asNumber(r.id),
        dj: asNumber(r.dj),
        titulo: asStr(r.titulo),
        presentaciones: (r.result ?? []).map(projectHistorialItem),
      }))
    : [];
  return { rut: rut.canonical, periodo: periodo.canonical, rows };
}

// --- Endpoint 3 (ADR-031): detalle — the actual form content (a render-oriented table) ---------

/** One cell of the render-oriented table SII returns for a DJ's content — NOT a semantic
 *  `{codigo,valor}` shape (docs/sii-contract/dj-detalle.md, ADR-031: column meaning is only
 *  knowable by reading the aligned `tipoCelda:"cabecera"` row's labels, and that layout differs
 *  per DJ number, so no per-DJ parser is built here). `value` is REDACTED to `null` when
 *  `contactoRut: true` — SII's OWN PII signal for a counterparty RUT cell (ADR-031). */
export interface DjCelda {
  readonly value: string | number | null;
  readonly colspan: number | null;
  readonly rowspan: number | null;
  readonly style: string | null;
  readonly contactoRut: boolean | null;
}

/** One row: `tipoCelda` classifies it (`"cabecera"` = column labels, `"dato"` = real figures —
 *  verbatim, not a closed enum) and `celdas` is keyed by the SAME column index string SII used
 *  (e.g. `"00"`, `"01"`, …) so a caller can align a `"dato"` row's cell to its `"cabecera"` row's
 *  cell at the same key. */
export interface DjFila {
  readonly tipoCelda: string | null;
  readonly celdas: Readonly<Record<string, DjCelda>>;
}

/** One named sub-table (SII's own key, e.g. `"detalle2"`) within a section. */
export interface DjTablaNombrada {
  readonly nombre: string;
  readonly filas: Readonly<Record<string, DjFila>>;
}

/** One named section (SII's own key, e.g. `"Seccion B"`) — usually one sub-table, but the shape
 *  allows more without assuming exactly one (unobserved whether SII ever sends >1). */
export interface DjSeccion {
  readonly nombre: string;
  readonly tablas: readonly DjTablaNombrada[];
}

export interface DjDetalle {
  readonly rut: string;
  /** `<año>00` for an anual DJ (the only mode exercised live) — verbatim what was sent. */
  readonly periodo: string;
  readonly dj: number;
  readonly key: number;
  readonly secciones: readonly DjSeccion[];
}

const CeldaSchema = z
  .object({
    value: z.unknown().optional(),
    colspan: z.unknown().optional(),
    rowspan: z.unknown().optional(),
    style: z.unknown().optional(),
    contactoRut: z.unknown().optional(),
  })
  .loose();
const FilaSchema = z
  .object({ fila: z.record(z.string(), CeldaSchema).optional(), tipoCelda: z.unknown().optional() })
  .loose();
const TablaSchema = z.object({ tabla: z.record(z.string(), FilaSchema).optional() }).loose();
const DetalleEnvelope = z
  .object({
    data: z
      .object({ listDetalle: z.record(z.string(), z.record(z.string(), TablaSchema)).optional() })
      .nullish(),
    errorMsg: z.string().nullish(),
    error: z.string().nullish(),
  })
  .loose();

function projectCelda(c: z.infer<typeof CeldaSchema>): DjCelda {
  const contactoRut = c.contactoRut === true;
  const rawValue = c.value;
  const value = contactoRut
    ? null // SII's own PII flag — redact (ADR-031)
    : typeof rawValue === 'string' || typeof rawValue === 'number'
      ? rawValue
      : null;
  return {
    value,
    colspan: asNumber(c.colspan),
    rowspan: asNumber(c.rowspan),
    style: asStr(c.style),
    contactoRut,
  };
}

/** `detalle`: the actual form content for one DJ presentation — a render-oriented nested table
 *  (sections → named sub-tables → rows → cells), faithful to the wire, no semantic
 *  reinterpretation (ADR-031). `anio` + `dj` + `key` (from a prior `fetchDjHistorialAnual` call)
 *  identify WHICH presentation; only the ANUAL form (`periodo` sent as `<año>00`), `seccion=1`,
 *  `pagina=1`, `tipoConsulta=1` are live-validated — see docs/sii-contract/dj-detalle.md for what
 *  is NOT yet confirmed (monthly DJs, other secciones, pagination beyond page 1). */
export async function fetchDjDetalle(
  session: PortalSession,
  params: {
    rut: Rut;
    anio: Anio;
    dj: number;
    key: number;
    pagina?: number;
    seccion?: number;
    tipoConsulta?: number;
  },
  pace: () => Promise<void>,
): Promise<DjDetalle> {
  const { rut, anio, dj, key } = params;
  const periodo = `${anio.canonical}00`; // ANUAL convention only (ADR-031) — see wire doc
  const url = `${HOSTS.djConsulta}/${rut.canonical}/recurso/v1/dj/detalle`;
  const raw = await bootstrapAndPost(
    session,
    url,
    {
      periodo,
      dj,
      key,
      pagina: params.pagina ?? 1,
      seccion: params.seccion ?? 1,
      tipoConsulta: params.tipoConsulta ?? 1,
      rut: String(rut.body),
      dv: rut.dv,
    },
    pace,
  );
  if (!hasKnownEnvelopeKey(raw, ['data', 'errorMsg', 'error'])) {
    throw new DjError('Respuesta inesperada de SII (formato no reconocido) al consultar el detalle de la declaración jurada.');
  }
  const err = envelopeError(raw);
  if (err) throw new DjError(err);
  const parsed = DetalleEnvelope.safeParse(raw);
  const listDetalle = parsed.success ? (parsed.data.data?.listDetalle ?? {}) : {};
  const secciones: DjSeccion[] = Object.entries(listDetalle).map(([nombreSeccion, tablasPorNombre]) => ({
    nombre: nombreSeccion,
    tablas: Object.entries(tablasPorNombre).map(([nombreTabla, t]) => ({
      nombre: nombreTabla,
      filas: Object.fromEntries(
        Object.entries(t.tabla ?? {}).map(([filaIdx, f]) => [
          filaIdx,
          {
            tipoCelda: asStr(f.tipoCelda),
            celdas: Object.fromEntries(
              Object.entries(f.fila ?? {}).map(([celdaIdx, c]) => [celdaIdx, projectCelda(c)]),
            ),
          } satisfies DjFila,
        ]),
      ),
    })),
  }));
  return { rut: rut.canonical, periodo, dj, key, secciones };
}
