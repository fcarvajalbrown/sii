// `sii renta <anio>` — the annual pack (ADR-022). A thin call into the `rentaAnual` composite
// task (ADR-003). SESSION-KEYED: reads the session principal, no `--rut`.
import type { Command } from 'commander';
import {
  rentaAnual,
  formatMoney as money,
  formatRut as fmtRut,
  type Runtime,
} from '@dostertags/sii-core';
import { emit, out } from '../io.js';

export function registerRenta(program: Command, runtime: Runtime): void {
  program
    .command('renta')
    .description(
      'Pack anual de renta: el F22 del año tributario (folio, estado y el formulario agrupado) ' +
        'junto a las doce posiciones mensuales del F29 del año comercial que declara (año - 1).',
    )
    .argument('<anio>', 'Año tributario (YYYY). El F22 de AT N declara el año comercial N-1.')
    .option('--refresh', 'Ignora el caché local y relee desde el SII (ADR-027).')
    .action(async (anio: string, opts: { refresh?: boolean }) => {
      const res = await rentaAnual(runtime, {
        anio,
        ...(opts.refresh ? { refresh: true } : {}),
      });
      emit(res, () => {
        out(`Renta AT ${res.anio} (año comercial ${res.anioComercial}) — ${fmtRut(res.rut)}`);
        out('');
        out('  F22');
        if (!res.f22.tieneDeclaracion) {
          out('    Sin declaración para el año tributario.');
        } else {
          out(`    folio=${res.f22.folio ?? '—'}  estado=${res.f22.estado ?? '—'}`);
          const g = res.f22.grupos;
          if (g) {
            for (const [label, lineas] of [
              ['ingresos', g.ingresos],
              ['deducciones', g.deducciones],
              ['retenciones · PPM · créditos', g.creditos],
              ['cálculo', g.calculo],
              ['resultado', g.resultado],
              ['otros', g.otros],
            ] as const) {
              if (lineas.length === 0) continue;
              out(`    ${label}:`);
              for (const l of lineas) {
                out(`      ${l.codigo}  ${l.glosa ?? ''}  ${money(l.valor)}`);
              }
            }
          }
        }
        out('');
        out(`  F29 ${res.anioComercial} — ${res.iva.mesesConDeclaracion}/12 meses declarados`);
        for (const m of res.iva.meses) {
          const marca = m.tieneDeclaracion ? '' : '  (sin declaración)';
          out(
            `    ${m.periodo}  folio=${m.folio ?? '—'}  ${m.estado ?? '—'}  ` +
              `total=${money(m.total)}${marca}`,
          );
        }
        out(`  Total declarado en el año: ${money(res.iva.totalDeclarado)}`);
      });
    });
}
