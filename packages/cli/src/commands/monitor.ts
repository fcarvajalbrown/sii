// `sii monitor` — the compliance sweep (ADR-024). A thin call into the `monitorSweep` task
// (ADR-003). SESSION-KEYED: no `--rut`. Stateful: it compares against a stored baseline in
// `~/.sii/monitor.json` (identifiers and states only — never SII free text).
import type { Command } from 'commander';
import { monitorSweep, formatRut as fmtRut, type Runtime } from '@dostertags/sii-core';
import { emit, out } from '../io.js';

const ICONO = { alta: '🔴', media: '🟡', info: '·' } as const;

export function registerMonitor(program: Command, runtime: Runtime): void {
  program
    .command('monitor')
    .description(
      'Barrido de cumplimiento: observaciones e historial del F22, meses sin F29, peticiones, ' +
        'DJ observadas, notificaciones formales vigentes, giros con saldo y requisitos de la Ley ' +
        'COT incumplidos. Reporta QUÉ CAMBIÓ desde la última corrida; la primera fija la línea ' +
        'base (las deficiencias actuales se listan igual).',
    )
    .option('--anios <n>', 'Años tributarios a revisar (por defecto 3).', (v: string) => Number(v))
    .option('--meses <n>', 'Meses de F29 a revisar (por defecto 12).', (v: string) => Number(v))
    .option('--dry-run', 'Reporta sin mover la línea base.')
    .action(async (opts: { anios?: number; meses?: number; dryRun?: boolean }) => {
      const res = await monitorSweep(runtime, {
        ...(opts.anios !== undefined ? { anios: opts.anios } : {}),
        ...(opts.meses !== undefined ? { meses: opts.meses } : {}),
        ...(opts.dryRun ? { dryRun: true } : {}),
      });
      emit(res, () => {
        out(`Monitor de cumplimiento — ${fmtRut(res.rut)}`);
        out(
          `  Ventana: ${res.resumen.anios} año(s) tributario(s), ${res.resumen.meses} mes(es) de F29.`,
        );
        if (res.baseline) {
          out('  ⓘ Primera corrida: línea base establecida. La detección de cambios queda armada');
          out('    desde la próxima corrida (las deficiencias actuales sí se listan abajo).');
        }
        if (res.dryRun) out('  ⓘ --dry-run: la línea base NO se actualizó.');
        out('');
        out(
          `  Observaciones vigentes: ${res.resumen.observaciones} · eventos: ${res.resumen.eventos} · ` +
            `años sin F22: ${res.resumen.aniosSinF22} · meses sin F29: ${res.resumen.mesesSinDeclaracion} · ` +
            `peticiones: ${res.resumen.peticiones}`,
        );
        out(
          `  DJ observadas: ${res.resumen.djObservadas} · notificaciones formales: ` +
            `${res.resumen.notificacionesVigentes} · giros con saldo: ${res.resumen.girosConSaldo} · ` +
            `requisitos Ley COT incumplidos: ${res.resumen.cotIncumplidos}`,
        );
        out('');
        if (res.cambios.length === 0) {
          out('✓ Sin hallazgos.');
        } else {
          out(`Hallazgos (${res.cambios.length}):`);
          // Most severe first — the actionable part goes at the top.
          const orden = { alta: 0, media: 1, info: 2 } as const;
          for (const c of [...res.cambios].sort(
            (a, b) => orden[a.severidad] - orden[b.severidad],
          )) {
            out(`  ${ICONO[c.severidad]} [${c.ambito}] ${c.detalle}`);
          }
        }
        if (res.errores.length > 0) {
          out('');
          out('⚠ Señales con error del SII (el resto sí se revisó):');
          for (const e of res.errores) out(`  ${e.ambito}: ${e.mensaje}`);
        }
      });
    });
}
