import { describe, it, expect } from 'vitest';
import { FakePortalSession } from '../adapters/fake/index.js';
import { Rut } from '../rut/index.js';
import { Anio } from '../periodo/index.js';
import { GirosError, SessionExpiredError } from '../errors/index.js';
import { fetchGirosAnual } from './giros.js';

const RUT = Rut.parse('11111111-1');
const ANIO = Anio.parse('2026');
const noPace = (): Promise<void> => Promise.resolve();

const HEADERS = [
  'Período',
  'Folio Giro',
  'Formulario Giro',
  'Formulario Asociado',
  'Fecha de Emisión',
  'Fecha de Vencimiento',
  'Estado',
  'Moneda',
  'Saldo',
  'Ver',
  'Pagar en linea',
  'Imprimir Giro',
];

/** Scripted `evaluate` — the facade issues two distinct expressions (drive, then read). */
function session(read: unknown, opts: { landingUrl?: string; drive?: string } = {}): FakePortalSession {
  return new FakePortalSession({
    ...(opts.landingUrl ? { landingUrl: opts.landingUrl } : {}),
    evaluate: (expr: string) => {
      if (/CONSULTAR_GIROS/.test(expr)) return opts.drive ?? 'ok';
      if (/LEER_GIROS/.test(expr)) return JSON.stringify(read);
      throw new Error('expresión inesperada: ' + expr.slice(0, 60));
    },
  });
}

describe('giros facade (fake session, synthetic DOM payload, no SII)', () => {
  it('curates a real-shaped row, mapping BY HEADER NAME and dropping the action columns', async () => {
    const s = session({
      tabla: true,
      conteo: '1',
      rows: [
        ['Consulta Giros'],
        HEADERS,
        ['Abril 2026', '9121778576', '21', '29', '25/06/2026', '20/05/2026', 'Vigente', 'CLP', '$0', 'Eventos GiroEventos Pago', '', ''],
      ],
    });

    const res = await fetchGirosAnual(s, { rut: RUT, anio: ANIO }, noPace);

    expect(res).toMatchObject({ rut: '11111111-1', anio: '2026', conteoDeclarado: 1 });
    expect(res.giros).toEqual([
      {
        periodo: 'Abril 2026',
        folio: '9121778576',
        formularioGiro: '21',
        formularioAsociado: '29',
        fechaEmision: '25/06/2026',
        fechaVencimiento: '20/05/2026',
        estado: 'Vigente',
        moneda: 'CLP',
        saldo: 0,
        saldoTexto: '$0',
      },
    ]);
    // Las columnas de acción nunca se exponen.
    expect(JSON.stringify(res)).not.toContain('Eventos Giro');
    expect(JSON.stringify(res)).not.toContain('Pagar');
  });

  it('parses an es-CL monto with thousands separators', async () => {
    const s = session({
      tabla: true,
      conteo: '1',
      rows: [
        ['Consulta Giros'],
        HEADERS,
        ['Marzo 2025', '1', '21', '29', '01/04/2025', '20/04/2025', 'Vigente', 'CLP', '$1.234.567', '', '', ''],
      ],
    });

    const res = await fetchGirosAnual(s, { rut: RUT, anio: ANIO }, noPace);

    expect(res.giros[0]).toMatchObject({ saldo: 1234567, saldoTexto: '$1.234.567' });
  });

  it('maps correctly even if SII INSERTS a new column (header-keyed, not positional)', async () => {
    const withExtra = [...HEADERS];
    withExtra.splice(1, 0, 'Nueva Columna'); // se inserta después de "Período"
    const s = session({
      tabla: true,
      conteo: '1',
      rows: [
        ['Consulta Giros'],
        withExtra,
        ['Abril 2026', 'XX', '9121778576', '21', '29', '25/06/2026', '20/05/2026', 'Vigente', 'CLP', '$0', '', '', ''],
      ],
    });

    const res = await fetchGirosAnual(s, { rut: RUT, anio: ANIO }, noPace);

    expect(res.giros[0]).toMatchObject({ folio: '9121778576', estado: 'Vigente', saldo: 0 });
  });

  it('returns several giros in order', async () => {
    const s = session({
      tabla: true,
      conteo: '2',
      rows: [
        ['Consulta Giros'],
        HEADERS,
        ['Febrero 2021', '7458541866', '21', '29', '22/06/2022', '22/03/2021', 'Vigente', 'CLP', '$0', '', '', ''],
        ['Agosto 2021', '7757526896', '21', '29', '03/10/2023', '20/09/2021', 'Vigente', 'CLP', '$0', '', '', ''],
      ],
    });

    const res = await fetchGirosAnual(s, { rut: RUT, anio: ANIO }, noPace);

    expect(res.giros.map((g) => g.folio)).toEqual(['7458541866', '7757526896']);
    expect(res.conteoDeclarado).toBe(2);
  });

  it('an año with no giros is a clean empty result, not an error', async () => {
    const s = session({ tabla: true, conteo: '0', rows: [['Consulta Giros'], HEADERS] });

    const res = await fetchGirosAnual(s, { rut: RUT, anio: ANIO }, noPace);

    expect(res.giros).toEqual([]);
    expect(res.conteoDeclarado).toBe(0);
  });

  it('a MISSING expected header is a LOUD failure — never a silent mis-map', async () => {
    const broken = HEADERS.map((h) => (h === 'Saldo' ? 'Importe' : h)); // SII renombró la columna
    const s = session({
      tabla: true,
      conteo: '1',
      rows: [['Consulta Giros'], broken, ['Abril 2026', '1', '21', '29', '25/06/2026', '20/05/2026', 'Vigente', 'CLP', '$0', '', '', '']],
    });

    await expect(fetchGirosAnual(s, { rut: RUT, anio: ANIO }, noPace)).rejects.toBeInstanceOf(GirosError);
    await expect(fetchGirosAnual(s, { rut: RUT, anio: ANIO }, noPace)).rejects.toThrow(/scraper roto/i);
  });

  it('no results table at all is a GirosError', async () => {
    const s = session({ tabla: false, conteo: null, rows: [] });
    await expect(fetchGirosAnual(s, { rut: RUT, anio: ANIO }, noPace)).rejects.toBeInstanceOf(GirosError);
  });

  it('a dead session (goto lands on the login host) raises SessionExpiredError', async () => {
    const s = session({ tabla: true, conteo: '0', rows: [] }, { landingUrl: 'https://zeusr.sii.cl/AUT2000/x.html' });
    await expect(fetchGirosAnual(s, { rut: RUT, anio: ANIO }, noPace)).rejects.toBeInstanceOf(SessionExpiredError);
  });

  it('surfaces a drive-step failure verbatim rather than returning an empty result', async () => {
    const s = session({ tabla: true, conteo: '0', rows: [] }, { drive: 'anio no disponible' });
    await expect(fetchGirosAnual(s, { rut: RUT, anio: ANIO }, noPace)).rejects.toBeInstanceOf(GirosError);
  });

  it('NEVER clicks anything but Consultar — the drive script must not reference Pagar', async () => {
    const s = session({ tabla: true, conteo: '0', rows: [['Consulta Giros'], HEADERS] });
    await fetchGirosAnual(s, { rut: RUT, anio: ANIO }, noPace);
    const driveExpr = s.evaluatedExpressions.find((e) => /CONSULTAR_GIROS/.test(e)) ?? '';
    expect(driveExpr).toMatch(/consultar/i);
    expect(driveExpr).not.toMatch(/\bpagar\b/i);
  });
});
