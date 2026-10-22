import type { HonorariosAnual, IvaMensual, MonitorCambio } from '@dostertags/sii-core';
import type { AuditInputs, Finding, Severity } from './api.js';

const MONITOR_TITLES: Record<MonitorCambio['tipo'], string> = {
  observacion_nueva: 'Nueva observación del SII en tu declaración de renta',
  observacion_resuelta: 'Observación del SII en tu declaración de renta resuelta',
  evento_nuevo: 'Nuevo movimiento del SII en tu declaración de renta',
  f22_sin_declaracion: 'Año sin declaración de renta (F22)',
  f29_mes_sin_declaracion: 'Mes sin declaración mensual (F29)',
  peticion_cambio_estado: 'Una petición administrativa cambió de estado',
  dj_observada: 'Declaración jurada observada',
  dj_cambio_estado: 'Una declaración jurada cambió de estado',
  giro_con_saldo: 'Giro con saldo por pagar',
  giro_nuevo: 'Nuevo giro emitido por el SII',
  notificacion_vigente: 'Notificación del SII vigente',
  cot_incumplimiento: 'Requisito de la Ley COT no cumplido',
};

const SEVERITY_ORDER: Record<Severity, number> = { alta: 0, media: 1, info: 2 };

const money = (value: number | null): string =>
  value === null ? 'sin dato' : `$${value.toLocaleString('es-CL')}`;

function monitorFindings(cambios: readonly MonitorCambio[]): Finding[] {
  return cambios.map((c) => ({
    severity: c.severidad,
    title: MONITOR_TITLES[c.tipo],
    scope: c.ambito,
    detail: c.detalle,
    source: 'Monitor de cumplimiento (lectura del SII)',
    figures: [],
  }));
}

function honorariosFindings(h: HonorariosAnual): Finding[] {
  return h.reconciliacion.mesesDescuadrados.flatMap((periodo): Finding[] => {
    const mes = h.meses.find((m) => m.periodo === periodo);
    if (!mes) return [];
    const withheld =
      mes.retencionReceptor === null && mes.bpstRetenido === null
        ? null
        : (mes.retencionReceptor ?? 0) + (mes.bpstRetenido ?? 0);
    const figures = [
      { label: 'Retenido en boletas de honorarios', value: withheld },
      { label: 'Propuesta F29, código 151', value: mes.f29Retencion },
      { label: 'Diferencia', value: mes.delta },
    ];
    const source = 'Boletas de honorarios y propuesta del F29 del SII';
    if (mes.delta === null) {
      return [
        {
          severity: 'info',
          title: 'Retenciones de honorarios sin cifra comparable',
          scope: `Honorarios ${periodo}`,
          detail: `El SII no entregó una de las dos cifras para ${periodo}, así que no se pudo comparar.`,
          source,
          figures,
        },
      ];
    }
    return [
      {
        severity: 'media',
        title: 'Las retenciones de honorarios no cuadran con el F29',
        scope: `Honorarios ${periodo}`,
        detail:
          `En ${periodo} se retuvieron ${money(withheld)} en boletas y la propuesta del F29 ` +
          `informa ${money(mes.f29Retencion)} en el código 151.`,
        source,
        figures,
      },
    ];
  });
}

function ivaFindings(iva: readonly IvaMensual[]): Finding[] {
  return iva.flatMap((m): Finding[] => {
    const r = m.reconciliacion;
    if (r.cuadra === true) return [];
    const figures = [
      { label: 'IVA débito según RCV', value: r.debitoRcv },
      { label: 'IVA débito según propuesta F29', value: r.debitoF29 },
      { label: 'Diferencia débito', value: r.deltaDebito },
      { label: 'IVA crédito según RCV', value: r.creditoRcv },
      { label: 'IVA crédito según propuesta F29', value: r.creditoF29 },
      { label: 'Diferencia crédito', value: r.deltaCredito },
    ];
    const source = 'Registro de Compras y Ventas y propuesta del F29 del SII';
    if (r.cuadra === null) {
      return [
        {
          severity: 'info',
          title: 'IVA sin cifra comparable en el F29',
          scope: `IVA ${m.periodo}`,
          detail: `La propuesta del F29 de ${m.periodo} no trae una cifra de IVA comparable con el registro.`,
          source,
          figures,
        },
      ];
    }
    return [
      {
        severity: 'media',
        title: 'El IVA del registro de compras y ventas no cuadra con el F29',
        scope: `IVA ${m.periodo}`,
        detail:
          `En ${m.periodo} el registro muestra IVA débito ${money(r.debitoRcv)} y crédito ` +
          `${money(r.creditoRcv)}; la propuesta del F29 informa ${money(r.debitoF29)} y ` +
          `${money(r.creditoF29)}.`,
        source,
        figures,
      },
    ];
  });
}

export function buildFindings(inputs: AuditInputs): Finding[] {
  const all = [
    ...(inputs.monitor ? monitorFindings(inputs.monitor.cambios) : []),
    ...(inputs.honorarios ? honorariosFindings(inputs.honorarios) : []),
    ...ivaFindings(inputs.iva),
  ];
  return all
    .map((finding, index) => ({ finding, index }))
    .sort(
      (a, b) =>
        SEVERITY_ORDER[a.finding.severity] - SEVERITY_ORDER[b.finding.severity] ||
        a.index - b.index,
    )
    .map(({ finding }) => finding);
}
