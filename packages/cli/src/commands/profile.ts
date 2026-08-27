// `sii profile` — perfil del titular con domicilio propio + socios/representantes con opt-in
// explícito (ADR-041). Llamada fina a un task de @dostertags/sii-core (ADR-003).
// SESSION-KEYED: sin `--rut`.
import type { Command } from 'commander';
import { profile, formatRut as fmtRut, type Runtime } from '@dostertags/sii-core';
import { emit, out } from '../io.js';

export function registerProfile(program: Command, runtime: Runtime): void {
  program
    .command('profile')
    .description(
      'Perfil del titular: identidad, actividades, timbrajes y domicilio propio. ' +
        '--incluir-terceros agrega socios y representantes (PII de terceros, opt-in explícito).',
    )
    .option(
      '--incluir-terceros',
      'Incluye socios y representantes (RUT, nombre, participación) y el RUT del arrendador del domicilio.',
    )
    .action(async (opts: { incluirTerceros?: boolean }) => {
      const res = await profile(runtime, { incluirTerceros: opts.incluirTerceros === true });
      emit(res, () => {
        out(`Perfil — ${fmtRut(res.rut)}`);
        out(`  ${res.razonSocial ?? '—'}`);
        out(`  ${res.tipoContribuyente ?? '—'}${res.subtipoContribuyente ? ` · ${res.subtipoContribuyente}` : ''}`);
        out(`  Inicio de actividades: ${res.fechaInicioActividades ?? '—'}`);
        out('');

        out('Domicilio(s):');
        for (const d of res.direcciones) {
          out(`  ${d.calle ?? '—'}, ${d.comuna ?? '—'}, ${d.region ?? '—'} (${d.tipoDomicilio ?? '—'})`);
          if (res.incluyoTerceros && d.rutPropietario) {
            out(`    Propietario: ${fmtRut(`${d.rutPropietario}-${d.dvPropietario}`)}`);
          }
        }
        out('');

        if (res.incluyoTerceros) {
          out(`Socios (${res.socios.length}):`);
          for (const s of res.socios) {
            out(
              `  ${fmtRut(`${s.rut}-${s.dv}`)}  ${s.nombre ?? '—'}  ` +
                `(capital ${s.participacionCapital ?? '—'}%, utilidades ${s.participacionUtilidades ?? '—'}%)` +
                `${s.vigente === false ? ' [no vigente]' : ''}`,
            );
          }
          out(`Representantes (${res.representantes.length}):`);
          for (const r of res.representantes) {
            out(`  ${fmtRut(`${r.rut}-${r.dv}`)}  ${r.nombre ?? '—'}${r.vigente === false ? ' [no vigente]' : ''}`);
          }
        } else {
          out(
            `(Registra ${res.conteos.socios} socio(s) y ${res.conteos.representantes} representante(s); ` +
              'usa --incluir-terceros para verlos.)',
          );
        }
      });
    });
}
