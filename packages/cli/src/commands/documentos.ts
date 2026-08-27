// `sii carta pdf …` — descarga el PDF de una carta/notificación por codCarta (ADR-042). Thin
// call into @dostertags/sii-core (ADR-003). Escribe el archivo a disco — el PDF binario
// NUNCA se imprime a stdout (STDOUT es JSON pipeable a `jq`, ADR-012); la confirmación sí lo es.
import { writeFile } from 'node:fs/promises';
import type { Command } from 'commander';
import { descargarCartaPdf, type Runtime } from '@dostertags/sii-core';
import { emit, out } from '../io.js';

export function registerDocumentos(program: Command, runtime: Runtime): void {
  const carta = program
    .command('carta')
    .description('Documentos SII (cartas/notificaciones) — descarga de PDF.');

  carta
    .command('pdf <codCarta>')
    .description(
      'Descarga el PDF de una carta/notificación (codCarta ya expuesto por `f22 historial`). ' +
        'Escribe el archivo en --out; nunca imprime el binario a stdout.',
    )
    .requiredOption('--out <ruta>', 'Ruta del archivo PDF a escribir.')
    .action(async (codCarta: string, opts: { out: string }) => {
      const res = await descargarCartaPdf(runtime, { codCarta });
      await writeFile(opts.out, res.bytes);
      emit(
        { codCarta: res.codCarta, bytes: res.bytes.length, ruta: opts.out },
        () => out(`PDF de la carta ${res.codCarta} guardado en ${opts.out} (${res.bytes.length} bytes).`),
      );
    });
}
