#!/usr/bin/env node
// Entry point del crawler de reconocimiento (ADR-040). Herramienta de línea de comandos, NO una
// superficie CLI del proyecto (no registra nada en `packages/cli`).
import { fileURLToPath } from 'node:url';
import { createNodeRuntime } from '@dostertags/sii-core/node';
import { NotAuthenticatedError } from '@dostertags/sii-core';
import { crawl } from './crawl.js';
import { summarizePage } from './ollama.js';
import { writeReport } from './report.js';
import { SEEDS } from './seeds.js';
import { DEFAULT_CRAWL_OPTIONS } from './types.js';

function argFlag(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return null;
  return process.argv[i + 1] ?? null;
}
function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main(): Promise<void> {
  const maxPaginas = Number(argFlag('max-pages') ?? DEFAULT_CRAWL_OPTIONS.maxPaginas);
  const maxProfundidad = Number(argFlag('max-depth') ?? DEFAULT_CRAWL_OPTIONS.maxProfundidad);
  const paceMs = Number(argFlag('pace-ms') ?? DEFAULT_CRAWL_OPTIONS.paceMs);
  const resumirConLlm = !hasFlag('no-llm');
  const outRoot = argFlag('out') ?? fileURLToPath(new URL('../out', import.meta.url));
  const semillaUnica = argFlag('seed');
  const semillas = semillaUnica ? [semillaUnica] : SEEDS;

  console.log(
    `[crawler] presupuesto=${maxPaginas} páginas, profundidad=${maxProfundidad}, ` +
      `paceo=${paceMs}ms, Llama 3.1=${resumirConLlm ? 'sí' : 'no'}`,
  );
  console.log(`[crawler] semillas: ${semillas.length}`);

  const runtime = createNodeRuntime();
  const generatedAt = runtime.clock.now().toISOString();

  let result;
  try {
    result = await crawl(
      runtime,
      { semillas, maxPaginas, maxProfundidad, paceMs, resumirConLlm },
      resumirConLlm ? (page) => summarizePage(page) : null,
    );
  } catch (e) {
    if (e instanceof NotAuthenticatedError) {
      console.error(
        `[crawler] ${e.message} El crawler NUNCA hace login por su cuenta (ADR-006) — corre ` +
          '`sii auth login` y vuelve a intentar.',
      );
      process.exitCode = 2;
      return;
    }
    throw e;
  }

  console.log(
    `[crawler] listo: ${result.paginas.length} páginas, ${result.omitidos.length} omitidas, ` +
      `${result.errores.length} errores.`,
  );

  const { reportPath } = await writeReport(outRoot, result, generatedAt);
  console.log(`[crawler] reporte: ${reportPath}`);
}

main().catch((e: unknown) => {
  console.error('[crawler] error inesperado:', e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
