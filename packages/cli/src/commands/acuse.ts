// `sii dte acuse <periodo>` — estado de acuse de los DTE recibidos (ADR-036).
// Composición sobre RCV; body-RUT (acepta `--rut`). ⛔ SOLO LECTURA: nunca acepta ni reclama.
import type { Command } from 'commander';
import { dteAcuse, formatMoney, formatRut as fmtRut, type Runtime } from '@dostertags/sii-core';
import { emit, out } from '../io.js';

export function registerAcuse(dte: Command, runtime: Runtime): void {
  dte
    .command('acuse')
    .description(
      'Estado de acuse de recibo/reclamo de los DTE RECIBIDOS en un período, agrupado, más los ' +
        'documentos sin evento informado por SII. Solo lectura: no acepta ni reclama nada.',
    )
    .argument('<periodo>', 'Período tributario (YYYY-MM o YYYYMM).')
    .option('--rut <rut>', 'RUT operado (empresa representada); por defecto el puntero operate.')
    .action(async (periodo: string, opts: { rut?: string }) => {
      const res = await dteAcuse(runtime, {
        periodo,
        ...(opts.rut !== undefined ? { rut: opts.rut } : {}),
      });
      emit(res, () => {
        out(`Acuse de DTE recibidos — ${fmtRut(res.rut)} · ${res.periodo}`);
        out(`  ${res.totalDocumentos} documento(s) recibido(s)`);
        out('');
        for (const g of res.grupos) {
          out(
            `  ${(g.evento ?? '—').padEnd(3)} ${(g.leyenda ?? 'sin evento informado').padEnd(38)} ` +
              `${String(g.documentos).padStart(5)} doc  ${formatMoney(g.montoTotal)}`,
          );
        }
        if (res.sinEvento.length > 0) {
          out('');
          const porTipo = Object.entries(res.sinEventoPorTipo)
            .map(([t, n]) => `tipo ${t}: ${n}`)
            .join(', ');
          out(`  ${res.sinEvento.length} documento(s) sin evento informado (${porTipo}).`);
          out(
            '  Nota: en los períodos observados, la ausencia de evento se dio SOLO en notas de ' +
              'crédito y DIN — no es, por sí sola, señal de un acuse pendiente.',
          );
          for (const d of res.sinEvento.slice(0, 20)) {
            out(
              `    tipo ${d.codigoTipoDoc} folio ${d.folio ?? '—'}  ${d.razonSocial ?? ''}  ` +
                `recibido ${d.fechaRecepcion ?? '—'}` +
                (d.diasDesdeRecepcion !== null ? ` (hace ${d.diasDesdeRecepcion} día(s))` : ''),
            );
          }
          if (res.sinEvento.length > 20) out(`    … y ${res.sinEvento.length - 20} más`);
        }
        if (res.incompleto) {
          out('');
          out(`(Incompleto: SII rechazó los tipos ${res.tiposRechazados.join(', ')}.)`);
        }
      });
    });
}
