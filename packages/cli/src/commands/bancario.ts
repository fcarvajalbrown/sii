// `sii bancario resumen` — informe de abonos bancarios por semestre (ADR-039). Llamada fina a un
// task de @dostertags/sii-core (ADR-003). SESSION-KEYED: sin `--rut`.
import type { Command } from 'commander';
import {
  bancarioInforme,
  formatMoney,
  formatRut as fmtRut,
  type Runtime,
} from '@dostertags/sii-core';
import { emit, out } from '../io.js';

export function registerBancario(program: Command, runtime: Runtime): void {
  const bancario = program.command('bancario').description('Informe bancario de abonos.');

  bancario
    .command('resumen')
    .description(
      'Abonos bancarios por semestre, banco y tipo de cuenta — el insumo del cruce de ' +
        'fiscalización que compara depósitos bancarios contra ventas declaradas.',
    )
    .action(async () => {
      const res = await bancarioInforme(runtime);
      emit(res, () => {
        out(`Informe bancario — ${fmtRut(res.rut)}`);
        if (res.semestres.length === 0) {
          out('  (sin informe bancario disponible)');
          return;
        }
        for (const s of res.semestres) {
          out(`  ${s.semestre ?? '—'} (periodoDj ${s.periodoDj ?? '—'})`);
          out(`    ${s.banco ?? '—'} · ${s.tipoCuenta ?? '—'}`);
          out(
            `    Abonos: ${s.cantidadAbonos ?? '—'}  Monto total: ${s.montoTotalAbonos !== null ? formatMoney(s.montoTotalAbonos) : '—'}`,
          );
        }
      });
    });
}
