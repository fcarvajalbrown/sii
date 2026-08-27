import { describe, it, expect } from 'vitest';
import { FakePortalSession } from '../adapters/fake/index.js';
import { SituacionError } from '../errors/index.js';
import {
  fetchCumplimientoCot,
  fetchPerfilCompleto,
  fetchPerfilContribuyente,
  fetchRegimenes,
} from './situacion.js';

/** Reparte por el `opc` del form, como hace el CGI real. */
function session(byOpc: Record<string, unknown>): FakePortalSession {
  return new FakePortalSession({
    requestForm: (_url, options) => {
      const opc = options?.form?.['opc'] ?? '';
      if (!(opc in byOpc)) throw new Error(`opc inesperado: ${opc}`);
      const v = byOpc[opc];
      return typeof v === 'string' ? v : JSON.stringify(v);
    },
  });
}

describe('situación — cumplimiento Ley COT (opc=118)', () => {
  const COT = {
    semestreActual: '',
    atributos: [
      {
        atrCodigo: 'NDIR',
        cumple: 'SI',
        condicion: 'B',
        titulo: 'No tener atrasos en declaración de IVA y/o Renta',
        // Ligadura PUA real de SII: U+10019F = "ti"
        descripcion: 'no has presentado, a lo menos en \u{10019F}empo y forma',
      },
      { atrCodigo: 'DQDT', cumple: 'NO', condicion: 'C', titulo: 'No tener denuncias', descripcion: 'x' },
    ],
    historicos: null,
    estado: 'Cumple sus obligaciones tributarias',
    mostrarObligacionTributaria: '1',
  };

  it('cura el estado verbatim y cada requisito con su cumple booleano', async () => {
    const res = await fetchCumplimientoCot(session({ '118': COT }));

    expect(res.estado).toBe('Cumple sus obligaciones tributarias');
    expect(res.requisitos).toHaveLength(2);
    expect(res.requisitos[0]).toMatchObject({
      codigo: 'NDIR',
      condicion: 'B',
      cumple: true,
      cumpleTexto: 'SI',
      titulo: 'No tener atrasos en declaración de IVA y/o Renta',
    });
    expect(res.requisitos[1]).toMatchObject({ codigo: 'DQDT', cumple: false, cumpleTexto: 'NO' });
  });

  it('normaliza las ligaduras PUA con las que SII corrompe su propio texto', async () => {
    const res = await fetchCumplimientoCot(session({ '118': COT }));

    expect(res.requisitos[0]?.descripcion).toBe('no has presentado, a lo menos en tiempo y forma');
    expect(res.requisitos[0]?.descripcion).not.toMatch(/[\u{E000}-\u{10FFFF}]/u);
  });

  it('un `cumple` no observado no se coerce a booleano', async () => {
    const res = await fetchCumplimientoCot(
      session({ '118': { ...COT, atributos: [{ atrCodigo: 'X', cumple: 'PARCIAL' }] } }),
    );
    expect(res.requisitos[0]).toMatchObject({ cumple: null, cumpleTexto: 'PARCIAL' });
  });

  it('una respuesta no-JSON es SituacionError, nunca un crash', async () => {
    await expect(fetchCumplimientoCot(session({ '118': '<html>login</html>' }))).rejects.toBeInstanceOf(
      SituacionError,
    );
  });
});

describe('situación — régimen tributario (opc=22)', () => {
  const REG = {
    codigoError: 0,
    atributos: [
      {
        rut: 77777777,
        dv: '7',
        atrCodigo: 'M14A',
        descAtrCodigo: 'REGIMEN GENERAL SEMI INTEGRADO (14A)',
        fechaInicio: '01-01-2022',
        fechaTermino: null,
        valor: 'PR2022 Ingresos Promedio Mayor a 75.000 UF',
        usuarioActivacion: 'S6080300',
      },
    ],
  };

  it('cura el régimen y DESCARTA el identificador del funcionario SII', async () => {
    const res = await fetchRegimenes(session({ '22': REG }));

    expect(res).toEqual([
      {
        codigo: 'M14A',
        descripcion: 'REGIMEN GENERAL SEMI INTEGRADO (14A)',
        fechaInicio: '01-01-2022',
        fechaTermino: null,
        detalle: 'PR2022 Ingresos Promedio Mayor a 75.000 UF',
      },
    ]);
    // El id de funcionario del SII es PII interna — nunca sale (ADR-006, igual que peticiones).
    expect(JSON.stringify(res)).not.toContain('S6080300');
  });

  it('sin atributos devuelve lista vacía, no error', async () => {
    const res = await fetchRegimenes(session({ '22': { codigoError: 0, atributos: [] } }));
    expect(res).toEqual([]);
  });
});

