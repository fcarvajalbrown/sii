import { describe, it, expect } from 'vitest';
import { FakePortalSession } from '../adapters/fake/index.js';
import { Rut } from '../rut/index.js';
import { Anio } from '../periodo/index.js';
import { DjError, SessionExpiredError } from '../errors/index.js';
import { fetchDjDetalle, fetchDjEstadoAnual, fetchDjHistorialAnual } from './dj.js';

// Synthetic data only (no SII, no real PII): principal 11.111.111-1.
const RUT = Rut.parse('11111111-1');
const noPace = (): Promise<void> => Promise.resolve();

describe('DJ estado facade (fake session, synthetic JSON, no SII)', () => {
  it('bootstraps via goto to the UI page, paces, THEN posts — the live-confirmed 401 trap (ADR-030)', async () => {
    const session = new FakePortalSession({
      requestJson: () => ({ data: [], errorMsg: null }),
    });
    let paced = false;

    await fetchDjEstadoAnual(session, { rut: RUT, periodo: Anio.parse('2026') }, async () => {
      paced = true;
    });

    expect(session.gotos[0]).toBe('https://www2.sii.cl/djconsulta/consultaddjjs');
    expect(paced).toBe(true); // pace() was called between the bootstrap goto and the POST
  });

  it('a dead session (bootstrap goto lands on the login host) raises SessionExpiredError', async () => {
    const session = new FakePortalSession({ landingUrl: 'https://zeusr.sii.cl/AUT2000/x.html' });

    await expect(
      fetchDjEstadoAnual(session, { rut: RUT, periodo: Anio.parse('2026') }, noPace),
    ).rejects.toBeInstanceOf(SessionExpiredError);
  });

  it('parses rows, sends periodo as a STRING (the wire trap, ADR-030)', async () => {
    const session = new FakePortalSession({
      requestJson: () => ({
        data: [
          { id: 134384543, titulo: 'Sobre Bienes Raíces Arrendados', dj: 1835, estados: { '2025': 'Observada', '2026': 'Aceptada' } },
          { id: 106094753, titulo: 'Sobre balance de 8 columnas y otros antecedentes.', dj: 1847, estados: { '2024': 'Observada' } },
        ],
        errorMsg: null,
      }),
    });

    const res = await fetchDjEstadoAnual(session, { rut: RUT, periodo: Anio.parse('2026') }, noPace);

    expect(res).toMatchObject({ rut: '11111111-1', periodo: '2026' });
    expect(res.rows).toHaveLength(2);
    expect(res.rows[0]).toEqual({
      id: 134384543,
      dj: 1835,
      titulo: 'Sobre Bienes Raíces Arrendados',
      estados: { '2025': 'Observada', '2026': 'Aceptada' },
    });
    // The wire trap: `periodo` MUST be sent as a JSON string, never a number.
    expect(session.lastRequest?.options?.body).toEqual({ periodo: '2026' });
  });

  it('a DJ with no obligation for a given año simply omits that key from `estados` — never null/0', async () => {
    const session = new FakePortalSession({
      requestJson: () => ({
        data: [{ id: 1, titulo: 'X', dj: 1926, estados: { '2024': 'Aceptada', '2025': 'Aceptada' } }],
        errorMsg: null,
      }),
    });

    const res = await fetchDjEstadoAnual(session, { rut: RUT, periodo: Anio.parse('2026') }, noPace);

    expect(res.rows[0]?.estados).not.toHaveProperty('2026');
    expect(Object.keys(res.rows[0]?.estados ?? {})).toEqual(['2024', '2025']);
  });

  it('an out-of-range periodo (SII\'s own "out of range" shape) raises DjError with the verbatim message', async () => {
    const session = new FakePortalSession({
      requestJson: () => ({ data: null, errorMsg: 'Se ha generado un error en getDjIntegralAnual' }),
    });

    await expect(
      fetchDjEstadoAnual(session, { rut: RUT, periodo: Anio.parse('2021') }, noPace),
    ).rejects.toThrow(/Se ha generado un error en getDjIntegralAnual/);
    await expect(
      fetchDjEstadoAnual(session, { rut: RUT, periodo: Anio.parse('2021') }, noPace),
    ).rejects.toBeInstanceOf(DjError);
  });

  it('the malformed-body error shape (`error`, not `errorMsg`) also raises DjError verbatim', async () => {
    const session = new FakePortalSession({
      requestJson: () => ({ error: 'Error en el formato del cuerpo de la solicitud. Verifique los tipos de datos enviados.' }),
    });

    await expect(
      fetchDjEstadoAnual(session, { rut: RUT, periodo: Anio.parse('2026') }, noPace),
    ).rejects.toThrow(/formato del cuerpo/);
  });

  it('estado values pass through verbatim — no closed enum, an unobserved value survives', async () => {
    const session = new FakePortalSession({
      requestJson: () => ({
        data: [{ id: 1, titulo: 'X', dj: 1948, estados: { '2025': 'Rechazada (nunca observado en vivo)' } }],
        errorMsg: null,
      }),
    });

    const res = await fetchDjEstadoAnual(session, { rut: RUT, periodo: Anio.parse('2026') }, noPace);

    expect(res.rows[0]?.estados['2025']).toBe('Rechazada (nunca observado en vivo)');
  });

  it('an unrecognized envelope shape is a DjError, never silently swallowed', async () => {
    const session = new FakePortalSession({ requestJson: () => ({ somethingElse: true }) });

    await expect(
      fetchDjEstadoAnual(session, { rut: RUT, periodo: Anio.parse('2026') }, noPace),
    ).rejects.toBeInstanceOf(DjError);
  });
});

