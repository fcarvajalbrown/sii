// `sii notificaciones …` — Notificaciones formales / Correspondencia (ADR-032). Thin calls into
// @dostertags/sii-core tasks (ADR-003). SESSION-KEYED: reads the session principal; no
// `--rut` (no represented-empresa reach observed live — see the ADR).
import type { Command } from 'commander';
import {
  formatRut as fmtRut,
  notificacionesDetalle,
  notificacionesList,
  type Runtime,
} from '@dostertags/sii-core';
import { emit, out } from '../io.js';

export function registerNotificaciones(program: Command, runtime: Runtime): void {
  const notif = program
    .command('notificaciones')
    .description('Notificaciones formales y Correspondencia que el SII ha enviado al titular.');

  notif
    .command('list')
    .description(
      'Lista Notificaciones formales (default — "Mis Notificaciones Vigentes": citaciones, ' +
        'liquidaciones, resoluciones) o Correspondencia (--correspondencia: cartas/avisos/correos).',
    )
    .option('--correspondencia', 'Leer Correspondencia en vez de Notificaciones formales.')
    .action(async (opts: { correspondencia?: boolean }) => {
      const categoria = opts.correspondencia ? 'correspondencia' : 'formal';
      const res = await notificacionesList(runtime, { categoria });
      emit(res, () => {
        out(`${res.categoria === 'FORMAL' ? 'Notificaciones formales' : 'Correspondencia'} — ${fmtRut(res.rut)}`);
        if (res.items.length === 0) {
          out('Sin registros.');
        }
        for (const item of res.items) {
          const fecha = item.fechaEpochMs !== null ? new Date(item.fechaEpochMs).toISOString().slice(0, 10) : '—';
          out(`  id=${item.id ?? '—'}  ${fecha}  [${item.tipo ?? '?'}] ${item.tipoNotificacion ?? ''}  ${item.descripcion ?? ''}`);
        }
        if (res.masPaginas) {
          out('(Hay más páginas de resultados que este comando aún no recorre.)');
        }
      });
    });

  notif
    .command('detalle')
    .description('Contenido de una Notificación/Correspondencia — asunto, remitente/destinatario, cuerpo.')
    .argument('<id>', 'Id del ítem (de `notificaciones list`).', (v: string) => Number(v))
    .argument('<tipo>', 'Código "tipo" del ítem (de `notificaciones list`).')
    .option('--correspondencia', 'El id pertenece a Correspondencia, no a Notificaciones formales.')
    .action(async (id: number, tipo: string, opts: { correspondencia?: boolean }) => {
      const categoria = opts.correspondencia ? 'correspondencia' : 'formal';
      const res = await notificacionesDetalle(runtime, { categoria, id, tipo });
      emit(res, () => {
        out(`Detalle ${res.categoria} id=${res.id} — ${fmtRut(res.rut)}`);
        out(`  Asunto: ${res.asunto ?? '—'}`);
        out(`  De: ${res.from ?? '—'}  Para: ${res.to ?? '—'}`);
        if (res.adjuntos.length > 0) {
          out(`  Adjuntos: ${res.adjuntos.map((a) => a.nombre ?? '(sin nombre)').join(', ')}`);
        }
        if (res.tieneCertificado) out('  (Incluye certificado de envío.)');
        out('');
        out(res.bodyHtml ?? '(sin contenido)');
      });
    });
}
