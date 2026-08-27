// Tipos del crawler de reconocimiento (ADR-040). Datos crudos capturados — nunca curados como
// una fachada de producción los curaría; son insumo para revisión humana.

export interface LinkEncontrado {
  readonly href: string;
  readonly texto: string;
}

export interface RecursoCargado {
  readonly url: string;
  /** `initiatorType` del navegador: `fetch`/`xmlhttprequest`/`script`/`link`/`img`/… */
  readonly tipo: string;
}

export interface PaginaCapturada {
  readonly url: string;
  readonly titulo: string | null;
  readonly html: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly links: readonly LinkEncontrado[];
  readonly recursos: readonly RecursoCargado[];
  readonly profundidad: number;
  readonly capturedAt: string;
  /** Resumen de Llama 3.1 (ADR-040 §Decision 8) — señal adicional, nunca autoritativa. `null` si
   *  Ollama no estaba disponible para esta corrida. */
  readonly resumenLlm: string | null;
}

export type RazonOmision =
  | 'denylist'
  | 'javascript-href'
  | 'dominio-externo'
  | 'ya-visitado'
  | 'ya-en-cola'
  | 'presupuesto-agotado'
  | 'profundidad-maxima';

export interface LinkOmitido {
  readonly href: string;
  readonly texto: string;
  readonly razon: RazonOmision;
  readonly denylistNombre?: string;
}

export interface ErrorPagina {
  readonly url: string;
  readonly mensaje: string;
}

export interface CrawlResult {
  readonly paginas: readonly PaginaCapturada[];
  readonly omitidos: readonly LinkOmitido[];
  readonly errores: readonly ErrorPagina[];
}

export interface CrawlOptions {
  readonly semillas: readonly string[];
  readonly maxPaginas: number;
  readonly maxProfundidad: number;
  /** Pausa entre navegaciones (ms) — mismo criterio de paceo que el resto del proyecto
   *  (`DEFAULT_SETTINGS.rateLimitRps` = 1 req/s, `packages/core/src/config/config.ts`). */
  readonly paceMs: number;
  /** Resumir cada página con Llama 3.1 (Ollama local). `false` para una corrida rápida sin LLM. */
  readonly resumirConLlm: boolean;
}

export const DEFAULT_CRAWL_OPTIONS: Omit<CrawlOptions, 'semillas'> = {
  maxPaginas: 40,
  maxProfundidad: 3,
  paceMs: 1000,
  resumirConLlm: true,
};
