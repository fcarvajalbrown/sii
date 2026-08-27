// `sii honorarios <anio>` — annual honorarios & retenciones reconciliation (ADR-023). A thin
// call into the `honorariosAnual` composite task (ADR-003). SESSION-KEYED: no `--rut`.
import type { Command } from 'commander';
import {
  honorariosAnual,
  formatMoney as money,
  formatRut as fmtRut,
  type Runtime,
} from '@dostertags/sii-core';
import { emit, out } from '../io.js';

export function registerHonorarios(program: Command, runtime: Runtime): void {
  program
    .command('honorarios')
    .description(
      'Cuadre anual de honorarios: cruza la retención de las BHE recibidas (la que retuviste tú) ' +
        'contra el código 151 del F29, mes a mes, y muestra los códigos de honorarios del F22. ' +
        'El año es el AÑO COMERCIAL; el F22 leído es el del año tributario siguiente. ' +
        'Compara contra la PROPUESTA del F29, no el formulario presentado.',
    )
    .argument('<anio>', 'Año comercial (YYYY) en que se recibieron las boletas.')
    .option('--refresh', 'Ignora el caché local y relee desde el SII (ADR-027).')
    .action(async (anio: string, opts: { refresh?: boolean }) => {
      const res = await honorariosAnual(runtime, {
        anio,
        ...(opts.refresh ? { refresh: true } : {}),
      });
      emit(res, () => {
        const r = res.reconciliacion;
        out(
          `Honorarios ${res.anioComercial} (F22 AT ${res.anioTributario}) — ${fmtRut(res.rut)} ` +
            `[fuente F29: ${res.fuente}]`,
        );
        out('');
        out('  Mes        boletas   honorarios   retuve(BHE)    declaré(F29 151)      Δ');
        for (const m of res.meses) {
          const flag = r.mesesDescuadrados.includes(m.periodo) ? ' ⚠' : '';
          out(
            `  ${m.periodo}  ${String(m.boletas ?? '—').padStart(7)}  ` +
              `${money(m.totalHonorarios).padStart(11)}  ${money(m.retencionReceptor).padStart(12)}  ` +
              `${money(m.f29Retencion).padStart(16)}  ${money(m.delta).padStart(8)}${flag}`,
          );
        }
        out('');
        out(`  Total retenido (BHE, lado receptor): ${money(r.retencionBhe)}`);
        out(`  Total declarado (F29 código 151):    ${money(r.retencionF29)}`);
        out(`  Diferencia:                          ${money(r.delta)}`);
        // The emisor side is reported but deliberately NOT reconciled (ADR-023).
        out(
          `  (retención del emisor, no declarable por ti: ${money(res.totales.retencionEmisor)})`,
        );
        out('');
        out(
          r.cuadra
            ? '✓ CUADRA — lo retenido coincide con lo declarado en todos los meses.'
            : `⚠ NO CUADRA en ${r.mesesDescuadrados.length} mes(es): ${r.mesesDescuadrados.join(', ')}`,
        );
        out('');
        out(`  F22 AT ${res.f22.anio} — folio ${res.f22.folio ?? '—'}`);
        if (res.f22.codigos.length === 0) {
          out('    Sin códigos de honorarios en la declaración.');
        } else {
          for (const c of res.f22.codigos) {
            const mark = c.enTaxonomia ? '' : '  [código no mapeado — glosa verbatim del SII]';
            out(`    ${c.codigo}  ${c.glosa ?? ''}  ${money(c.valor)}${mark}`);
          }
          out('    (los códigos del F22 se muestran para comparación; no se calcula diferencia)');
        }
        if (res.mesesConError.length > 0) {
          out('');
          out('  ⚠ Meses con error del SII (el resto sí se leyó):');
          for (const e of res.mesesConError) out(`    ${e.periodo}: ${e.mensaje}`);
        }
      });
    });
}
