// `sii cache` — inspect or purge the local read-through cache (ADR-027). Purely local: it never
// touches SII and needs no session. A cache you cannot inspect or purge is a liability, and after
// an amended declaración the user needs a way to drop everything without waiting out the TTL.
import type { Command } from 'commander';
import { clearCache, readCacheStats, type Runtime } from '@dostertags/sii-core';
import { emit, out } from '../io.js';

export function registerCache(program: Command, runtime: Runtime): void {
  program
    .command('cache')
    .description(
      'Estado del caché local de lecturas (solo períodos cerrados, vigencia 30 días). ' +
        '--clear lo vacía. No consulta al SII.',
    )
    .option('--clear', 'Vacía el caché por completo.')
    .action(async (opts: { clear?: boolean }) => {
      if (opts.clear) {
        const dropped = await clearCache(runtime.store);
        emit({ cleared: dropped }, () => out(`Caché vaciado: ${dropped} entrada(s) eliminada(s).`));
        return;
      }
      const stats = await readCacheStats(runtime.store);
      emit(stats, () => {
        out(`Caché local: ${stats.entries} entrada(s).`);
        if (stats.oldest) out(`  Entrada más antigua: ${stats.oldest}`);
        if (stats.entries === 0) {
          out('  (Vacío. Se llena al leer períodos ya cerrados.)');
          return;
        }
        // Scopes repeat across tasks; count them so the line stays short for a full cache.
        const counts = new Map<string, number>();
        for (const s of stats.scopes) counts.set(s, (counts.get(s) ?? 0) + 1);
        const shown = [...counts.keys()].sort().slice(0, 24);
        out(`  Períodos: ${shown.join(', ')}${counts.size > shown.length ? ', …' : ''}`);
        out('  Los períodos abiertos NUNCA se cachean; usa --refresh para forzar una relectura.');
      });
    });
}
