// Notificaciones / Correspondencia — Mi SII's own inbox of formal notifications and informal
// correspondence sent by SII (ADR-032). Full contract: docs/sii-contract/notificaciones.md.
//
// A SEVENTH wire shape (after SDI-JSON, inline-JS-map, form-POST→HTML BPST, GWT-RPC peticiones,
// REST-JSON-by-path DJ, public HTML DTE): Mi SII's OWN `CViewCarta.cgi` — a form-POST
// (`x-www-form-urlencoded`, `opc=<n>`) that answers JSON, with an envelope `{estado, glosa, data,
// metaData}` distinct from every envelope already in this codebase. Reached via the EXISTING
// `PortalSession.requestForm` primitive (ADR-017) — no new seam needed, and — unlike DJ
// (ADR-030) — NO bootstrap `goto` is required: a cold POST works directly (observed 2026-08-03).
//
// TWO categories share this one CGI, selected by `opc`: FORMAL notifications (opc=41 list / 43
// detail — "Mis Notificaciones Vigentes") and informal CORRESPONDENCIA (opc=40 list / 42 detail).
// Same envelope, same detail shape.
//
// CORRECTION of an earlier hypothesis (docs/audits/2026-08-03-spike4-notificaciones-progress.md):
// the GWT app at corenoti1Internet (`linkexterno(4)`) is NOT the read surface — its own tooltip,
// read live from Mi SII's source, is "Solicitar, actualizar o revocar correo para
// notificaciones": it manages WHICH EMAIL receives alerts, a write flow. The GWT decoder built
// for `peticiones` (ADR-020) was not needed here — see ADR-032.
import { z } from 'zod';
import { HOSTS } from '../config/index.js';
import { NotificacionesError } from '../errors/index.js';
import type { Rut } from '../rut/index.js';
import type { PortalSession } from '../seams/index.js';

export type NotificacionCategoria = 'FORMAL' | 'CORRESPONDENCIA';

/** `opc` codes observed live (docs/sii-contract/notificaciones.md, MISII_OPC_MAP in
 *  `misii.min.js`): 41/43 = Notificaciones (formal), 40/42 = Correspondencia. */
const LIST_OPC: Record<NotificacionCategoria, string> = { FORMAL: '41', CORRESPONDENCIA: '40' };
const DETAIL_OPC: Record<NotificacionCategoria, string> = { FORMAL: '43', CORRESPONDENCIA: '42' };

/** One row of a Notificaciones/Correspondencia list — no PII curation trade-off, every SII field
 *  is own-account metadata (id/fecha/descripción/tipo codes), so the full row is surfaced
 *  verbatim (same posture as DJ). `tipo` passes through as SII's own string code — NO decode
 *  table is asserted (ADR-004); `tipoNotificacion`/`descTipo` are SII's own human labels. */
export interface NotificacionItem {
  readonly id: number | null;
  /** Epoch milliseconds, verbatim (CONVENTIONS: no human formatting in the core). */
  readonly fechaEpochMs: number | null;
  readonly descripcion: string | null;
  readonly tipo: string | null;
  readonly tipoNotificacion: string | null;
  readonly descTipo: string | null;
  readonly origen: string | null;
  readonly periodo: string | null;
}

export interface NotificacionesLista {
  readonly rut: string;
  readonly categoria: NotificacionCategoria;
  readonly items: readonly NotificacionItem[];
  /** `true` when `metaData.page` reports more pages than this call returned — pagination beyond
   *  page 1 is UNOBSERVED (docs/sii-contract/notificaciones.md); never silently truncated. */
  readonly masPaginas: boolean;
}

/** One attachment's NAME only — the base64 file content is deliberately dropped (payload
 *  size/relevance, not a PII decision; see ADR-032). */
export interface NotificacionAdjunto {
  readonly nombre: string | null;
}

/** The letter content for one notification/correspondencia item. `bodyHtml` carries the
 *  taxpayer's OWN identity (razón social, contact email) — surfaced deliberately, same posture
 *  as `whoami` (own-identity exposure, not the BTE/BPST own+counterparty mixing problem). No
 *  base64 attachment/certificate payload ever leaves this facade (ADR-032). */
