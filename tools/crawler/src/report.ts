// Reporte de una corrida del crawler (ADR-040 §Decision 9). El crawler NUNCA escribe en
// `docs/ESTADO-CONSOLIDADO.md` ni en ningún ADR — esto es el insumo que un humano revisa antes de
// promover un hallazgo ahí.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { esUrlConocida } from './known-urls.js';
import type { CrawlResult, LinkOmitido, PaginaCapturada } from './types.js';

function candidatosNuevos(paginas: readonly PaginaCapturada[]): readonly PaginaCapturada[] {
  return paginas.filter((p) => !esUrlConocida(p.url));
}

function omitidosPorRazon(
  omitidos: readonly LinkOmitido[],
): Record<string, readonly LinkOmitido[]> {
  const out: Record<string, LinkOmitido[]> = {};
  for (const o of omitidos) {
    (out[o.razon] ??= []).push(o);
  }
  return out;
}

/** Construye el Markdown del reporte. Pura — sin tocar disco, así se prueba directamente. */
export function buildReportMarkdown(result: CrawlResult, generatedAt: string): string {
  const nuevos = candidatosNuevos(result.paginas);
  const porRazon = omitidosPorRazon(result.omitidos);
  const denylisted = porRazon['denylist'] ?? [];

  const lines: string[] = [];
  lines.push(`# Reporte del crawler — ${generatedAt}`);
  lines.push('');
  lines.push(
    '> Generado por `tools/crawler` (ADR-040). Estos son CANDIDATOS para revisión humana — ' +
      'ninguno se promueve solo a `docs/ESTADO-CONSOLIDADO.md` ni a un ADR.',
  );
  lines.push('');
  lines.push('## Resumen');
  lines.push('');
  lines.push(`- Páginas capturadas: **${result.paginas.length}**`);
  lines.push(`- Candidatos NUEVOS (no catalogados en ESTADO-CONSOLIDADO): **${nuevos.length}**`);
  lines.push(`- Links bloqueados por el denylist de escritura: **${denylisted.length}**`);
  lines.push(`- Errores: **${result.errores.length}**`);
  lines.push('');

  if (nuevos.length > 0) {
    lines.push('## Candidatos nuevos (revisar antes de promover)');
    lines.push('');
    for (const p of nuevos) {
      lines.push(`### ${p.url}`);
      lines.push(`- Título: ${p.titulo ?? '(sin título)'}`);
      lines.push(`- Profundidad: ${p.profundidad}`);
      if (p.resumenLlm) {
        lines.push(`- Resumen (Llama 3.1, señal NO autoritativa — ver ADR-040):`);
        lines.push('  ```');
        for (const l of p.resumenLlm.split('\n')) lines.push(`  ${l}`);
        lines.push('  ```');
      }
      lines.push('');
    }
  }

  if (denylisted.length > 0) {
    lines.push('## Links bloqueados por el denylist de escritura (NUNCA seguidos)');
    lines.push('');
    for (const o of denylisted) {
      lines.push(`- **${o.denylistNombre}** — "${o.texto}" → ${o.href}`);
    }
    lines.push('');
  }

  const jsHrefs = porRazon['javascript-href'] ?? [];
  if (jsHrefs.length > 0) {
    lines.push('## Handlers `javascript:` encontrados (NUNCA ejecutados — revisar a mano)');
    lines.push('');
    for (const o of jsHrefs) {
      lines.push(`- "${o.texto}" → \`${o.href}\``);
    }
    lines.push('');
  }

  if (result.errores.length > 0) {
    lines.push('## Errores');
    lines.push('');
    for (const e of result.errores) {
      lines.push(`- ${e.url}: ${e.mensaje}`);
    }
    lines.push('');
  }

  lines.push('## Todas las páginas capturadas');
  lines.push('');
  for (const p of result.paginas) {
    lines.push(`- [profundidad ${p.profundidad}] ${p.url}${esUrlConocida(p.url) ? '' : ' 🆕'}`);
    // El detalle completo del resumen ya salió arriba para los candidatos NUEVOS; para una
    // página YA conocida se muestra solo la primera línea, para no repetir el resumen entero.
    if (p.resumenLlm && esUrlConocida(p.url)) {
      lines.push(`  - ${p.resumenLlm.split('\n')[0]}`);
    }
  }
  lines.push('');

  return lines.join('\n');
}

/** Escribe la corrida a disco: una carpeta por corrida bajo `outRoot`, con el Markdown, el JSON
 *  crudo completo (`result.json`), y un `.html` por página nueva (para inspección rápida). */
export async function writeReport(
  outRoot: string,
  result: CrawlResult,
  generatedAt: string,
): Promise<{ readonly dir: string; readonly reportPath: string }> {
  const dir = join(outRoot, generatedAt.replace(/[:.]/g, '-'));
  await mkdir(join(dir, 'paginas'), { recursive: true });

  const reportPath = join(dir, 'REPORTE.md');
  await writeFile(reportPath, buildReportMarkdown(result, generatedAt), 'utf-8');
  await writeFile(join(dir, 'result.json'), JSON.stringify(result, null, 2), 'utf-8');

  for (const [i, p] of candidatosNuevos(result.paginas).entries()) {
    const nombre = String(i).padStart(3, '0');
    await writeFile(join(dir, 'paginas', `${nombre}.html`), p.html, 'utf-8');
  }

  return { dir, reportPath };
}