describe('situación — perfil del contribuyente (opc=112)', () => {
  const PERFIL = {
    codigoError: 0,
    descripcionError: 'OK',
    contribuyente: {
      rut: 77777777,
      dv: '7',
      razonSocial: 'Empresa A SpA',
      tipoContribuyenteDescripcion: 'PERSONA JURIDICA COMERCIAL',
      subtipoContribuyenteDescrip: 'SOCIEDAD POR ACCIONES',
      segmentoDescripcion: 'GRAN EMPRESA',
      glosaActividad: 'VENTA MAT CONSTRUCCION',
      fechaConstitucion: '2019-06-11 00:00:00.0',
      fechaInicioActividades: '2019-06-19 00:00:00.0',
      fechaTerminoGiro: null,
      eMail: 'contacto@empresa.cl',
      telefonoMovil: '+56900000000',
      autorizadoDeclararDia20: 'S',
    },
    actEcos: [
      {
        codigo: 466302,
        descripcion: 'VENTA AL POR MAYOR DE MATERIALES DE CONSTRUCCION',
        categoriaTributaria: 1,
        afectoIva: 'S',
        fechaInicio: '19-06-2019',
      },
    ],
    timbrajes: [{ codigo: 33, descripcion: 'FACTURA ELECTRONICA', fechaLegalizacion: '30-07-2026' }],
    // PII de terceros — el facade NO debe exponerlos (ADR-035).
    socios: [{ rut: 11111111, dv: '1', razonSocial: 'SOCIO UNO', participacionCapital: 50 }],
    representantes: [{ rut: 22222222, dv: '2', razonSocial: 'REPRESENTANTE LEGAL' }],
    direcciones: [{ calle: 'CALLE SECRETA', numero: '123', rutPropietario: 33333333 }],
  };

  it('cura la identidad propia y expone fechaInicioActividades (el dato que monitor.ts no tenía)', async () => {
    const res = await fetchPerfilContribuyente(session({ '112': PERFIL }));

    expect(res).toMatchObject({
      razonSocial: 'Empresa A SpA',
      tipoContribuyente: 'PERSONA JURIDICA COMERCIAL',
      subtipoContribuyente: 'SOCIEDAD POR ACCIONES',
      segmento: 'GRAN EMPRESA',
      fechaInicioActividades: '2019-06-19 00:00:00.0',
      fechaConstitucion: '2019-06-11 00:00:00.0',
      fechaTerminoGiro: null,
      autorizadoDeclararDia20: true,
    });
  });

  it('cura autorizadoDeclararDia20 (define si el plazo F29 es el día 12 o el 20)', async () => {
    const res = await fetchPerfilContribuyente(session({ '112': PERFIL }));
    expect(res.autorizadoDeclararDia20).toBe(true);
  });

  it('un autorizadoDeclararDia20 no observado ("N" o ausente) no se coerce a true', async () => {
    const noAutorizado = {
      ...PERFIL,
      contribuyente: { ...PERFIL.contribuyente, autorizadoDeclararDia20: 'N' },
    };
    const res = await fetchPerfilContribuyente(session({ '112': noAutorizado }));
    expect(res.autorizadoDeclararDia20).toBe(false);

    const sinCampo = { ...PERFIL, contribuyente: { ...PERFIL.contribuyente } };
    // @ts-expect-error borrando el campo a propósito para simular ausencia
    delete sinCampo.contribuyente.autorizadoDeclararDia20;
    const res2 = await fetchPerfilContribuyente(session({ '112': sinCampo }));
    expect(res2.autorizadoDeclararDia20).toBeNull();
  });

  it('cura actividades económicas y timbrajes', async () => {
    const res = await fetchPerfilContribuyente(session({ '112': PERFIL }));

    expect(res.actividades[0]).toEqual({
      codigo: '466302',
      descripcion: 'VENTA AL POR MAYOR DE MATERIALES DE CONSTRUCCION',
      categoriaTributaria: 1,
      afectoIva: true,
      fechaInicio: '19-06-2019',
    });
    expect(res.timbrajes[0]).toEqual({
      codigo: '33',
      descripcion: 'FACTURA ELECTRONICA',
      fechaLegalizacion: '30-07-2026',
    });
  });

  it('NUNCA expone socios, representantes ni direcciones (PII de terceros, ADR-035)', async () => {
    const res = await fetchPerfilContribuyente(session({ '112': PERFIL }));
    const json = JSON.stringify(res);

    expect(json).not.toContain('SOCIO UNO');
    expect(json).not.toContain('REPRESENTANTE LEGAL');
    expect(json).not.toContain('CALLE SECRETA');
    expect(json).not.toContain('11111111');
    expect(json).not.toContain('33333333');
    expect(res).not.toHaveProperty('socios');
    expect(res).not.toHaveProperty('representantes');
    expect(res).not.toHaveProperty('direcciones');
    // Pero SÍ informa cuántos hay, sin identificarlos.
    expect(res.conteos).toEqual({ socios: 1, representantes: 1, direcciones: 1 });
  });

  it('tampoco expone email ni teléfono propios en esta superficie (van en `whoami`)', async () => {
    const res = await fetchPerfilContribuyente(session({ '112': PERFIL }));
    expect(JSON.stringify(res)).not.toContain('contacto@empresa.cl');
    expect(JSON.stringify(res)).not.toContain('+56900000000');
  });
});

