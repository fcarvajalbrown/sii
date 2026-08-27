// `sii dj …` — Estado y contenido de Declaraciones Juradas (ADR-030 / ADR-031). Thin calls into
// @dostertags/sii-core tasks (ADR-003). SESSION-KEYED for now: reads the session principal;
// no `--rut` (RUT-in-path reach for a represented empresa was not confirmed live — see the ADRs).
import type { Command } from 'commander';
import {
  djDetalle,
  djHistorial,
  djStatus,
  formatRut as fmtRut,
  type Runtime,
} from '@dostertags/sii-core';
import { emit, out } from '../io.js';

export function registerDj(program: Command, runtime: Runtime): void {
  const dj = program.command('dj').description('Declaraciones Juradas (DJ).');

  dj.command('status')
    .description(
      'Estado de las DJ del titular para los últimos N años tributarios (default 6, máx 15).',
    )
    .option('--years <n>', 'Cuántos años tributarios cubrir.', (v: string) => Number(v))
    .action(async (opts: { years?: number }) => {
      const res = await djStatus(runtime, opts.years !== undefined ? { years: opts.years } : {});
      emit(res, () => {
        out(`Estado DJ — ${fmtRut(res.rut)} (años ${res.aniosConsultados.join(', ') || '—'})`);
        if (res.rows.length === 0) {
          out('Sin declaraciones juradas registradas en el rango consultado.');
        }
        for (const row of res.rows) {
          out(`  DJ ${row.dj ?? '—'}  ${row.titulo ?? ''}`);
          for (const anio of Object.keys(row.estados).sort()) {
            out(`    AT${anio}: ${row.estados[anio]}`);
          }
        }
        if (res.historiaAgotada) {
          out('(El barrido se detuvo antes de lo pedido: SII no tiene historial más antiguo.)');
        }
      });
    });

  dj.command('historial')
    .description(
      'Historial de presentaciones por DJ para un año tributario: folio, estado, ' +
        'tipoDeclaracion (incluye anuladas/rectificatorias). Da el "key" que pide `dj detalle`.',
    )
    .argument('<año>', 'Año tributario (YYYY).')
    .action(async (anio: string) => {
      const res = await djHistorial(runtime, { anio });
      emit(res, () => {
        out(`Historial DJ AT${res.periodo} — ${fmtRut(res.rut)}`);
        for (const row of res.rows) {
          out(`  DJ ${row.dj ?? '—'}  ${row.titulo ?? ''}`);
          for (const p of row.presentaciones) {
            out(
              `    folio=${p.folio ?? '—'}  key=${p.key ?? '—'}  ${p.estado ?? '—'}  ` +
                `${p.tipoDeclaracion ?? ''}  ${p.fecha ?? ''}`,
            );
          }
        }
      });
    });

  dj.command('detalle')
    .description(
      'Contenido de una DJ anual presentada — la estructura de tabla tal como la entrega SII ' +
        '(secciones → filas → celdas). Usa el "dj" y "key" que entrega `dj historial`. ' +
        'Solo DJ ANUALES están confirmadas en vivo (ADR-031).',
    )
    .argument('<año>', 'Año tributario (YYYY).')
    .argument('<dj>', 'Número de la DJ (ej. 1926).', (v: string) => Number(v))
    .argument('<key>', 'Identificador de la presentación (de `dj historial`).', (v: string) =>
      Number(v),
    )
    .option('--seccion <n>', 'Sección a consultar (por defecto 1).', (v: string) => Number(v))
    .option('--pagina <n>', 'Página a consultar (por defecto 1).', (v: string) => Number(v))
    .action(
      async (
        anio: string,
        dj: number,
        key: number,
        opts: { seccion?: number; pagina?: number },
      ) => {
        const res = await djDetalle(runtime, {
          anio,
          dj,
          key,
          ...(opts.seccion !== undefined ? { seccion: opts.seccion } : {}),
          ...(opts.pagina !== undefined ? { pagina: opts.pagina } : {}),
        });
        emit(res, () => {
          out(`Detalle DJ ${res.dj} (${res.periodo}) key=${res.key} — ${fmtRut(res.rut)}`);
          for (const seccion of res.secciones) {
            out(`  ${seccion.nombre}`);
            for (const tabla of seccion.tablas) {
              for (const [filaIdx, fila] of Object.entries(tabla.filas)) {
                const celdas = Object.entries(fila.celdas)
                  .map(([, c]) => c.value)
                  .filter((v) => v !== null)
                  .join(' | ');
                out(`    [${fila.tipoCelda ?? '?'}] fila ${filaIdx}: ${celdas}`);
              }
            }
          }
        });
      },
    );
}
