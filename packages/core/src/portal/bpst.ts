// BPST — Boleta de Prestación de Servicios de Terceros Electrónica (ADR-029). A company pays a
// low-skilled/informal worker (agrícola, bodega, reparto — anyone unable to operate the SII
// portal) and EMITS the boleta on the worker's behalf; the company is the technical "emisor" of
// record but economically withholds on the worker's income, same tax substance as a standard BHE
// recibida (ADR-023) — just a DIFFERENT SII product, on a DIFFERENT host, with its OWN wire shape.
// Wire contract first-hand-observed 2026-07-29 (real taxpayer account, prod); full contract:
// docs/sii-contract/bpst.md.
//
// NAMING COLLISION (read before touching `bte.ts`): SII's OWN UI abbreviates THIS product "BTE"
// ("Emitir BTE por contribuyente", "Consulta de BTE's recibidas/emitidas"). This project's
// EXISTING `portal/bte.ts` is an unrelated, correctly-implemented module for standard Boletas de
// Honorarios Electrónicas (loa.sii.cl) that happens to share the "BTE" shorthand by coincidence of
// the original developers' naming, not because the two SII products are the same. This module is
// named `bpst` throughout specifically to avoid deepening that collision (ADR-029).
//
// DISTINCT WIRE SHAPE from both existing legacy patterns: not the `www4.sii.cl` SDI-JSON facades
// (RCV/F22/F29) and not `loa.sii.cl`'s inline-JS-map (`goto`/`evaluate`, BTE/BHE). This is a plain
// HTML table behind a `zeus.sii.cl` form-POST — reached via `PortalSession.requestForm` (the
// ADR-017 write-flow primitive, here used for a non-mutating "Consultar" read), with an in-house
// tag-stripping table parser (stdlib only, no third-party HTML library, ADR-004 — same style as
// `dte-public.ts`).
import { HOSTS, LOGIN_HOST } from '../config/index.js';
import { BpstError, SessionExpiredError } from '../errors/index.js';
import { Rut } from '../rut/index.js';
import type { Periodo } from '../periodo/index.js';
import type { PortalSession } from '../seams/index.js';

export type BpstSide = 'EMITIDAS' | 'RECIBIDAS';

const BOOTSTRAP_CNTR: Record<BpstSide, string> = { EMITIDAS: '1', RECIBIDAS: '2' };
const QUERY_URL = `${HOSTS.bpstCgi}/bte_indiv_cons2`;

// A non-advancing-loop backstop (ADR-004), mirroring `bte.ts`. Never observed live beyond 2 pages.
const MAX_PAGINAS = 200;

/** One BPST boleta — curated, **no `raw`** (same live-BUG-1 reasoning as BTE/BHE: EMITIDAS rows
 *  mix the taxpayer's OWN identity — the "Emisión" group — with the worker's — the "Receptor"
 *  group — and the own-identity field set is not provably enumerable). `estado` carries BOTH
 *  SII's short code AND its human tooltip label verbatim — only `VIG`/`'Vigente'` has been
 *  observed live, so no closed enum is asserted (ADR-004; see docs/sii-contract/bpst.md). */
export interface BpstBoleta {
  readonly folio: number | null;
  readonly estado: string | null; // short code from the <a> text, e.g. "VIG"
  readonly estadoLabel: string | null; // tooltip label, e.g. "Vigente"
  /** `DD-MM-YYYY` verbatim (ADR-004) — note the hyphens, unlike BTE/BHE's `DD/MM/YYYY`. */
  readonly fecha: string | null;
  /** The counterparty: the WORKER (emitidas) or the issuer (recibidas) — never the taxpayer's
   *  own identity, which this facade reads internally but never surfaces. */
  readonly contraparteRut: string | null;
  readonly contraparteNombre: string | null;
  readonly brutos: number | null;
  readonly retenidos: number | null;
  readonly pagado: number | null;
}

