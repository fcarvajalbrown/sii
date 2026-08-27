// `sii carpeta …` — Carpeta Tributaria Regular (ADR-033). Thin calls into @dostertags/sii-core
// tasks (ADR-003). READ ONLY: historial of already-issued dossiers, never generation/anulación.
// SESSION-KEYED: reads the session principal; no `--rut`.
import type { Command } from 'commander';
import { carpetaTributariaHistorial, formatRut as fmtRut, type Runtime } from '@dostertags/sii-core';
import { emit, out } from '../io.js';

export function registerCarpeta(program: Command, runtime: Runtime): void {
  const carpeta = program
    .command('carpeta')
    .description('Carpeta Tributaria Regular — historial de dossieres de crédito emitidos.');

  carpeta
    .command('historial')
    .description(
      'Historial de Carpetas Tributarias Regulares generadas por el titular (todos los años por ' +
        'defecto). Solo lectura — no genera ni anula ninguna.',
    )
    .option('--anio <año>', 'Filtrar por un año específico.')
    .action(async (opts: { anio?: string }) => {
      const res = await carpetaTributariaHistorial(runtime, opts.anio ? { anio: opts.anio } : {});
      emit(res, () => {
        out(`Carpetas Tributarias Regulares (${res.anio ?? 'todos los años'}) — ${fmtRut(res.rut)}`);
        if (res.items.length === 0) {
          out('Sin carpetas tributarias generadas.');
        }
        for (const item of res.items) {
          out(
            `  código=${item.codigoRepositorio ?? '—'}  ${item.fechaGeneracion ?? '—'}  ` +
              `estado=${item.estado ?? '—'}  institución=${item.institucionDescripcion ?? '—'}  ` +
              `receptor=${item.receptorNombre ?? '—'}${item.fechaAnulacion ? `  anulada=${item.fechaAnulacion}` : ''}`,
          );
        }
      });
    });
}
