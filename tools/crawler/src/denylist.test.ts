import { describe, it, expect } from 'vitest';
import { matchDenylist, WRITE_DENYLIST } from './denylist.js';

// Cada caso pinnea el denylist contra un ejemplo REAL citado en
// docs/ESTADO-CONSOLIDADO.md §4.3 — el único gate real de seguridad del crawler (ADR-040).
describe('matchDenylist — el gate real de escritura (ADR-040)', () => {
  it('bloquea "Pagar" por URL (pagogiro-ui) y por texto visible', () => {
    expect(matchDenylist('https://www2.sii.cl/pagogiro-ui/', 'Ver detalle')).not.toBeNull();
    expect(matchDenylist('https://www4.sii.cl/rfiInternet/otra', 'Pagar en línea')).not.toBeNull();
  });

  it('bloquea declarar/rectificar F50', () => {
    expect(
      matchDenylist('https://www4.sii.cl/rfiInternet/declarar/index.html', 'Declarar'),
    ).not.toBeNull();
    expect(
      matchDenylist('https://www4.sii.cl/rfiInternet/rectificarF50/index.html', 'Rectificar'),
    ).not.toBeNull();
  });

  it('bloquea SOLO ?opc=dec de sistgiInternet, nunca ?opc=con (la consulta de solo lectura)', () => {
    expect(
      matchDenylist('https://www4.sii.cl/sistgiInternet/?opc=dec', 'Continuar'),
    ).not.toBeNull();
    expect(matchDenylist('https://www4.sii.cl/sistgiInternet/?opc=con', 'Consultar')).toBeNull();
  });

  it('bloquea generar/anular carpeta tributaria', () => {
    expect(
      matchDenylist('https://www2.sii.cl/carpetatributaria/generarcteregular', 'Continuar'),
    ).not.toBeNull();
    expect(matchDenylist('https://www2.sii.cl/carpetatributaria/cteregular', 'Anular')).not.toBeNull();
    // La consulta de solo lectura del mismo módulo (ADR-033) NO debe bloquearse.
    expect(
      matchDenylist('https://www2.sii.cl/app/cte-api-carpetatributaria', 'Ver historial'),
    ).toBeNull();
  });

  it('bloquea toda la app de aceptar/reclamar DTE, no solo el botón', () => {
    expect(
      matchDenylist('https://www4.sii.cl/registrorechazodtej6ui/#/consulta', 'Ver folio'),
    ).not.toBeNull();
    expect(matchDenylist('https://www4.sii.cl/otraapp', 'Aceptar')).not.toBeNull();
  });

  it('bloquea SOLO opc=114 de CViewCarta.cgi, nunca los opc de lectura ya usados (118/22/112/41)', () => {
    const base = 'https://misiir.sii.cl/cgi_misii/CViewCarta.cgi';
    expect(matchDenylist(`${base}?opc=114`, 'Ingresar correo Vigente')).not.toBeNull();
    expect(matchDenylist(`${base}?opc=118`, 'Obligaciones Tributarias')).toBeNull();
    expect(matchDenylist(`${base}?opc=41`, 'Mis Notificaciones Vigentes')).toBeNull();
  });

  it('bloquea declarar/rectificar renta (F22)', () => {
    expect(matchDenylist('https://www2.sii.cl/navegacionf22/', 'Declarar Renta')).not.toBeNull();
    expect(
      matchDenylist(
        'https://alerce.sii.cl/dior_cgi/ren_mp/REN_MenusRenta.cgi?opcion=1',
        'Rectificar',
      ),
    ).not.toBeNull();
  });

  it('NO bloquea superficies de lectura ya validadas del proyecto', () => {
    expect(matchDenylist('https://www4.sii.cl/rfiInternet/?opcionPagina=ConsultaGiros', 'Consultar giros')).toBeNull();
    expect(matchDenylist('https://misiir.sii.cl/cgi_misii/siihome.cgi', 'Mi SII')).toBeNull();
    expect(matchDenylist('https://www2.sii.cl/app/djconsulta/77777777/recurso/v1/dj/estado', 'Ver DJ')).toBeNull();
  });

  it('bloquea el logout (termina la sesión que el crawler necesita)', () => {
    expect(
      matchDenylist('https://zeusr.sii.cl/cgi_AUT2000/autTermino.cgi', 'Salir'),
    ).not.toBeNull();
    expect(matchDenylist('https://misiir.sii.cl/cgi_misii/siihome.cgi', 'Cerrar sesión')).not.toBeNull();
  });

  it('cada entrada del denylist tiene al menos un patrón (url o texto) y una cita', () => {
    for (const entry of WRITE_DENYLIST) {
      expect(entry.patronUrl !== null || entry.patronTexto !== null).toBe(true);
      expect(entry.fuente.length).toBeGreaterThan(0);
    }
  });
});
