// Expresiones evaluadas EN LA PÁGINA (vía `PortalSession.evaluate`, ADR-040 §Decision 3) — solo
// LECTURA de estado ya existente del navegador. Ninguna de las dos modifica nada ni dispara una
// petición nueva salvo un GET del propio `location.href` (idéntico a lo que el navegador acaba
// de hacer para cargar la página).

/** Título, links (con su texto visible) y recursos cargados (`performance.getEntriesByType`,
 *  una API PASIVA del navegador — no se parchea `fetch`/`XMLHttpRequest`, ADR-040 alternativa 3). */
export const EXTRACT_EXPR = `(() => {
  const links = Array.from(document.querySelectorAll('a[href]')).map((a) => ({
    href: a.href,
    texto: (a.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 200),
  }));
  const recursos = (performance.getEntriesByType('resource') || []).map((r) => ({
    url: r.name,
    tipo: r.initiatorType || 'unknown',
  }));
  return { titulo: document.title || null, links, recursos };
})()`;

/** Headers HTTP de la página actual — un GET a su propia URL (mismo request que ya hizo el
 *  navegador para cargarla), nunca a un endpoint distinto. */
export const HEADERS_EXPR = `(async () => {
  try {
    const res = await fetch(location.href, { method: 'GET', credentials: 'include' });
    const headers = {};
    res.headers.forEach((v, k) => { headers[k] = v; });
    return headers;
  } catch (e) {
    return {};
  }
})()`;

export const HTML_EXPR = 'document.documentElement.outerHTML';

export interface ExtractedPage {
  readonly titulo: string | null;
  readonly links: readonly { href: string; texto: string }[];
  readonly recursos: readonly { url: string; tipo: string }[];
}