export interface NotificacionDetalle {
  readonly rut: string;
  readonly categoria: NotificacionCategoria;
  readonly id: number;
  readonly tipo: string;
  readonly asunto: string | null;
  readonly from: string | null;
  readonly to: string | null;
  readonly bodyHtml: string | null;
  readonly adjuntos: readonly NotificacionAdjunto[];
  readonly tieneCertificado: boolean;
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

const ItemSchema = z
  .object({
    id: z.unknown().optional(),
    fecha: z.unknown().optional(),
    descripcion: z.unknown().optional(),
    tipo: z.unknown().optional(),
    tipoNotificacion: z.unknown().optional(),
    descTipo: z.unknown().optional(),
    origen: z.unknown().optional(),
    periodo: z.unknown().optional(),
  })
  .loose();
const PageSchema = z
  .object({
    fullSize: z.unknown().optional(),
    currentPageIndex: z.unknown().optional(),
    pageSize: z.unknown().optional(),
    lastPageIndex: z.unknown().optional(),
  })
  .loose();
const ListEnvelope = z
  .object({
    estado: z.unknown().optional(),
    glosa: z.unknown().optional(),
    data: z.array(ItemSchema).nullish(),
    metaData: z.object({ page: PageSchema.nullish() }).loose().nullish(),
  })
  .loose();

function projectItem(r: z.infer<typeof ItemSchema>): NotificacionItem {
  return {
    id: asNumber(r.id),
    fechaEpochMs: asNumber(r.fecha),
    descripcion: asStr(r.descripcion),
    tipo: asStr(r.tipo),
    tipoNotificacion: asStr(r.tipoNotificacion),
    descTipo: asStr(r.descTipo),
    origen: asStr(r.origen),
    periodo: asStr(r.periodo),
  };
}

/** Parse `requestForm`'s raw text body as JSON, raising `NotificacionesError` (never a raw parse
 *  crash) when the body isn't JSON at all — the CGI is expected to always answer JSON on a live
 *  session (no bootstrap/login-wall shape observed for this endpoint, ADR-032). */
function parseJsonBody(body: string, action: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new NotificacionesError(
      `Respuesta inesperada de SII (no es JSON) al ${action}.`,
    );
  }
}

/** `estado: 0` = success. `estado: 1403` ("No existen registros") = a legitimate empty result,
 *  never an error. Any other `estado` raises `NotificacionesError` with SII's `glosa` verbatim
 *  (ADR-004) — no other value has been observed live. */
function checkEstado(estado: unknown, glosa: unknown): void {
  const code = asNumber(estado);
  if (code === 0 || code === 1403) return;
  throw new NotificacionesError(asStr(glosa) ?? `Estado SII no reconocido (${String(estado)}).`);
}

/** List Notificaciones (FORMAL, opc=41) or Correspondencia (CORRESPONDENCIA, opc=40). */
export async function fetchComunicacionesList(
  session: PortalSession,
  params: { rut: Rut; categoria: NotificacionCategoria },
): Promise<NotificacionesLista> {
  const { rut, categoria } = params;
  const res = await session.requestForm(HOSTS.notificacionesCgi, {
    method: 'POST',
    form: { opc: LIST_OPC[categoria], VIEW: '1' },
  });
  const raw = parseJsonBody(res.body, 'consultar notificaciones');
  const parsed = ListEnvelope.safeParse(raw);
  if (!parsed.success) {
    throw new NotificacionesError('Respuesta inesperada de SII (formato no reconocido) al consultar notificaciones.');
  }
  checkEstado(parsed.data.estado, parsed.data.glosa);
  const items = (parsed.data.data ?? []).map(projectItem);
  const page = parsed.data.metaData?.page;
  const masPaginas =
    page != null &&
    asNumber(page.currentPageIndex) !== null &&
    asNumber(page.lastPageIndex) !== null &&
    (asNumber(page.currentPageIndex) as number) < (asNumber(page.lastPageIndex) as number);
  return { rut: rut.canonical, categoria, items, masPaginas: masPaginas === true };
}

const DetailDataSchema = z
  .object({
    from: z.unknown().optional(),
    to: z.unknown().optional(),
    asunto: z.unknown().optional(),
    body: z.unknown().optional(),
    adjunto: z.array(z.object({ name: z.unknown().optional() }).loose()).nullish(),
  })
  .loose();
const DetailEnvelope = z
  .object({
    estado: z.unknown().optional(),
    glosa: z.unknown().optional(),
    data: DetailDataSchema.nullish(),
    certificado: z.unknown().optional(),
  })
  .loose();

/** Detail for one Notificación (FORMAL, opc=43) or Correspondencia (CORRESPONDENCIA, opc=42)
 *  item, identified by its `id` + `tipo` from a prior list call. `opc=43`'s exact shape is
 *  UNCONFIRMED with real data (docs/sii-contract/notificaciones.md) — modeled identically to the
 *  observed `opc=42` shape since both share one client-side handler in SII's own JS. */
export async function fetchComunicacionDetalle(
  session: PortalSession,
  params: { rut: Rut; categoria: NotificacionCategoria; id: number; tipo: string },
): Promise<NotificacionDetalle> {
  const { rut, categoria, id, tipo } = params;
  const res = await session.requestForm(HOSTS.notificacionesCgi, {
    method: 'POST',
    form: {
      opc: DETAIL_OPC[categoria],
      MODE: tipo,
      repoId: String(id),
      rnd: String(Math.random()),
    },
  });
  const raw = parseJsonBody(res.body, 'consultar el detalle de la notificación');
  const parsed = DetailEnvelope.safeParse(raw);
  if (!parsed.success) {
    throw new NotificacionesError(
      'Respuesta inesperada de SII (formato no reconocido) al consultar el detalle de la notificación.',
    );
  }
  checkEstado(parsed.data.estado, parsed.data.glosa);
  const data = parsed.data.data;
  const adjuntos: NotificacionAdjunto[] = (data?.adjunto ?? []).map((a) => ({ nombre: asStr(a.name) }));
  return {
    rut: rut.canonical,
    categoria,
    id,
    tipo,
    asunto: asStr(data?.asunto),
    from: asStr(data?.from),
    to: asStr(data?.to),
    bodyHtml: asStr(data?.body),
    adjuntos,
    tieneCertificado: parsed.data.certificado != null,
  };
}
