// Giros — deuda fiscal formal emitida al contribuyente (ADR-034). Contrato completo:
// docs/sii-contract/giros.md.
//
// LEE EL DOM RENDERIZADO, no el GWT-RPC — una desviación DELIBERADA de la preferencia de
// ADR-020, justificada en ADR-034 por el MODO DE FALLA. `rfiInternet` habla GWT protocolo 7
// (peticiones habla el 5): longs en base64, literales entre comillas simples que romperían el
// `JSON.parse` del códec actual, y un registro de deserializadores ofuscado distinto que
// obligaría a re-derivar el extractor de esquema desde cero. Un esquema mal derivado NO falla
// ruidosamente: corre un campo de posición y devuelve un MONTO o una FECHA DE VENCIMIENTO
// silenciosamente equivocados sobre deuda fiscal. La tabla renderizada, en cambio, está limpia
// y rotulada, y se lee MAPEANDO POR NOMBRE DE CABECERA: si SII cambia la tabla, la cabecera
// esperada no aparece y esto falla FUERTE ("scraper roto"), nunca en silencio.
//
// ⛔ SOLO LECTURA. La misma página expone un botón "Pagar" y enlaza `www2.sii.cl/pagogiro-ui/`.
// El script de manejo de esta fachada pulsa EXCLUSIVAMENTE "Consultar" — pinned por un test que
// verifica que la expresión enviada al navegador no menciona "Pagar" (giros.test.ts). Cualquier
// flujo de pago exige su propio ADR con la postura de escritura de ADR-017/ADR-026.
import { HOSTS, LOGIN_HOST } from '../config/index.js';
import { GirosError, SessionExpiredError } from '../errors/index.js';
import type { Anio } from '../periodo/index.js';
import type { Rut } from '../rut/index.js';
import type { PortalSession } from '../seams/index.js';

const CONSULTA_URL = `${HOSTS.rfiInternet}/?opcionPagina=ConsultaGiros`;

/** Cabeceras EXIGIDAS en la tabla de resultados (observadas 2026-08-03). Si alguna falta, la
 *  tabla cambió y esto es "scraper roto" — jamás un mapeo posicional a ciegas. */
const REQUIRED_HEADERS = [
  'Período',
  'Folio Giro',
  'Formulario Giro',
  'Formulario Asociado',
  'Fecha de Emisión',
  'Fecha de Vencimiento',
  'Estado',
  'Moneda',
  'Saldo',
] as const;

/** Un giro emitido. Todo verbatim salvo `saldo`, que además se entrega parseado. `estado` pasa
 *  tal cual: solo se observó `"Vigente"` en vivo y — dato NO obvio — apareció junto a saldo $0,
 *  así que **"Vigente" NO significa impago**; la deuda es `saldo` (ADR-034). Sin enum cerrado. */
export interface Giro {
  /** Período del giro, verbatim como lo rotula SII (ej. `"Abril 2026"`). */
  readonly periodo: string | null;
  readonly folio: string | null;
  /** Formulario del giro (ej. `"21"`). */
  readonly formularioGiro: string | null;
  /** Formulario que lo origina (ej. `"29"` = el F29 del período). */
  readonly formularioAsociado: string | null;
  /** `DD/MM/YYYY` verbatim. */
  readonly fechaEmision: string | null;
  readonly fechaVencimiento: string | null;
  readonly estado: string | null;
  readonly moneda: string | null;
  /** Saldo adeudado, parseado desde el texto es-CL. `null` si no se pudo interpretar. */
  readonly saldo: number | null;
  /** El texto del saldo tal cual lo entrega SII (ej. `"$0"`, `"$1.234.567"`). */
  readonly saldoTexto: string | null;
}

export interface GirosAnual {
  readonly rut: string;
  readonly anio: string;
  readonly giros: readonly Giro[];
  /** El conteo que declara la propia página ("Se encontraron N Giro(s)"), para cruzar contra
   *  `giros.length`. Un desajuste indica truncamiento/paginación no observada. */
  readonly conteoDeclarado: number | null;
}

/** Manejo de la SPA: elegir búsqueda Anual + año y pulsar "Consultar". NUNCA "Pagar" — el
 *  marcador `CONSULTAR_GIROS` identifica esta expresión en los tests. */
const driveScript = (anio: string): string => `
(function(){ /* CONSULTAR_GIROS */
  var r = document.querySelectorAll('input[type=radio]')[0];
  if (r) { r.click(); }
  var s = document.querySelectorAll('select')[0];
  var ok = false;
  if (s) {
    for (var i = 0; i < s.options.length; i++) {
      if (s.options[i].textContent.trim() === ${JSON.stringify(anio)}) { s.value = s.options[i].value; ok = true; break; }
    }
    s.dispatchEvent(new Event('change', { bubbles: true }));
  }
  if (!ok) { return 'anio-no-disponible'; }
  var btns = document.querySelectorAll('button');
  for (var j = 0; j < btns.length; j++) {
    if (/^consultar$/i.test((btns[j].textContent || '').trim())) { btns[j].click(); return 'ok'; }
  }
  return 'sin-boton-consultar';
})()`;

/** Lectura de la tabla renderizada. Devuelve filas crudas; TODA la interpretación ocurre en
 *  TypeScript (testeable), no dentro del navegador. */
