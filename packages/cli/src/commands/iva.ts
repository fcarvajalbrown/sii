// `sii iva <periodo>` — the monthly VAT reconciliation (ADR-022). A thin call into the
// `ivaMensual` composite task (ADR-003). SESSION-KEYED: reads the session principal, no `--rut`
// (the F29 half authorizes by the principal, so a represented empresa is rejected up front).
import type { Command } from 'commander';
import {
  ivaMensual,
  formatMoney as money,
  formatRut as fmtRut,
  type Runtime,
} from '@dostertags/sii-core';
import { emit, out } from '../io.js';

export function registerIva(program: Command, runtime: Runtime): void {
  program
    .command('iva')
    .description(
      'Cuadre de IVA de un período: cruza el IVA del RCV (compras/ventas) contra los totales ' +
        'del F29 (códigos 538/537). Compara contra la PROPUESTA del SII, no el formulario presentado.',
    )
    .argument('<periodo>', 'Período tributario (YYYYMM o YYYY-MM).')
    .option('--refresh', 'Ignora el caché local y relee desde el SII (ADR-027).')
    .action(async (periodo: string, opts: { refresh?: boolean }) => {
      const res = await ivaMensual(runtime, {
        periodo,
        ...(opts.refresh ? { refresh: true } : {}),
      });
      emit(res, () => {
        const r = res.reconciliacion;
        out(`IVA ${res.periodo} — ${fmtRut(res.rut)} (fuente: ${res.fuente})`);
        out('');
        const marca = (v: boolean | null): string => (v === true ? '✓' : v === false ? '✗' : '?');
        out(`  Débito fiscal (ventas)                       ${marca(r.cuadraDebito)}`);
        out(`    RCV:  ${money(r.debitoRcv)}`);
        out(
          `    F29:  ${money(r.debitoF29)}   [${r.debitoCodigo ? `código ${r.debitoCodigo}` : 'sin código comparable'}]`,
        );
        out(`    Δ:    ${money(r.deltaDebito)}`);
        out(`  Crédito fiscal (compras)                     ${marca(r.cuadraCredito)}`);
        out(`    RCV:  ${money(r.creditoRcv)}`);
        out(
          `    F29:  ${money(r.creditoF29)}   [${r.creditoCodigo ? `código ${r.creditoCodigo}` : 'sin código comparable'}]`,
        );
        out(`    Δ:    ${money(r.deltaCredito)}`);
        out('');
        // Three states, not two: claiming NO CUADRA for a figure SII never sent would accuse the
        // books of a mismatch that has not been shown (ADR-022 revision, live 2026-07-26).
        if (r.cuadra === true) {
          out('✓ CUADRA — el RCV y la propuesta del F29 coinciden.');
        } else if (r.cuadra === false) {
          out('⚠ NO CUADRA — hay una diferencia real entre el RCV y la propuesta.');
        } else {
          out('? INDETERMINADO — la propuesta del SII no trae una cifra comparable en algún lado.');
          out(
            '  Esto NO significa que tus libros estén mal: significa que no hay con qué comparar.',
          );
          out('  La propuesta suele traer los códigos COMPONENTES (511, 562…) y no los totales');
          out('  538/537, que el SII calcula al presentar el formulario.');
        }
        if (r.cuadra !== true) {
          if (!res.f29.tienePropuesta) {
            out('  El SII no tiene propuesta de F29 para este período (nada que comparar).');
          }
          out('  Revisa el detalle por tipo de documento para ubicar la diferencia:');
          for (const [label, lado] of [
            ['ventas', res.ventas],
            ['compras', res.compras],
          ] as const) {
            for (const t of lado.porTipo) {
              out(
                `    ${label} tipo=${t.codigoTipoDoc ?? '—'} ${t.descripcion ?? ''}  ` +
                  `docs=${t.totalDocumentos ?? '—'}  IVA=${money(t.montoIva)}`,
              );
            }
          }
        }
      });
    });
}
