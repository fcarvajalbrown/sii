// `sii giros …` — deuda fiscal formal (ADR-034). Llamadas finas a tasks de
// @dostertags/sii-core (ADR-003). SOLO LECTURA: consulta giros emitidos; NUNCA paga.
// SESSION-KEYED: lee el titular de la sesión; sin `--rut`.
import type { Command } from 'commander';
import { formatMoney, formatRut as fmtRut, girosList, type Runtime } from '@dostertags/sii-core';
import { emit, out } from '../io.js';

export function registerGiros(program: Command, runtime: Runtime): void {
  const giros = program
    .command('giros')
    .description('Giros emitidos por el SII (deuda fiscal formal). Solo consulta — nunca paga.');

  giros
    .command('list')
    .description(
      'Giros emitidos al titular: folio, formulario asociado, fechas, estado y saldo. ' +
        'Por defecto el año en curso. SOLO LECTURA.',
    )
    .option('--anio <año>', 'Consultar un año específico (YYYY).')
    .option('--years <n>', 'Barrer N años hacia atrás desde el actual (máx 10).', (v: string) =>
      Number(v),
    )
    .action(async (opts: { anio?: string; years?: number }) => {
      const res = await girosList(runtime, {
        ...(opts.anio !== undefined ? { anio: opts.anio } : {}),
        ...(opts.years !== undefined ? { years: opts.years } : {}),
      });
      emit(res, () => {
        out(`Giros — ${fmtRut(res.rut)} (años ${res.anios.join(', ')})`);
        if (res.giros.length === 0) {
          out('Sin giros emitidos en el período consultado.');
        }
        for (const g of res.giros) {
          out(
            `  ${g.periodo ?? '—'}  folio=${g.folio ?? '—'}  F${g.formularioAsociado ?? '—'}  ` +
              `vence=${g.fechaVencimiento ?? '—'}  ${g.estado ?? '—'}  saldo=${g.saldoTexto ?? '—'}`,
          );
        }
        if (res.saldoTotal !== null && res.giros.length > 0) {
          out(`  Saldo total: ${formatMoney(res.saldoTotal)}`);
        }
        if (res.aniosDescuadrados.length > 0) {
          out(
            `(Atención: en ${res.aniosDescuadrados.join(', ')} el conteo declarado por SII no ` +
              'coincide con las filas leídas — puede haber más resultados sin mostrar.)',
          );
        }
      });
    });
}
