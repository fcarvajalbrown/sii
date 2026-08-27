// `sii situacion` — situación tributaria del titular (ADR-035). Llamada fina a un task de
// @dostertags/sii-core (ADR-003). SESSION-KEYED: sin `--rut`.
import type { Command } from 'commander';
import { formatRut as fmtRut, situacionTributaria, type Runtime } from '@dostertags/sii-core';
import { emit, out } from '../io.js';

export function registerSituacion(program: Command, runtime: Runtime): void {
  program
    .command('situacion')
    .description(
      'Situación tributaria: régimen vigente, inicio de actividades, actividades económicas, ' +
        'documentos timbrados y cumplimiento de las obligaciones de la Ley COT.',
    )
    .action(async () => {
      const res = await situacionTributaria(runtime);
      emit(res, () => {
        const p = res.perfil;
        out(`Situación tributaria — ${fmtRut(res.rut)}`);
        out(`  ${p.razonSocial ?? '—'}`);
        out(`  ${p.tipoContribuyente ?? '—'}${p.subtipoContribuyente ? ` · ${p.subtipoContribuyente}` : ''}`);
        out(`  Segmento: ${p.segmento ?? '—'}`);
        out(`  Inicio de actividades: ${p.fechaInicioActividades ?? '—'}`);
        if (p.fechaTerminoGiro) out(`  ⚠ Término de giro: ${p.fechaTerminoGiro}`);
        out('');

        out('Régimen tributario:');
        if (res.regimenes.length === 0) out('  (sin régimen informado)');
        for (const r of res.regimenes) {
          out(`  ${r.codigo ?? '—'}  ${r.descripcion ?? ''}  desde ${r.fechaInicio ?? '—'}`);
          if (r.detalle) out(`      ${r.detalle}`);
        }
        out('');

        out(`Obligaciones (Ley COT): ${res.cumplimiento.estado ?? '—'}`);
        for (const q of res.cumplimiento.requisitos) {
          const marca = q.cumple === true ? 'OK  ' : q.cumple === false ? 'FALLA' : '?   ';
          out(`  [${marca}] ${q.titulo ?? q.codigo ?? '—'}`);
        }
        if (res.requisitosIncumplidos.length > 0) {
          out(`  ⚠ Incumplidos: ${res.requisitosIncumplidos.length}`);
        }
        out('');

        out('Actividades económicas:');
        for (const a of p.actividades) {
          out(
            `  ${a.codigo ?? '—'}  ${a.descripcion ?? ''}  ` +
              `(cat. ${a.categoriaTributaria ?? '—'}, IVA ${a.afectoIva === true ? 'sí' : a.afectoIva === false ? 'no' : '—'}, desde ${a.fechaInicio ?? '—'})`,
          );
        }
        out('');

        out('Documentos timbrados:');
        for (const t of p.timbrajes) {
          out(`  ${t.codigo ?? '—'}  ${t.descripcion ?? ''}  ${t.fechaLegalizacion ?? ''}`);
        }
        out('');
        out(
          `(Registra ${p.conteos.socios} socio(s), ${p.conteos.representantes} representante(s) y ` +
            `${p.conteos.direcciones} dirección(es); sus datos no se muestran por ser de terceros.)`,
        );
      });
    });
}