/** Per-month aggregates, SUMMED ACROSS EVERY PAGE — the `(*)Totales` row on the wire is PER-PAGE,
 *  not per-month (the load-bearing trap this facade exists to get right; see
 *  docs/sii-contract/bpst.md). Trusting page 1 alone under-counted a real month by 44.5%. */
export interface BpstTotales {
  readonly brutos: number | null;
  readonly retenidos: number | null;
  readonly pagado: number | null;
}

export interface BpstMensual {
  readonly rut: string;
  readonly periodo: string; // YYYY-MM
  readonly side: BpstSide;
  /** From the page-1 summary line ("Total Boletas : n") — informational; the authoritative
   *  count is `boletas.length` (every page walked and summed). */
  readonly totalBoletas: number | null;
  readonly boletasVigentes: number | null;
  readonly boletasAnuladas: number | null;
  readonly totales: BpstTotales;
  readonly boletas: readonly BpstBoleta[];
}

const asStr = (v: string | undefined): string | null => {
  if (v === undefined) return null;
  const s = v.trim();
  return s === '' ? null : s;
};

/** Parse a Chilean dot-formatted integer monto (`"804.598"` → 804598); non-numeric → null. */
const asMonto = (v: string | undefined): number | null => {
  const s = asStr(v);
  if (s === null) return null;
  const digits = s.replace(/\./g, '');
  if (!/^-?\d+$/.test(digits)) return null;
  return Number(digits);
};

// --- In-house HTML helpers (stdlib only, no third-party HTML library — ADR-004) ---------------
// Mirrors `dte-public.ts`'s entity/tag handling; kept local (BPST's row shape — mixed anchor
// tags carrying BOTH visible text and an `overlib` tooltip argument — needs raw-cell access that
// a fully tag-stripping generic table parser would throw away).
const NAMED_ENTITIES: Record<string, string> = {
  aacute: 'á',
  eacute: 'é',
  iacute: 'í',
  oacute: 'ó',
  uacute: 'ú',
  ntilde: 'ñ',
  Aacute: 'Á',
  Eacute: 'É',
  Iacute: 'Í',
  Oacute: 'Ó',
  Uacute: 'Ú',
  Ntilde: 'Ñ',
  deg: '°',
  ordm: 'º',
};
function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&([A-Za-z]+);/g, (m, name: string) => NAMED_ENTITIES[name] ?? m)
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)));
}
const cellText = (rawInner: string): string =>
  decodeEntities(rawInner.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();

/** Every `<td>...</td>` cell's RAW inner HTML (tags NOT stripped — the estado cell needs its
 *  anchor attributes) for one `<tr>...</tr>` block. */
function rawCells(trHtml: string): string[] {
  const cells: string[] = [];
  const tdRe = /<td\b[^>]*>([\s\S]*?)<\/td>/gi;
  for (let m = tdRe.exec(trHtml); m !== null; m = tdRe.exec(trHtml)) {
    cells.push(m[1] ?? '');
  }
  return cells;
}

/** A DATA row (one boleta) is identified by its "Ver" cell linking to the detail CGI
 *  (`bte_indiv_cons3?...`) — present ONLY on individual boleta rows, never on the header or the
 *  `(*)Totales` row (observed 2026-07-29). */
function isDataRow(trHtml: string): boolean {
  return trHtml.includes('bte_indiv_cons3?');
}

/** The Estado cell is an `<a>` whose visible text is the short code (e.g. "VIG") and whose
 *  `overlib('<label>', ...)` argument is the human label (e.g. "Vigente"). Falls back to the
 *  plain cell text (no anchor) if SII ever renders it without the tooltip markup. */
function parseEstado(rawCell: string): { estado: string | null; estadoLabel: string | null } {
  const overlib = /overlib\(\s*'([^']*)'/.exec(rawCell);
  return { estado: asStr(cellText(rawCell)), estadoLabel: overlib ? asStr(overlib[1]) : null };
}

/** Project one EMITIDAS data row's 12 raw cells into a curated `BpstBoleta`. Column order
 *  (observed 2026-07-29): Ver, N°, Estado, Fecha, [Emisión Rut, Nombre — the taxpayer's OWN
 *  identity, read but never surfaced], Fecha(2nd), [Receptor Rut, Nombre — the WORKER],
 *  Brutos, Retenidos, Pagado. */