describe('DJ historial facade — getDjIntegralAnualDetalle (ADR-031, fake session, no SII)', () => {
  it('sends periodo as a bare NUMBER — the OPPOSITE convention from fetchDjEstadoAnual (ADR-031)', async () => {
    const session = new FakePortalSession({
      requestJson: () => ({
        data: [
          {
            id: 1,
            titulo: 'Sobre Base imponible de primera categoría y datos contables balance',
            dj: 1926,
            result: [
              {
                key: 1001,
                codEstado: 2,
                estado: 'Aceptada',
                fecha: '2025-05-07T20:37:16',
                mes: null,
                mesNombre: null,
                folio: 599782,
                medioPresentacion: 'Formulario Electrónico',
                tipoDeclaracion: 'Rectificatoria',
                casos: 0,
              },
              {
                key: 1000,
                codEstado: 3,
                estado: 'Anulada',
                fecha: '2025-05-07T20:28:03',
                mes: null,
                mesNombre: null,
                folio: 599626,
                medioPresentacion: 'Formulario Electrónico',
                tipoDeclaracion: 'Original',
                casos: 0,
              },
            ],
          },
        ],
        errorMsg: null,
      }),
    });

    const res = await fetchDjHistorialAnual(session, { rut: RUT, periodo: Anio.parse('2025') }, noPace);

    expect(session.lastRequest?.options?.body).toEqual({ periodo: 2025 }); // NUMBER, not '2025'
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]?.presentaciones).toHaveLength(2);
    expect(res.rows[0]?.presentaciones[0]).toMatchObject({
      key: 1001,
      estado: 'Aceptada',
      folio: 599782,
      tipoDeclaracion: 'Rectificatoria',
    });
    // A real rectificatoria trail: the superseded folio is included, never dropped.
    expect(res.rows[0]?.presentaciones[1]).toMatchObject({
      key: 1000,
      estado: 'Anulada',
      folio: 599626,
      tipoDeclaracion: 'Original',
    });
  });

  it('an unrecognized envelope is a DjError', async () => {
    const session = new FakePortalSession({ requestJson: () => ({ nope: true }) });
    await expect(
      fetchDjHistorialAnual(session, { rut: RUT, periodo: Anio.parse('2025') }, noPace),
    ).rejects.toBeInstanceOf(DjError);
  });
});