const READ_SCRIPT = `
(function(){ /* LEER_GIROS */
  var tables = document.querySelectorAll('table.tabla_internet');
  var t = null;
  for (var i = 0; i < tables.length; i++) {
    if (/Folio Giro/i.test(tables[i].textContent || '')) { t = tables[i]; break; }
  }
  var m = (document.body.innerText || '').match(/Se encontraron\\s+(\\d+)\\s+Giro/i);
  var conteo = m ? m[1] : null;
  if (!t) { return JSON.stringify({ tabla: false, conteo: conteo, rows: [] }); }
  var rows = [];
  for (var r = 0; r < t.rows.length; r++) {
    var cells = [];
    for (var c = 0; c < t.rows[r].cells.length; c++) {
      cells.push((t.rows[r].cells[c].textContent || '').trim());
    }
    rows.push(cells);
  }
  return JSON.stringify({ tabla: true, conteo: conteo, rows: rows });
})()`;

interface RawRead {
  readonly tabla?: boolean;
  readonly conteo?: string | null;
  readonly rows?: string[][];
}

const clean = (v: string | undefined): string | null => {
  const s = (v ?? '').trim();
  return s === '' ? null : s;
};

/** Monto es-CL: `"$1.234.567"` → `1234567`. El punto es separador de miles (no decimal). */
function parseMonto(text: string | null): number | null {
  if (text === null) return null;
  const digits = text.replace(/[^\d-]/g, '');
  if (digits === '' || digits === '-') return null;
  const n = Number(digits);
  return Number.isFinite(n) ? n : null;
}

/** Localiza la fila de cabecera y devuelve el índice de columna por nombre. Falla FUERTE si
 *  falta cualquier cabecera exigida — el corazón del modo de falla ruidoso (ADR-034). */
function headerIndex(rows: readonly string[][]): Record<string, number> {
  const headerRow = rows.find((r) => r.some((c) => /Folio Giro/i.test(c)));
  if (!headerRow) {
    throw new GirosError(
      'No se encontró la fila de cabecera de la tabla de giros (scraper roto): la página de SII cambió de forma.',
    );
  }
  const idx: Record<string, number> = {};
  for (const want of REQUIRED_HEADERS) {
    const at = headerRow.findIndex((c) => c.trim().toLowerCase() === want.toLowerCase());
    if (at === -1) {
      throw new GirosError(
        `Falta la columna "${want}" en la tabla de giros (scraper roto): la página de SII cambió de forma. ` +
          `Cabeceras recibidas: ${headerRow.join(' | ')}`,
      );
    }
    idx[want] = at;
  }
  return idx;
}

/** Giros del año `anio` para el titular de la sesión. SESSION-KEYED: maneja la propia UI del
 *  SII, que opera sobre el principal de la sesión; `rut` solo rotula el resultado. */
export async function fetchGirosAnual(
  session: PortalSession,
  params: { rut: Rut; anio: Anio },
  pace: () => Promise<void>,
): Promise<GirosAnual> {
  const { rut, anio } = params;

  const landed = await session.goto(CONSULTA_URL);
  if (new URL(landed).hostname === LOGIN_HOST) {
    throw new SessionExpiredError('La sesión expiró. Ejecuta `sii auth login`.');
  }
  await pace(); // la SPA GWT se monta de forma asíncrona

  const drive = await session.evaluate<string>(driveScript(anio.canonical));
  if (drive !== 'ok') {
    throw new GirosError(
      `No se pudo ejecutar la consulta de giros para ${anio.canonical} (${String(drive)}): la página de SII cambió de forma.`,
    );
  }
  await pace(); // esperar a que GWT pinte la tabla

  const raw = await session.evaluate<string>(READ_SCRIPT);
  let parsed: RawRead;
  try {
    parsed = JSON.parse(raw) as RawRead;
  } catch {
    throw new GirosError('Respuesta inesperada al leer la tabla de giros (scraper roto).');
  }
  if (parsed.tabla !== true) {
    throw new GirosError(
      'No se encontró la tabla de resultados de giros (scraper roto): la página de SII cambió de forma.',
    );
  }

  const rows = parsed.rows ?? [];
  const idx = headerIndex(rows);
  const headerAt = rows.findIndex((r) => r.some((c) => /Folio Giro/i.test(c)));
  const at = (row: string[], name: string): string | null => clean(row[idx[name]!]);

  const giros: Giro[] = rows.slice(headerAt + 1).flatMap((row) => {
    // Filas de relleno/subtabla: sin folio no hay giro que curar.
    const folio = at(row, 'Folio Giro');
    if (folio === null) return [];
    const saldoTexto = at(row, 'Saldo');
    return [
      {
        periodo: at(row, 'Período'),
        folio,
        formularioGiro: at(row, 'Formulario Giro'),
        formularioAsociado: at(row, 'Formulario Asociado'),
        fechaEmision: at(row, 'Fecha de Emisión'),
        fechaVencimiento: at(row, 'Fecha de Vencimiento'),
        estado: at(row, 'Estado'),
        moneda: at(row, 'Moneda'),
        saldo: parseMonto(saldoTexto),
        saldoTexto,
      } satisfies Giro,
    ];
  });

  const conteoDeclarado = parsed.conteo != null ? parseMonto(parsed.conteo) : null;
  return { rut: rut.canonical, anio: anio.canonical, giros, conteoDeclarado };
}
