import { describe, it, expect } from 'vitest';
import { FakePortalSession } from '../adapters/fake/index.js';
import { Rut } from '../rut/index.js';
import { CarpetaTributariaError, SessionExpiredError } from '../errors/index.js';
import { fetchCarpetaTributariaHistorial } from './carpeta.js';

const RUT = Rut.parse('77.777.777-7');
const noPace = (): Promise<void> => Promise.resolve();

// Synthetic row shaped like the real 2026-08-03 capture (docs/sii-contract/carpeta-tributaria.md),
// values changed to obviously-fake data.
function row(opts: {
  codigoRepositorio: number;
  claveCarpeta: string;
  fechaGeneracion: string;
  receptorNombre: string;
  receptorRut: number;
  receptorDv: string;
  estado: number;
  fechaAnulacion: string | null;
  parametros: Record<string, unknown>;
}): unknown {
  return {
    carpetaTributaria: {
      carpRutContribuyente: 77777777,
      carpDvContribuyente: '7',
      carpCodigoRepositorio: opts.codigoRepositorio,
      carpClaveCarpeta: opts.claveCarpeta,
      carpCodigoBarras: ' ',
      carpFechaGeneracion: opts.fechaGeneracion,
      carpNombreArchivo: 'Carpeta_77026694.pdf',
      carpNombreReceptor: opts.receptorNombre,
      carpRutReceptor: opts.receptorRut,
      carpDvReceptor: opts.receptorDv,
      carpEstado: opts.estado,
      carpTipo: 1,
      enfinCodigo: '000',
      carpCodigoXml: 0,
      carpComentario: null,
      carpUnidadFuncionario: null,
      carpRutFuncionario: 0,
      carpDvFuncionario: null,
      carpFechaAnulacion: opts.fechaAnulacion,
      carpOtraInstitucion: '1',
      carpNombreOtraInstitucion: '1',
      carpFechaVencimiento: '2027-01-20',
      carpParametros: JSON.stringify(opts.parametros),
      dlInicioVigencia: opts.fechaGeneracion,
      dlUltimaModificacionVigencia: opts.fechaGeneracion,
      dlFinVigencia: null,
    },
    enfinDescripcion: 'OTRA INSTITUCIÓN',
    enfinAbreviacion: 'OTRA INSTITUCIÓN',
    revCantidad: 0,
    revFechaUltimaRevision: null,
  };
}

describe('carpeta tributaria facade (fake session, synthetic JSON, no SII)', () => {
  it('lists the historial, curates every field, and parses carpParametros', async () => {
    const body = JSON.stringify([
      row({
        codigoRepositorio: 30000001,
        claveCarpeta: 'XXXXXXXXXX',
        fechaGeneracion: '2026-01-20',
        receptorNombre: 'Empresa A SpA',
        receptorRut: 77777777,
        receptorDv: '7',
        estado: 1,
        fechaAnulacion: null,
        parametros: { representanteLegal: true, periodoFormulario29: 36, periodoCarpetaTributaria: 365 },
      }),
    ]);
    const session = new FakePortalSession({ requestJson: () => JSON.parse(body) });

    const res = await fetchCarpetaTributariaHistorial(session, { rut: RUT }, noPace);

    expect(res).toMatchObject({ rut: '77777777-7', anio: null });
    expect(res.items).toHaveLength(1);
    expect(res.items[0]).toMatchObject({
      codigoRepositorio: 30000001,
      claveCarpeta: 'XXXXXXXXXX',
      fechaGeneracion: '2026-01-20',
      estado: 1,
      tipo: 1,
      receptorNombre: 'Empresa A SpA',
      receptorRut: '77777777',
      receptorDv: '7',
      fechaAnulacion: null,
      institucionCodigo: '000',
      institucionDescripcion: 'OTRA INSTITUCIÓN',
    });
    expect(res.items[0]?.parametros).toMatchObject({
      representanteLegal: true,
      periodoFormulario29: 36,
      periodoCarpetaTributaria: 365,
    });
  });

  it('passes estado verbatim (no closed enum) — a real anulada row (estado 3) is not adjudicated', async () => {
    const body = JSON.stringify([
      row({
        codigoRepositorio: 1,
        claveCarpeta: 'AAA',
        fechaGeneracion: '2025-01-01',
        receptorNombre: 'Empresa A SpA',
        receptorRut: 77777777,
        receptorDv: '7',
        estado: 3,
        fechaAnulacion: '2025-02-01',
        parametros: {},
      }),
    ]);
    const session = new FakePortalSession({ requestJson: () => JSON.parse(body) });

    const res = await fetchCarpetaTributariaHistorial(session, { rut: RUT }, noPace);

    expect(res.items[0]).toMatchObject({ estado: 3, fechaAnulacion: '2025-02-01' });
  });

  it('surfaces a third-party receptor (a bank contact, not the taxpayer) verbatim', async () => {
    const body = JSON.stringify([
      row({
        codigoRepositorio: 2,
        claveCarpeta: 'BBB',
        fechaGeneracion: '2026-03-04',
        receptorNombre: 'MARTA CONTACTO BANCARIO',
        receptorRut: 26594257,
        receptorDv: '1',
        estado: 1,
        fechaAnulacion: null,
        parametros: {},
      }),
    ]);
    const session = new FakePortalSession({ requestJson: () => JSON.parse(body) });

    const res = await fetchCarpetaTributariaHistorial(session, { rut: RUT }, noPace);

    expect(res.items[0]).toMatchObject({ receptorNombre: 'MARTA CONTACTO BANCARIO', receptorRut: '26594257' });
  });

  it('an empty historial is a clean 0-item result, not an error', async () => {
    const session = new FakePortalSession({ requestJson: () => [] });

    const res = await fetchCarpetaTributariaHistorial(session, { rut: RUT }, noPace);

    expect(res.items).toEqual([]);
  });

  it('sends the anio filter as a query param when given', async () => {
    const session = new FakePortalSession({ requestJson: () => [] });

    const res = await fetchCarpetaTributariaHistorial(session, { rut: RUT, anio: '2025' }, noPace);

    expect(res.anio).toBe('2025');
    expect(session.lastRequest?.url).toContain('agno=2025');
  });

  it('bootstraps with a goto to the UI page before the GET (same precondition shape as DJ)', async () => {
    const session = new FakePortalSession({ requestJson: () => [] });

    await fetchCarpetaTributariaHistorial(session, { rut: RUT }, noPace);

    expect(session.gotos[0]).toContain('carpetatributaria/cteregular');
  });

  it('a dead session (goto lands on the login host) raises SessionExpiredError', async () => {
    const session = new FakePortalSession({ landingUrl: 'https://zeusr.sii.cl/AUT2000/x.html' });
    await expect(fetchCarpetaTributariaHistorial(session, { rut: RUT }, noPace)).rejects.toBeInstanceOf(
      SessionExpiredError,
    );
  });

  it('a non-JSON / non-array response raises CarpetaTributariaError', async () => {
    const session = new FakePortalSession({ requestJson: () => ({ unexpected: 'shape' }) });
    await expect(fetchCarpetaTributariaHistorial(session, { rut: RUT }, noPace)).rejects.toBeInstanceOf(
      CarpetaTributariaError,
    );
  });
});
