import { describe, it, expect } from 'vitest';
import { testing, NotAuthenticatedError, type Runtime } from '@dostertags/sii-core';
import { writeSession } from '@dostertags/sii-core/node';
import { crawl } from './crawl.js';

const HOME = 'https://misiir.sii.cl/cgi_misii/siihome.cgi';
const PAGE_A = 'https://misiir.sii.cl/cgi_misii/pageA.cgi';
const PAGE_B = 'https://www4.sii.cl/pageB';
const EXTERNAL = 'https://www.google.com/';
const PAGO_GIRO = 'https://www2.sii.cl/pagogiro-ui/';

/** Fixture por URL: qué links "tiene" cada página simulada. */
const SITE: Record<string, { href: string; texto: string }[]> = {
  [HOME]: [
    { href: PAGE_A, texto: 'Página A' },
    { href: EXTERNAL, texto: 'Sitio externo' },
    { href: PAGO_GIRO, texto: 'Pagar giro' },
    { href: 'javascript:hacerAlgo()', texto: 'Acción JS' },
  ],
  [PAGE_A]: [{ href: PAGE_B, texto: 'Página B' }],
  [PAGE_B]: [],
};

// `FakePortalSession.goto` no acepta una función personalizada — solo un `landingUrl` fijo
// (devuelve el argumento tal cual si no se fija uno). Por eso `evaluate` no puede inferir "en qué
// página estoy" a partir de un `goto` simulado: en su lugar, el fake avanza un índice cada vez
// que se llama al extractor de links (una vez por página, en el mismo orden de recorrido — BFS
// determinístico sobre el grafo fijo de este test).
function makeCrawlRuntime(visitOrder: readonly string[]): Runtime {
  let visitIndex = -1;
  const evaluate = (expr: string): unknown => {
    if (expr.includes('outerHTML')) return '<html></html>';
    if (expr.includes('fetch(location.href')) return { 'content-type': 'text/html' };
    visitIndex++;
    const url = visitOrder[visitIndex] ?? '';
    return { titulo: url, links: SITE[url] ?? [], recursos: [] };
  };
  return {
    clock: new testing.FixedClock(new Date('2026-08-05T12:00:00Z')),
    audit: new testing.RecordingAuditSink(),
    store: new testing.InMemoryKeyValueStore(),
    portal: new testing.FakePortalDriver({ restoreSession: { evaluate } }),
  };
}

async function seed(rt: Runtime): Promise<void> {
  await writeSession(rt.store, { rut: '11111111-1', cookies: ['c'], savedAt: '2026-08-05T12:00:00Z' });
}