// Nombres de campo REALES observados en vivo 2026-08-05 (a real taxpayer account, ver ADR-041) —
// valores aquí son SINTÉTICOS (ADR-006: tests nunca llevan PII real de terceros).
describe('situación — perfil COMPLETO con socios/representantes/direcciones (opc=112, ADR-041)', () => {
  const PERFIL_COMPLETO = {
    contribuyente: {
      razonSocial: 'MI EMPRESA SPA',
      tipoContribuyenteDescripcion: 'PERSONA JURIDICA COMERCIAL',
    },
    actEcos: [],
    timbrajes: [],
    socios: [
      {
        codigoError: 0,
        descripcionError: 'Contribuyente  posee socios',
        sysdate: null,
        index: 0,
        rut: '11111111',
        dv: '1',
        fechaIncorporacion: '2020-01-01 00:00:00.0',
        fechaFinParticipacion: null,
        sraGpk: null,
        sraNdr: null,
        participacionCapital: '50.00',
        participacionUtilidades: '50.00',
        porcentajeAtribucion: null,
        razonSocial: 'SOCIO UNO SPA',
        nombres: null,
        apellidoPaterno: null,
        apellidoMaterno: null,
        vigente: 'S',
      },
    ],
    representantes: [
      {
        codigoError: 0,
        descripcionError: 'Contribuyente posee representantes',
        sysdate: null,
        rut: '22222222',
        dv: '2',
        fechaInicio: '2019-06-11 00:00:00.0',
        fechaTermino: null,
        razonSocial: null,
        nombres: 'JUAN',
        apellidoPaterno: 'PEREZ',
        apellidoMaterno: 'SOTO',
        vigente: 'S',
      },
    ],
    direcciones: [
      {
        codigo: '1',
        calle: 'CALLE FICTICIA 123',
        numero: null,
        comunaDescripcion: 'SANTIAGO',
        regionDescripcion: 'REGION METROPOLITANA',
        tipoDomicilioDescripcion: 'DOMICILIO',
        tipoPropiedadDescripcion: 'ARRENDADO NOTARIAL',
        rutPropietario: '33333333',
        dvPropietario: '3',
        telefono: null,
        canon: '5000',
        fechaModiRegistro: '2024-01-01 00:00:00.0',
      },
    ],
  };

  it('cura socios con RUT, nombre/razón social, participación y vigencia', async () => {
    const res = await fetchPerfilCompleto(session({ '112': PERFIL_COMPLETO }));

    expect(res.socios).toEqual([
      {
        rut: '11111111',
        dv: '1',
        nombre: 'SOCIO UNO SPA',
        participacionCapital: 50,
        participacionUtilidades: 50,
        fechaIncorporacion: '2020-01-01 00:00:00.0',
        fechaFinParticipacion: null,
        vigente: true,
      },
    ]);
  });

  it('cura representantes con RUT y nombre completo (nombres + apellidos, no razón social)', async () => {
    const res = await fetchPerfilCompleto(session({ '112': PERFIL_COMPLETO }));

    expect(res.representantes).toEqual([
      {
        rut: '22222222',
        dv: '2',
        nombre: 'JUAN PEREZ SOTO',
        fechaInicio: '2019-06-11 00:00:00.0',
        fechaTermino: null,
        vigente: true,
      },
    ]);
  });

  it('cura el domicilio propio SIEMPRE, pero rutPropietario/dvPropietario son campos separados', async () => {
    const res = await fetchPerfilCompleto(session({ '112': PERFIL_COMPLETO }));

    expect(res.direcciones).toEqual([
      {
        calle: 'CALLE FICTICIA 123',
        comuna: 'SANTIAGO',
        region: 'REGION METROPOLITANA',
        tipoDomicilio: 'DOMICILIO',
        tipoPropiedad: 'ARRENDADO NOTARIAL',
        telefono: null,
        rutPropietario: '33333333',
        dvPropietario: '3',
      },
    ]);
  });

  it('vigente "S"/"N" se cura a booleano, nunca se asume otro valor', async () => {
    const conNoVigente = {
      ...PERFIL_COMPLETO,
      socios: [{ ...PERFIL_COMPLETO.socios[0], vigente: 'N' }],
    };
    const res = await fetchPerfilCompleto(session({ '112': conNoVigente }));
    expect(res.socios[0]?.vigente).toBe(false);
  });
});
