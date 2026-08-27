import { describe, it, expect } from 'vitest';
import { FakePortalSession } from '../adapters/fake/index.js';
import { Rut } from '../rut/index.js';
import { NotificacionesError } from '../errors/index.js';
import { fetchComunicacionDetalle, fetchComunicacionesList } from './notificaciones.js';

// Synthetic RUT only (no SII, no real PII).
const RUT = Rut.parse('11111111-1');

describe('notificaciones facade (fake session, synthetic JSON, no SII)', () => {
  it('lists FORMAL notifications (opc=41) and curates every field', async () => {
    const body = JSON.stringify({
      estado: 0,
      glosa: 'OK',
      data: [
        {
          id: '999',
          descripcion: 'Citación Art. 63',
          fecha: 1700000000000,
          periodo: null,
          tipo: '9',
          descTipo: 'CITACION',
          origen: null,
          tipoNotificacion: 'Por Página Web',
        },
      ],
      metaData: { page: { fullSize: 1, currentPageIndex: 1, pageSize: 1000, lastPageIndex: 1 } },
    });
    const session = new FakePortalSession({ requestForm: () => body });

    const res = await fetchComunicacionesList(session, { rut: RUT, categoria: 'FORMAL' });

    expect(res).toMatchObject({ rut: '11111111-1', categoria: 'FORMAL', masPaginas: false });
    expect(res.items).toEqual([
      {
        id: 999,
        fechaEpochMs: 1700000000000,
        descripcion: 'Citación Art. 63',
        tipo: '9',
        tipoNotificacion: 'Por Página Web',
        descTipo: 'CITACION',
        origen: null,
        periodo: null,
      },
    ]);
    expect(session.lastFormRequest?.options?.form).toMatchObject({ opc: '41', VIEW: '1' });
  });

  it('lists CORRESPONDENCIA (opc=40) using the same envelope shape', async () => {
    const body = JSON.stringify({
      estado: 0,
      glosa: 'OK',
      data: [
        {
          id: '5790241',
          descripcion: 'Petición administrativa recibida',
          fecha: 1629864000000,
          periodo: null,
          tipo: '4',
          descTipo: 'MAQUINA',
          origen: 'EMAIL',
          tipoNotificacion: 'Correo Electrónico',
        },
      ],
      metaData: { page: { fullSize: 1, currentPageIndex: 1, pageSize: 1000, lastPageIndex: 1 } },
    });
    const session = new FakePortalSession({ requestForm: () => body });

    const res = await fetchComunicacionesList(session, { rut: RUT, categoria: 'CORRESPONDENCIA' });

    expect(res.categoria).toBe('CORRESPONDENCIA');
    expect(res.items[0]).toMatchObject({ id: 5790241, descTipo: 'MAQUINA', origen: 'EMAIL' });
    expect(session.lastFormRequest?.options?.form).toMatchObject({ opc: '40', VIEW: '1' });
  });

  it('estado=1403 "No existen registros" is a legitimate empty result, not an error', async () => {
    const body = JSON.stringify({ estado: 1403, glosa: 'No existen registros', data: [], metaData: null });
    const session = new FakePortalSession({ requestForm: () => body });

    const res = await fetchComunicacionesList(session, { rut: RUT, categoria: 'FORMAL' });

    expect(res.items).toEqual([]);
    expect(res.masPaginas).toBe(false);
  });

  it('flags masPaginas from metaData.page when more pages exist', async () => {
    const body = JSON.stringify({
      estado: 0,
      glosa: 'OK',
      data: [],
      metaData: { page: { fullSize: 2000, currentPageIndex: 1, pageSize: 1000, lastPageIndex: 2 } },
    });
    const session = new FakePortalSession({ requestForm: () => body });

    const res = await fetchComunicacionesList(session, { rut: RUT, categoria: 'FORMAL' });

    expect(res.masPaginas).toBe(true);
  });

  it('an unrecognized estado raises NotificacionesError with the verbatim glosa', async () => {
    const body = JSON.stringify({ estado: 500, glosa: 'Error interno inesperado', data: null, metaData: null });
    const session = new FakePortalSession({ requestForm: () => body });

    await expect(fetchComunicacionesList(session, { rut: RUT, categoria: 'FORMAL' })).rejects.toThrow(
      NotificacionesError,
    );
    await expect(fetchComunicacionesList(session, { rut: RUT, categoria: 'FORMAL' })).rejects.toThrow(
      /Error interno inesperado/,
    );
  });

  it('a non-JSON response (login wall style) raises NotificacionesError, not a crash', async () => {
    const session = new FakePortalSession({ requestForm: () => '<html>not json</html>' });
    await expect(fetchComunicacionesList(session, { rut: RUT, categoria: 'FORMAL' })).rejects.toBeInstanceOf(
      NotificacionesError,
    );
  });

  it('fetches CORRESPONDENCIA detail (opc=42), curates body/asunto/from/to, drops attachment payloads', async () => {
    const body = JSON.stringify({
      estado: 0,
      glosa: 'OK',
      data: {
        from: null,
        to: 'contacto@empresa.cl',
        asunto: 'Petición administrativa recibida',
        adjunto: [{ data: 'QkFTRTY0Q09OVEVOVA==', name: 'certificado.pdf' }],
        body: '<html><body>texto de la carta</body></html>',
      },
      metaData: { page: null },
    });
    const session = new FakePortalSession({ requestForm: () => body });

    const res = await fetchComunicacionDetalle(session, {
      rut: RUT,
      categoria: 'CORRESPONDENCIA',
      id: 5790241,
      tipo: '4',
    });

    expect(res).toMatchObject({
      rut: '11111111-1',
      categoria: 'CORRESPONDENCIA',
      id: 5790241,
      tipo: '4',
      asunto: 'Petición administrativa recibida',
      from: null,
      to: 'contacto@empresa.cl',
      bodyHtml: '<html><body>texto de la carta</body></html>',
      tieneCertificado: false,
    });
    expect(res.adjuntos).toEqual([{ nombre: 'certificado.pdf' }]);
    // No base64 payload ever leaves the facade.
    expect(JSON.stringify(res)).not.toContain('QkFTRTY0Q09OVEVOVA==');
    expect(session.lastFormRequest?.options?.form).toMatchObject({
      opc: '42',
      MODE: '4',
      repoId: '5790241',
    });
  });

  it('fetches FORMAL detail (opc=43)', async () => {
    const body = JSON.stringify({
      estado: 0,
      glosa: 'OK',
      data: { from: null, to: 'contacto@empresa.cl', asunto: 'Citación', adjunto: [], body: '<p>cita</p>' },
      metaData: { page: null },
    });
    const session = new FakePortalSession({ requestForm: () => body });

    await fetchComunicacionDetalle(session, { rut: RUT, categoria: 'FORMAL', id: 1, tipo: '9' });

    expect(session.lastFormRequest?.options?.form).toMatchObject({ opc: '43', MODE: '9', repoId: '1' });
  });

  it('a top-level certificado sets tieneCertificado true and is never surfaced', async () => {
    const body = JSON.stringify({
      estado: 0,
      glosa: 'OK',
      data: { from: null, to: null, asunto: null, adjunto: [], body: null },
      certificado: 'QkFTRTY0Q0VSVA==',
      metaData: { page: null },
    });
    const session = new FakePortalSession({ requestForm: () => body });

    const res = await fetchComunicacionDetalle(session, {
      rut: RUT,
      categoria: 'CORRESPONDENCIA',
      id: 1,
      tipo: '4',
    });

    expect(res.tieneCertificado).toBe(true);
    expect(JSON.stringify(res)).not.toContain('QkFTRTY0Q0VSVA==');
  });
});