describe('DJ detalle facade — detalle (ADR-031, fake session, no SII)', () => {
  // Synthetic but structurally faithful to the real capture (a real taxpayer account, DJ 1926, AT2025):
  // one "cabecera" row (column labels) + one "dato" row (real-shaped, synthetic figures) inside
  // one named section/table, PLUS one contactoRut:true cell to exercise redaction.
  const DETALLE_BODY = {
    data: {
      listDetalle: {
        'Seccion B': {
          detalle2: {
            tabla: {
              '01': {
                tipoCelda: 'cabecera',
                fila: {
                  '00': { value: 'N°', colspan: 1, rowspan: 1, style: 'fw-descripcionCampoCenter', contactoRut: false },
                  '04': { value: 'Monto del ajuste', colspan: 1, rowspan: 1, style: 'fw-descripcionCampoCenter', contactoRut: false },
                },
              },
              '02': {
                tipoCelda: 'dato',
                fila: {
                  '00': { value: '1', colspan: 1, rowspan: 1, style: 'fw-descripcionCampo', contactoRut: false },
                  '04': { value: '12.345.678', colspan: 1, rowspan: 1, style: 'fw-valorCampo', contactoRut: false },
                  '05': { value: 'SYNTHETIC RUT 11.111.111-1', colspan: 1, rowspan: 1, style: 'fw-valorCampo', contactoRut: true },
                },
              },
            },
          },
        },
      },
    },
    errorMsg: null,
  };

  it('sends the anual periodo as `<año>00`, plus dj/key/pagina/seccion/tipoConsulta/rut/dv (ADR-031)', async () => {
    const session = new FakePortalSession({ requestJson: () => DETALLE_BODY });

    const res = await fetchDjDetalle(
      session,
      { rut: RUT, anio: Anio.parse('2025'), dj: 1926, key: 122399351 },
      noPace,
    );

    expect(session.lastRequest?.options?.body).toEqual({
      periodo: '202500',
      dj: 1926,
      key: 122399351,
      pagina: 1,
      seccion: 1,
      tipoConsulta: 1,
      rut: '11111111',
      dv: '1',
    });
    expect(res).toMatchObject({ rut: '11111111-1', periodo: '202500', dj: 1926, key: 122399351 });
  });

  it('preserves the render-oriented table structure faithfully — no semantic re-modeling', async () => {
    const session = new FakePortalSession({ requestJson: () => DETALLE_BODY });

    const res = await fetchDjDetalle(
      session,
      { rut: RUT, anio: Anio.parse('2025'), dj: 1926, key: 122399351 },
      noPace,
    );

    expect(res.secciones).toHaveLength(1);
    const seccion = res.secciones[0]!;
    expect(seccion.nombre).toBe('Seccion B');
    expect(seccion.tablas).toHaveLength(1);
    const tabla = seccion.tablas[0]!;
    expect(tabla.nombre).toBe('detalle2');
    expect(tabla.filas['01']).toMatchObject({ tipoCelda: 'cabecera' });
    expect(tabla.filas['01']?.celdas['04']).toMatchObject({ value: 'Monto del ajuste' });
    // The "dato" row's monto sits at the SAME column index as the cabecera's label — the caller
    // aligns them by key, this facade does not reinterpret which column means what.
    expect(tabla.filas['02']?.celdas['04']).toMatchObject({ value: '12.345.678', contactoRut: false });
  });

  it('redacts value when contactoRut:true — SII\'s own PII flag, honored (ADR-031)', async () => {
    const session = new FakePortalSession({ requestJson: () => DETALLE_BODY });

    const res = await fetchDjDetalle(
      session,
      { rut: RUT, anio: Anio.parse('2025'), dj: 1926, key: 122399351 },
      noPace,
    );

    const celdaConRut = res.secciones[0]?.tablas[0]?.filas['02']?.celdas['05'];
    expect(celdaConRut?.contactoRut).toBe(true);
    expect(celdaConRut?.value).toBeNull(); // redacted — never leaks the RUT string
    expect(JSON.stringify(res)).not.toContain('11.111.111-1');
  });

  it('an unrecognized envelope is a DjError', async () => {
    const session = new FakePortalSession({ requestJson: () => ({ nope: true }) });
    await expect(
      fetchDjDetalle(session, { rut: RUT, anio: Anio.parse('2025'), dj: 1926, key: 1 }, noPace),
    ).rejects.toBeInstanceOf(DjError);
  });
});
