import { describe, it, expect } from 'vitest';
import { buildReportMarkdown } from './report.js';
import type { CrawlResult } from './types.js';

const RESULT: CrawlResult = {
  paginas: [
    {
      url: 'https://misiir.sii.cl/cgi_misii/siihome.cgi',
      titulo: 'Mi SII',
      html: '<html>conocida</html>',
      headers: {},
      links: [],
      recursos: [],
      profundidad: 0,
      capturedAt: '2026-08-05T12:00:00.000Z',
      resumenLlm: 'QUÉ ES: portada de Mi SII\nOTRA LÍNEA',
    },
    {
      url: 'https://www4.sii.cl/algo-nunca-visto/',
      titulo: 'Algo Nuevo',
      html: '<html>nueva</html>',
      headers: {},
      links: [],
      recursos: [],
      profundidad: 1,
      capturedAt: '2026-08-05T12:00:01.000Z',
      resumenLlm: 'QUÉ ES: parece un formulario\nPOSIBLE_ESCRITURA: SI — tiene un botón Guardar',
    },
  ],
  omitidos: [
    { href: 'https://www2.sii.cl/pagogiro-ui/', texto: 'Pagar', razon: 'denylist', denylistNombre: 'Pagar giros' },
    { href: 'javascript:hacer()', texto: 'Click', razon: 'javascript-href' },
  ],
  errores: [{ url: 'https://www4.sii.cl/roto', mensaje: 'timeout' }],
};

describe('buildReportMarkdown (ADR-040)', () => {
  it('marca como candidato nuevo solo la URL no catalogada', () => {
    const md = buildReportMarkdown(RESULT, '2026-08-05T12:05:00.000Z');
    expect(md).toContain('Candidatos NUEVOS');
    expect(md).toContain('https://www4.sii.cl/algo-nunca-visto/');
    expect(md).not.toContain('### https://misiir.sii.cl/cgi_misii/siihome.cgi');
  });

  it('incluye el resumen del LLM marcado como señal no autoritativa', () => {
    const md = buildReportMarkdown(RESULT, '2026-08-05T12:05:00.000Z');
    expect(md).toContain('señal NO autoritativa');
    expect(md).toContain('POSIBLE_ESCRITURA: SI');
  });

  it('lista los links bloqueados por el denylist', () => {
    const md = buildReportMarkdown(RESULT, '2026-08-05T12:05:00.000Z');
    expect(md).toContain('Pagar giros');
    expect(md).toContain('pagogiro-ui');
  });

  it('lista los handlers javascript: encontrados, marcando que nunca se ejecutan', () => {
    const md = buildReportMarkdown(RESULT, '2026-08-05T12:05:00.000Z');
    expect(md).toContain('NUNCA ejecutados');
    expect(md).toContain('javascript:hacer()');
  });

  it('lista los errores', () => {
    const md = buildReportMarkdown(RESULT, '2026-08-05T12:05:00.000Z');
    expect(md).toContain('timeout');
  });

  it('marca con 🆕 solo las páginas no catalogadas en el listado completo', () => {
    const md = buildReportMarkdown(RESULT, '2026-08-05T12:05:00.000Z');
    const bullets = md.split('\n').filter((l) => l.startsWith('- [profundidad'));
    const lineaConocida = bullets.find((l) => l.includes('siihome.cgi'));
    const lineaNueva = bullets.find((l) => l.includes('algo-nunca-visto'));
    expect(lineaConocida).not.toContain('🆕');
    expect(lineaNueva).toContain('🆕');
  });

  it('muestra la primera línea del resumen LLM también para una página YA conocida', () => {
    const md = buildReportMarkdown(RESULT, '2026-08-05T12:05:00.000Z');
    expect(md).toContain('QUÉ ES: portada de Mi SII');
    // Solo la primera línea, no el resumen completo repetido en esa sección.
    const seccionTodas = md.split('## Todas las páginas capturadas')[1] ?? '';
    expect(seccionTodas).not.toContain('OTRA LÍNEA');
  });
});