function projectEmitidasRow(cells: string[]): BpstBoleta | null {
  if (cells.length < 12) return null;
  const { estado, estadoLabel } = parseEstado(cells[2]!);
  return {
    folio: asMonto(cellText(cells[1]!)),
    estado,
    estadoLabel,
    fecha: asStr(cellText(cells[3]!)),
    contraparteRut: parseSplitRut(cells[7]!),
    contraparteNombre: asStr(cellText(cells[8]!)),
    brutos: asMonto(cellText(cells[9]!)),
    retenidos: asMonto(cellText(cells[10]!)),
    pagado: asMonto(cellText(cells[11]!)),
  };
}

/** The Rut cell renders as a single `"NNNNNNNN-D"` string (observed), unlike BTE/BHE's split
 *  digits+dv fields — parse it directly; `parseSplitRut` is a defensive fallback in case a future
 *  observation shows a split form instead (kept tiny, not asserted as needed today). */
function parseSplitRut(rawCell: string): string | null {
  const text = cellText(rawCell);
  return Rut.tryParse(text)?.canonical ?? null;
}

/** RECIBIDAS row shape mirrors EMITIDAS's group structure MINUS the "Emisión = self" group (the
 *  taxpayer IS the receptor by construction of this query side) — 10 columns: Ver, N°, Estado,
 *  Fecha, [Emisor Rut, Nombre, Fecha — the counterparty], Brutos, Retenidos, Pagado.
 *  **HEADER-ONLY OBSERVED — no real recibidas row seen live** (every sampled month for the
 *  captured RUT was empty); re-validate against a taxpayer with real recibidas activity before
 *  trusting this mapping (docs/sii-contract/bpst.md). */
function projectRecibidasRow(cells: string[]): BpstBoleta | null {
  if (cells.length < 10) return null;
  const { estado, estadoLabel } = parseEstado(cells[2]!);
  return {
    folio: asMonto(cellText(cells[1]!)),
    estado,
    estadoLabel,
    fecha: asStr(cellText(cells[3]!)),
    contraparteRut: parseSplitRut(cells[4]!),
    contraparteNombre: asStr(cellText(cells[5]!)),
    brutos: asMonto(cellText(cells[7]!)),
    retenidos: asMonto(cellText(cells[8]!)),
    pagado: asMonto(cellText(cells[9]!)),
  };
}

/** This PAGE's `(*)Totales` row — NOT the month total (see the module header). */
function parsePageTotales(html: string): BpstTotales {
  const idx = html.indexOf('(*)Totales');
  if (idx === -1) return { brutos: null, retenidos: null, pagado: null };
  const tail = html.slice(idx, idx + 800);
  const nums = [...tail.matchAll(/class="reporte">\s*([\d.]+)\s*</g)].map((m) => asMonto(m[1]));
  return { brutos: nums[0] ?? null, retenidos: nums[1] ?? null, pagado: nums[2] ?? null };
}

/** The page-1-only summary line: `Total Boletas : n`, `Boletas Vigentes : n`,
 *  `Boletas Anuladas : n`. Absent on a non-report page. */
function parseSummary(html: string): {
  totalBoletas: number | null;
  boletasVigentes: number | null;
  boletasAnuladas: number | null;
} {
  const total = /Total Boletas\s*:\s*(\d+)/.exec(html);
  const vig = /Boletas Vigentes\s*:\s*(\d+)/.exec(html);
  const anu = /Boletas Anuladas\s*:\s*(\d+)/.exec(html);
  return {
    totalBoletas: total ? Number(total[1]) : null,
    boletasVigentes: vig ? Number(vig[1]) : null,
    boletasAnuladas: anu ? Number(anu[1]) : null,
  };
}

