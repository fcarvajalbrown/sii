// Cliente mínimo de Ollama local (ADR-040 §Decision 8) — Llama 3.1 corriendo en la máquina del
// usuario, sin SDK: la API REST de Ollama es simple (`POST /api/generate`). El resumen que
// produce es una SEÑAL ADICIONAL para revisión humana, nunca el mecanismo de seguridad real (ese
// vive en `denylist.ts`, en código) ni una fuente de verdad (ADR-004: nada que el LLM infiera se
// asume cierto sin confirmar).

export interface OllamaConfig {
  readonly baseUrl: string;
  readonly model: string;
  readonly timeoutMs: number;
}

export const DEFAULT_OLLAMA_CONFIG: OllamaConfig = {
  baseUrl: 'http://localhost:11434',
  model: 'llama3.1',
  timeoutMs: 30_000,
};

export interface PageForSummary {
  readonly url: string;
  readonly titulo: string | null;
  readonly html: string;
  readonly links: readonly { href: string; texto: string }[];
  readonly recursos: readonly { url: string; tipo: string }[];
}

/** Tope de caracteres de HTML incluidos en el prompt — el modelo no necesita la página completa
 *  para resumirla, y un contexto más chico responde más rápido. */
const HTML_EXCERPT_CHARS = 4000;
/** Tope de links listados en el prompt, para no saturarlo en páginas con cientos de enlaces. */
const MAX_LINKS_EN_PROMPT = 60;

function buildPrompt(page: PageForSummary): string {
  const links = page.links
    .slice(0, MAX_LINKS_EN_PROMPT)
    .map((l) => `- "${l.texto}" → ${l.href}`)
    .join('\n');
  const recursos = page.recursos
    .slice(0, MAX_LINKS_EN_PROMPT)
    .map((r) => `- [${r.tipo}] ${r.url}`)
    .join('\n');
  const htmlExcerpt = page.html.slice(0, HTML_EXCERPT_CHARS);

  return `Eres un asistente de reconocimiento técnico sobre el sitio del SII (Servicio de \
Impuestos Internos de Chile). Recibirás una página capturada y debes responder en español, en \
un máximo de 6 líneas, con esta estructura exacta:

QUÉ ES: <una frase sobre el propósito de la página>
ENDPOINTS: <lista corta de URLs de datos/JSON que parezca cargar, o "ninguno visible">
POSIBLE_ESCRITURA: <SI o NO> — <por qué, en pocas palabras>

IMPORTANTE: "POSIBLE_ESCRITURA" es solo tu impresión para que un humano la revise más rápido — \
NO es una decisión de seguridad y NADIE actuará solo en base a tu respuesta. Sé conservador: si \
hay cualquier duda, responde SI.

URL: ${page.url}
Título: ${page.titulo ?? '(sin título)'}

Links encontrados:
${links || '(ninguno)'}

Recursos cargados (scripts/XHR/fetch/etc.):
${recursos || '(ninguno)'}

Extracto del HTML (hasta ${HTML_EXCERPT_CHARS} caracteres):
${htmlExcerpt}`;
}

interface OllamaGenerateResponse {
  readonly response?: unknown;
}

/** Pide a Llama 3.1 (Ollama local) un resumen de una página capturada. Lanza si Ollama no
 *  responde OK o si la forma de respuesta no es la esperada — el llamador (`crawl.ts`) decide
 *  qué hacer con ese fallo (nunca bloquea la captura real). */
export async function summarizePage(
  page: PageForSummary,
  config: OllamaConfig = DEFAULT_OLLAMA_CONFIG,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const res = await fetchImpl(`${config.baseUrl}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: config.model, prompt: buildPrompt(page), stream: false }),
    signal: AbortSignal.timeout(config.timeoutMs),
  });
  if (!res.ok) {
    throw new Error(`Ollama respondió HTTP ${res.status} — ¿está corriendo \`ollama serve\`?`);
  }
  const data = (await res.json()) as OllamaGenerateResponse;
  if (typeof data.response !== 'string') {
    throw new Error('Respuesta de Ollama sin el campo "response" esperado.');
  }
  return data.response;
}
