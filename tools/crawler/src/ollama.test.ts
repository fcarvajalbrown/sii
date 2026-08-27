import { describe, it, expect, vi } from 'vitest';
import { summarizePage, DEFAULT_OLLAMA_CONFIG, type PageForSummary } from './ollama.js';

const PAGE: PageForSummary = {
  url: 'https://misiir.sii.cl/cgi_misii/siihome.cgi',
  titulo: 'Mi SII',
  html: '<html><body>hola</body></html>',
  links: [{ href: 'https://www4.sii.cl/rfiInternet/', texto: 'Giros' }],
  recursos: [{ url: 'https://misiir.sii.cl/datos.json', tipo: 'fetch' }],
};

function fakeFetch(body: unknown, status = 200): typeof fetch {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })) as unknown as typeof fetch;
}

describe('summarizePage — cliente Ollama (ADR-040)', () => {
  it('POSTea a /api/generate con el modelo configurado y stream:false', async () => {
    const fetchImpl = fakeFetch({ response: 'QUÉ ES: prueba' });
    await summarizePage(PAGE, DEFAULT_OLLAMA_CONFIG, fetchImpl);

    expect(fetchImpl).toHaveBeenCalledWith(
      'http://localhost:11434/api/generate',
      expect.objectContaining({ method: 'POST' }),
    );
    const [, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const sentBody = JSON.parse(init.body as string) as { model: string; stream: boolean; prompt: string };
    expect(sentBody.model).toBe('llama3.1');
    expect(sentBody.stream).toBe(false);
    expect(sentBody.prompt).toContain(PAGE.url);
    expect(sentBody.prompt).toContain('POSIBLE_ESCRITURA');
  });

  it('devuelve el campo "response" tal cual', async () => {
    const fetchImpl = fakeFetch({ response: 'QUÉ ES: es la portada de Mi SII' });
    const res = await summarizePage(PAGE, DEFAULT_OLLAMA_CONFIG, fetchImpl);
    expect(res).toBe('QUÉ ES: es la portada de Mi SII');
  });

  it('lanza un error accionable si Ollama no responde OK (ej. no está corriendo)', async () => {
    const fetchImpl = fakeFetch({}, 500);
    await expect(summarizePage(PAGE, DEFAULT_OLLAMA_CONFIG, fetchImpl)).rejects.toThrow(/ollama serve/i);
  });

  it('lanza si la respuesta no tiene el campo "response" esperado', async () => {
    const fetchImpl = fakeFetch({ algoDistinto: true });
    await expect(summarizePage(PAGE, DEFAULT_OLLAMA_CONFIG, fetchImpl)).rejects.toThrow(/"response"/);
  });
});