/** Whether a further page exists: a `NEXT` button present and NOT `disabled`. */
function hasNextPage(html: string): boolean {
  const m = /<input\b[^>]*name="NEXT"[^>]*>/i.exec(html);
  if (!m) return false;
  return !/disabled/i.test(m[0]);
}

function sumTotales(a: BpstTotales, b: BpstTotales): BpstTotales {
  const add = (x: number | null, y: number | null): number | null =>
    x === null && y === null ? null : (x ?? 0) + (y ?? 0);
  return { brutos: add(a.brutos, b.brutos), retenidos: add(a.retenidos, b.retenidos), pagado: add(a.pagado, b.pagado) };
}

/** A non-report / cross-RUT page has neither the expected title text nor a `(*)Totales`
 *  block — SII's generic "página no encontrada" shape, or an unrelated page. */
function looksLikeReport(html: string): boolean {
  return html.includes('BTE') && (html.includes('(*)Totales') || html.includes('Total Boletas'));
}

/** Monthly BPST detail for one (período, side), session-keyed (ADR-005 — no `--rut`, mirrors
 *  BTE/F22/F29). Walks every result page (the `(*)Totales` row is PER-PAGE — see the module
 *  header) and returns the SUMMED month total. `session` must be a live `PortalSession` acquired
 *  via `withSession`. */
export async function fetchBpstMensual(
  session: PortalSession,
  params: { rut: Rut; periodo: Periodo; side: BpstSide },
  pace: () => Promise<void>,
): Promise<BpstMensual> {
  const { rut, periodo, side } = params;

  // Bootstrap GET mints the query form context; the .sii.cl cookie SSO-carries here (mirrors
  // every other legacy CGI in this codebase). A dead session bounces to LOGIN_HOST.
  const landed = await session.goto(`${HOSTS.bpstCgi}/bte_indiv_cons?${BOOTSTRAP_CNTR[side]}`);
  if (new URL(landed).hostname === LOGIN_HOST) {
    throw new SessionExpiredError('La sesión expiró. Ejecuta `sii auth login`.');
  }

  const boletas: BpstBoleta[] = [];
  let totales: BpstTotales = { brutos: null, retenidos: null, pagado: null };
  let summary: ReturnType<typeof parseSummary> = {
    totalBoletas: null,
    boletasVigentes: null,
    boletasAnuladas: null,
  };

  for (let pagina = 1; pagina <= MAX_PAGINAS; pagina++) {
    if (pagina > 1) await pace(); // pace each extra page (ADR-004); the task binds the rps
    const mes = String(periodo.month).padStart(2, '0');
    const res = await session.requestForm(QUERY_URL, {
      method: 'POST',
      form: {
        TIPO: 'mensual',
        CNTR: BOOTSTRAP_CNTR[side],
        AUTEN: 'RUTCLAVE',
        PAGINA: String(pagina),
        MESM: mes,
        ANOM: String(periodo.year),
      },
    });

    if (!looksLikeReport(res.body)) {
      if (pagina === 1) {
        throw new BpstError(
          `El SII no entregó el informe de boletas de prestación de servicios de terceros ` +
            `para ${periodo.formatted} (${side.toLowerCase()}). Verifica la sesión y el período.`,
        );
      }
      break; // walked past the end
    }

    if (pagina === 1) summary = parseSummary(res.body);
    totales = sumTotales(totales, parsePageTotales(res.body));

    const trRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
    for (let tr = trRe.exec(res.body); tr !== null; tr = trRe.exec(res.body)) {
      const trHtml = tr[0];
      if (!isDataRow(trHtml)) continue;
      const cells = rawCells(trHtml);
      const boleta = side === 'EMITIDAS' ? projectEmitidasRow(cells) : projectRecibidasRow(cells);
      if (boleta) boletas.push(boleta);
    }

    if (!hasNextPage(res.body)) break;
  }

  return {
    rut: rut.canonical,
    periodo: periodo.formatted,
    side,
    totalBoletas: summary.totalBoletas,
    boletasVigentes: summary.boletasVigentes,
    boletasAnuladas: summary.boletasAnuladas,
    totales,
    boletas,
  };
}
