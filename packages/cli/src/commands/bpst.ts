// `sii bpst …` — Boleta de Prestación de Servicios de Terceros Electrónica (ADR-029). Thin calls
// into @dostertags/sii-core tasks (ADR-003). Each domain module owns a `commands/<mod>.ts`
// exporting a `register<Mod>(program, runtime)`; `program.ts` just calls it (append-only tree).
//
// SESSION-KEYED (ADR-005): reads the session principal; no `--rut`.
//
// NAMING: distinct from `sii bte` (standard Boletas de Honorarios Electrónicas) despite SII's OWN
// UI calling THIS product "BTE" — see ADR-029's naming-collision note.
import type { Command } from 'commander';
import {
  bpstList,
  formatMoney as money,
  formatRut as fmtRut,
  type BpstSide,
  type Runtime,
} from '@dostertags/sii-core';
import { emit, out } from '../io.js';

const sideOf = (opts: { recibidas?: boolean }): BpstSide =>
  opts.recibidas ? 'RECIBIDAS' : 'EMITIDAS';

export function registerBpst(program: Command, runtime: Runtime): void {
  const bpst = program
    .command('bpst')
    .description('Boleta de Prestación de Servicios de Terceros Electrónica (BPST).');

  bpst
    .command('list')
    .description(
      'Boletas BPST de un período (EMITIDAS por defecto; --recibidas para las recibidas). ' +
        'EMITIDAS es el caso de uso principal: boletas que la empresa emite a nombre de ' +
        'trabajadores que no operan el portal SII por sí mismos. Este es el comando correcto ' +
        'cuando "sii bte list" devuelve 0 boletas para una empresa que sí emite BHE: son dos ' +
        'productos SII distintos aunque el propio portal SII llama "BTE" a ambos (ver ADR-029).',
    )
    .argument('<periodo>', 'Período tributario (YYYYMM o YYYY-MM).')
    .option('--recibidas', 'Boletas RECIBIDAS (por defecto: EMITIDAS).')
    .option('--emitidas', 'Boletas EMITIDAS (por defecto).')
    .action(async (periodo: string, opts: { recibidas?: boolean; emitidas?: boolean }) => {
      const res = await bpstList(runtime, { periodo, side: sideOf(opts) });
      emit(res, () => {
        out(`BPST ${res.side} ${res.periodo} — ${fmtRut(res.rut)}`);
        if (res.boletas.length === 0) {
          out('Sin boletas en el período.');
          return;
        }
        for (const b of res.boletas) {
          const contraparte = b.contraparteRut ? fmtRut(b.contraparteRut) : '—';
          const estado = b.estadoLabel ?? b.estado ?? '—';
          out(
            `  folio=${b.folio ?? '—'}  ${b.fecha ?? '—'}  ${contraparte}  ${b.contraparteNombre ?? ''}  ` +
              `bruto=${money(b.brutos)}  retenido=${money(b.retenidos)}  [${estado}]`,
          );
        }
        out(
          `${res.boletas.length} boleta(s); bruto total=${money(res.totales.brutos)}, ` +
            `retenido total=${money(res.totales.retenidos)}.`,
        );
      });
    });
}
