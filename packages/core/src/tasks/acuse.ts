// Acuse de recibo / reclamo de DTE recibidos (ADR-036). NO es una fachada nueva: es una
// COMPOSICIÓN sobre `rcvListAll`, porque el estado de acuse ya viaja en el RCV
// (`detEventoReceptor`/`detEventoReceptorLeyenda`) — campos que ya se curaban pero cuyos valores
// nunca se habían documentado. Contrato: docs/sii-contract/rcv.md §eventoReceptor.
//
// POR QUÉ NO HAY FACHADA NUEVA (spike C, 2026-08-04): la app oficial de acuse
// (`www4.sii.cl/registrorechazodtej6ui`) **no es una bandeja de pendientes**, es una consulta de
// UN documento (RUT emisor + tipo + folio). SII no publica una lista de "pendientes de acuse", así
// que la pregunta del contador ("¿me queda algo por acusar?") hay que DERIVARLA del RCV.
//
// ⛔ SOLO LECTURA. Aceptar o reclamar un DTE es un acto con efecto jurídico (Ley 19.983): pasado
// el plazo la factura queda tácitamente aceptada y se vuelve título ejecutivo. Esa escritura NO se
// implementa aquí y exige su propio ADR con la postura de ADR-017/ADR-026.
import { rcvListAll } from './rcv.js';
import type { Runtime } from '../seams/index.js';

/** Un documento recibido con su estado de acuse. Todo verbatim de SII salvo `diasDesdeRecepcion`,
 *  que es aritmética local sobre `fechaRecepcion`. */
export interface AcuseDoc {
  readonly codigoTipoDoc: string;
  readonly folio: number | null;
  readonly rutEmisor: string | null;
  readonly razonSocial: string | null;
  readonly fechaEmision: string | null;
  readonly fechaRecepcion: string | null;
  readonly montoTotal: number | null;
  /** Código de SII, verbatim. Observados: `A`, `P`, `C` (ver `evento` en el contrato). */
  readonly evento: string | null;
  readonly eventoLeyenda: string | null;
  /** Días corridos entre `fechaRecepcion` y hoy. **Es un dato, NO un veredicto legal**: este
   *  proyecto no adjudica cuándo empieza a correr el plazo del Art. 3 de la Ley 19.983 — ese
   *  disparador depende de la recepción de las mercaderías/servicios, que el SII no expone
   *  (ADR-036). `null` si SII no entregó fecha de recepción interpretable. */
  readonly diasDesdeRecepcion: number | null;
}

/** Documentos agrupados por estado de acuse, con su monto acumulado. */
export interface AcuseGrupo {
  readonly evento: string | null;
  readonly leyenda: string | null;
  readonly documentos: number;
  readonly montoTotal: number;
}

export interface DteAcuseResult {
  readonly rut: string;
  readonly periodo: string;
  readonly totalDocumentos: number;
  readonly grupos: readonly AcuseGrupo[];
  /** Documentos para los que SII NO informó evento alguno.
   *
   *  ⚠️ **NO leer esto como "pendientes de acuse" sin mirar `sinEventoPorTipo` primero.** En los
   *  dos períodos observados en vivo (2026-06 y 2026-07, 1.859 documentos) el 100 % de los casos
   *  sin evento fueron Notas de Crédito (tipo `61`) y una DIN de importación (tipo `914`) —
   *  documentos a los que el régimen de acuse no parece aplicarse — mientras que TODAS las
   *  facturas (`33`/`34`) traían evento. Es decir: la ausencia de evento correlaciona con el TIPO
   *  de documento, no con una acción pendiente. Este proyecto NO afirma como regla que el tipo 61
   *  nunca lleve evento (ADR-004: dos períodos no son una regla), pero presentar esta lista como
   *  alarma sin desglosarla produciría un falso positivo. */
  readonly sinEvento: readonly AcuseDoc[];
  /** Conteo de `sinEvento` por tipo de DTE — el desglose que evita el falso positivo de arriba. */
  readonly sinEventoPorTipo: Readonly<Record<string, number>>;
  /** True cuando `rcvListAll` no pudo traer algún tipo de DTE: los grupos están incompletos. */
  readonly incompleto: boolean;
  readonly tiposRechazados: readonly string[];
}

const MS_DIA = 86_400_000;

/** `fechaRecepcion` llega como ISO `YYYY-MM-DD HH:MM:SS` (rcv.ts ya la normaliza). Se toma solo
 *  la parte de fecha para contar días corridos, sin arrastrar zona horaria. */
function diasDesde(fechaRecepcion: string | null, ahora: Date): number | null {
  if (fechaRecepcion === null) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(fechaRecepcion);
  if (!m) return null;
  const recep = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const hoy = Date.UTC(ahora.getFullYear(), ahora.getMonth(), ahora.getDate());
  const dias = Math.floor((hoy - recep) / MS_DIA);
  return Number.isFinite(dias) ? dias : null;
}

export interface DteAcuseArgs {
  readonly periodo: string;
  /** RCV es body-RUT (ADR-005): `--rut`/operate SÍ alcanza a una empresa representada. */
  readonly rut?: string;
}

/** Estado de acuse de los DTE RECIBIDOS en un período: cuántos en cada estado y cuáles quedaron
 *  sin evento informado por SII. Una sola sesión (la de `rcvListAll`). */
export async function dteAcuse(runtime: Runtime, args: DteAcuseArgs): Promise<DteAcuseResult> {
  // Sin recibo de auditoría propio: `rcvListAll` ya escribe el suyo y esta función no toca SII
  // por su cuenta — duplicarlo registraría dos lecturas donde hubo una (ADR-004).
  const all = await rcvListAll(runtime, {
    periodo: args.periodo,
    side: 'COMPRA',
    ...(args.rut !== undefined ? { rut: args.rut } : {}),
  });
  const ahora = runtime.clock.now();

  const docs: AcuseDoc[] = all.docs.map((d) => ({
    codigoTipoDoc: d.codigoTipoDoc,
    folio: d.folio,
    rutEmisor: d.rutEmisor,
    razonSocial: d.razonSocial,
    fechaEmision: d.fechaEmision,
    fechaRecepcion: d.fechaRecepcion,
    montoTotal: d.montoTotal,
    evento: d.eventoReceptor,
    eventoLeyenda: d.eventoReceptorLeyenda,
    diasDesdeRecepcion: diasDesde(d.fechaRecepcion, ahora),
  }));

  const porEvento = new Map<string, AcuseGrupo>();
  for (const d of docs) {
    const clave = `${d.evento ?? ''}|${d.eventoLeyenda ?? ''}`;
    const prev = porEvento.get(clave);
    porEvento.set(clave, {
      evento: d.evento,
      leyenda: d.eventoLeyenda,
      documentos: (prev?.documentos ?? 0) + 1,
      montoTotal: (prev?.montoTotal ?? 0) + (d.montoTotal ?? 0),
    });
  }

  const sinEvento = docs.filter((d) => d.evento === null);
  const sinEventoPorTipo: Record<string, number> = {};
  for (const d of sinEvento) {
    sinEventoPorTipo[d.codigoTipoDoc] = (sinEventoPorTipo[d.codigoTipoDoc] ?? 0) + 1;
  }

  return {
    rut: all.rut,
    periodo: all.periodo,
    totalDocumentos: docs.length,
    grupos: [...porEvento.values()].sort((a, b) => b.documentos - a.documentos),
    sinEvento,
    sinEventoPorTipo,
    incompleto: all.incomplete,
    tiposRechazados: all.rejectedTypes,
  };
}