describe('crawl — motor de reconocimiento (ADR-040)', () => {
  it('sigue links del mismo dominio en anchura, respetando la profundidad máxima', async () => {
    const rt = makeCrawlRuntime([HOME, PAGE_A, PAGE_B]);
    await seed(rt);

    const res = await crawl(
      rt,
      { semillas: [HOME], maxPaginas: 10, maxProfundidad: 2, paceMs: 0, resumirConLlm: false },
      null,
    );

    expect(res.paginas.map((p) => p.url)).toEqual([HOME, PAGE_A, PAGE_B]);
    expect(res.paginas.every((p) => p.resumenLlm === null)).toBe(true);
  });

  it('NUNCA sigue un link fuera de *.sii.cl', async () => {
    const rt = makeCrawlRuntime([HOME, PAGE_A, PAGE_B]);
    await seed(rt);

    const res = await crawl(
      rt,
      { semillas: [HOME], maxPaginas: 10, maxProfundidad: 2, paceMs: 0, resumirConLlm: false },
      null,
    );

    expect(res.paginas.some((p) => p.url === EXTERNAL)).toBe(false);
    expect(res.omitidos).toContainEqual(
      expect.objectContaining({ href: EXTERNAL, razon: 'dominio-externo' }),
    );
  });

  it('NUNCA sigue un link del denylist de escritura (pagogiro-ui)', async () => {
    const rt = makeCrawlRuntime([HOME, PAGE_A, PAGE_B]);
    await seed(rt);

    const res = await crawl(
      rt,
      { semillas: [HOME], maxPaginas: 10, maxProfundidad: 2, paceMs: 0, resumirConLlm: false },
      null,
    );

    expect(res.paginas.some((p) => p.url === PAGO_GIRO)).toBe(false);
    expect(res.omitidos).toContainEqual(
      expect.objectContaining({ href: PAGO_GIRO, razon: 'denylist', denylistNombre: 'Pagar giros' }),
    );
  });

  it('NUNCA ejecuta un href `javascript:` — solo lo registra', async () => {
    const rt = makeCrawlRuntime([HOME, PAGE_A, PAGE_B]);
    await seed(rt);

    const res = await crawl(
      rt,
      { semillas: [HOME], maxPaginas: 10, maxProfundidad: 2, paceMs: 0, resumirConLlm: false },
      null,
    );

    expect(res.omitidos).toContainEqual(
      expect.objectContaining({ href: 'javascript:hacerAlgo()', razon: 'javascript-href' }),
    );
  });

  it('respeta el presupuesto de páginas por corrida', async () => {
    const rt = makeCrawlRuntime([HOME]);
    await seed(rt);

    const res = await crawl(
      rt,
      { semillas: [HOME], maxPaginas: 1, maxProfundidad: 5, paceMs: 0, resumirConLlm: false },
      null,
    );

    expect(res.paginas).toHaveLength(1);
    expect(res.omitidos.some((o) => o.razon === 'presupuesto-agotado')).toBe(true);
  });

  it('llama al resumidor por página cuando resumirConLlm es true, y lo adjunta', async () => {
    const rt = makeCrawlRuntime([PAGE_B]);
    await seed(rt);

    const res = await crawl(
      rt,
      { semillas: [PAGE_B], maxPaginas: 1, maxProfundidad: 1, paceMs: 0, resumirConLlm: true },
      async (p) => `resumen de ${p.url}`,
    );

    expect(res.paginas[0]?.resumenLlm).toBe(`resumen de ${PAGE_B}`);
  });

  it('un fallo del resumidor (Ollama caído) NUNCA bloquea la captura de la página', async () => {
    const rt = makeCrawlRuntime([PAGE_B]);
    await seed(rt);

    const res = await crawl(
      rt,
      { semillas: [PAGE_B], maxPaginas: 1, maxProfundidad: 1, paceMs: 0, resumirConLlm: true },
      async () => {
        throw new Error('ollama no disponible');
      },
    );

    expect(res.paginas).toHaveLength(1);
    expect(res.paginas[0]?.resumenLlm).toBeNull();
  });

  it('aborta TODA la corrida si aterriza en la página de login (sesión muerta del lado SII)', async () => {
    // LIVE FINDING (2026-08-05): una cookie localmente "fresca" puede estar muerta en el SII;
    // `goto` no lo prueba por sí solo. Detección URL-based, igual que el resto del proyecto.
    const rt = makeCrawlRuntime([HOME]);
    await seed(rt);

    await expect(
      crawl(
        rt,
        {
          semillas: ['https://zeusr.sii.cl/algunaRuta'],
          maxPaginas: 10,
          maxProfundidad: 2,
          paceMs: 0,
          resumirConLlm: false,
        },
        null,
      ),
    ).rejects.toThrow(/sesión SII está muerta/);
  });

  it('sin sesión activa, propaga NotAuthenticatedError (nunca intenta loguearse solo)', async () => {
    const rt = makeCrawlRuntime([HOME]);

    await expect(
      crawl(rt, { semillas: [HOME], maxPaginas: 1, maxProfundidad: 1, paceMs: 0, resumirConLlm: false }, null),
    ).rejects.toBeInstanceOf(NotAuthenticatedError);
  });
});
