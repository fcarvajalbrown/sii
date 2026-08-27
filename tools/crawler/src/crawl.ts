// Motor de crawling de reconocimiento (ADR-040). BFS acotado por presupuesto y profundidad,
// solo dominios `*.sii.cl`, nunca hace click ni envía formularios — solo `PortalSession.goto`
// (GET) sobre `href`s de texto plano extraídos con `evaluate` (nunca ejecutados).
import { withSession } from '@dostertags/sii-core/node';
import { LOGIN_HOST, SessionExpiredError, type Runtime } from '@dostertags/sii-core';
import { matchDenylist } from './denylist.js';
import { EXTRACT_EXPR, HEADERS_EXPR, HTML_EXPR, type ExtractedPage } from './extract.js';
import type {
  CrawlOptions,
  CrawlResult,
  ErrorPagina,
  LinkOmitido,
  PaginaCapturada,
} from './types.js';

/** Tope de tamaño del HTML guardado por página — evita capturas gigantes en disco. */
const MAX_HTML_CHARS = 200_000;

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function isSiiDomain(url: string): boolean {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return h === 'sii.cl' || h.endsWith('.sii.cl');
  } catch {
    return false;
  }
}

/** Descarta el fragmento (`#...`) para no tratar anclas de la misma página como páginas nuevas;
 *  conserva la query string (muchos endpoints SII difieren solo por `opc=`/`opcionPagina=`...). */
function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = '';
    return u.toString();
  } catch {
    return url;
  }
}

export type Summarizer = (page: {
  url: string;
  titulo: string | null;
  html: string;
  links: readonly { href: string; texto: string }[];
  recursos: readonly { url: string; tipo: string }[];
}) => Promise<string | null>;

/** Recorre `options.semillas` en anchura, sin exceder `maxPaginas`/`maxProfundidad`, paceado por
 *  `paceMs`. Requiere una sesión SII YA autenticada (`withSession` — nunca hace login propio,
 *  ADR-006); si no hay sesión, propaga `NotAuthenticatedError`/`SessionExpiredError` tal cual. */
export async function crawl(
  runtime: Runtime,
  options: CrawlOptions,
  summarize: Summarizer | null,
): Promise<CrawlResult> {
  const paginas: PaginaCapturada[] = [];
  const omitidos: LinkOmitido[] = [];
  const errores: ErrorPagina[] = [];
  const visitados = new Set<string>();
  const enCola = new Set<string>();
  const cola: { url: string; profundidad: number }[] = [];

  for (const semilla of options.semillas) {
    const n = normalizeUrl(semilla);
    if (enCola.has(n)) continue;
    cola.push({ url: n, profundidad: 0 });
    enCola.add(n);
  }

  await withSession(runtime, async (session) => {
    while (cola.length > 0) {
      if (paginas.length >= options.maxPaginas) {
        for (const restante of cola) {
          omitidos.push({ href: restante.url, texto: '', razon: 'presupuesto-agotado' });
        }
        break;
      }

      const item = cola.shift();
      if (!item) break;
      if (visitados.has(item.url)) continue;
      visitados.add(item.url);

      if (paginas.length > 0) await runtime.clock.sleep(options.paceMs);

      let landing: string;
      try {
        landing = await session.goto(item.url);
      } catch (e) {
        errores.push({ url: item.url, mensaje: messageOf(e) });
        continue;
      }

      // Detección de sesión muerta BASADA EN URL, no en el DOM (mismo criterio que el resto del
      // proyecto — CONVENTIONS.md: aterrizar en `zeusr.sii.cl` significa "no autenticado"). Una
      // cookie localmente "fresca" (dentro del TTL) puede estar muerta del lado de SII — `goto`
      // no lo prueba por sí solo, a diferencia de `requestJson`/`requestForm`. LIVE FINDING
      // (2026-08-05): una corrida real aterrizó en la página de login y siguió navegando el
      // sitio PÚBLICO sin autenticar como si fuera una corrida normal — se aborta toda la
      // corrida (no solo esta página), porque nada capturado después de esto es de la sesión.
      let landingHost: string;
      try {
        landingHost = new URL(landing).hostname;
      } catch {
        landingHost = '';
      }
      if (landingHost === LOGIN_HOST) {
        throw new SessionExpiredError(
          `El crawler aterrizó en la página de login (${landing}) — la sesión SII está muerta ` +
            'del lado del servidor aunque localmente parecía vigente. Ejecuta `sii auth login` ' +
            'y vuelve a correr el crawler.',
        );
      }

      let extracted: ExtractedPage;
      let headers: Record<string, string>;
      let html: string;
      try {
        extracted = await session.evaluate<ExtractedPage>(EXTRACT_EXPR);
        headers = await session.evaluate<Record<string, string>>(HEADERS_EXPR);
        html = await session.evaluate<string>(HTML_EXPR);
      } catch (e) {
        errores.push({ url: landing, mensaje: messageOf(e) });
        continue;
      }
      const htmlTrunc =
        html.length > MAX_HTML_CHARS ? `${html.slice(0, MAX_HTML_CHARS)}\n<!-- TRUNCADO -->` : html;

      let resumenLlm: string | null = null;
      if (summarize) {
        try {
          resumenLlm = await summarize({
            url: landing,
            titulo: extracted.titulo,
            html: htmlTrunc,
            links: extracted.links,
            recursos: extracted.recursos,
          });
        } catch {
          resumenLlm = null; // Ollama no disponible/falló — nunca bloquea la captura real.
        }
      }

      paginas.push({
        url: landing,
        titulo: extracted.titulo,
        html: htmlTrunc,
        headers,
        links: extracted.links,
        recursos: extracted.recursos,
        profundidad: item.profundidad,
        capturedAt: runtime.clock.now().toISOString(),
        resumenLlm,
      });

      if (item.profundidad >= options.maxProfundidad) {
        for (const link of extracted.links) {
          omitidos.push({ href: link.href, texto: link.texto, razon: 'profundidad-maxima' });
        }
        continue;
      }

      for (const link of extracted.links) {
        // Nunca se ejecuta un `javascript:` — se registra para revisión humana (ADR-032
        // ya mostró que un link "de lectura" puede ser en realidad un handler de escritura).
        if (link.href.startsWith('javascript:')) {
          omitidos.push({ href: link.href, texto: link.texto, razon: 'javascript-href' });
          continue;
        }
        if (!isSiiDomain(link.href)) {
          omitidos.push({ href: link.href, texto: link.texto, razon: 'dominio-externo' });
          continue;
        }
        const denylisted = matchDenylist(link.href, link.texto);
        if (denylisted) {
          omitidos.push({
            href: link.href,
            texto: link.texto,
            razon: 'denylist',
            denylistNombre: denylisted.entry.nombre,
          });
          continue;
        }
        const n = normalizeUrl(link.href);
        if (visitados.has(n)) {
          omitidos.push({ href: link.href, texto: link.texto, razon: 'ya-visitado' });
          continue;
        }
        if (enCola.has(n)) {
          omitidos.push({ href: link.href, texto: link.texto, razon: 'ya-en-cola' });
          continue;
        }
        cola.push({ url: n, profundidad: item.profundidad + 1 });
        enCola.add(n);
      }
    }
  });

  return { paginas, omitidos, errores };
}
