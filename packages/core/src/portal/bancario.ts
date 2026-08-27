// Informe bancario — abonos por semestre, por banco y tipo de cuenta (ADR-039). Contrato
// completo: docs/sii-contract/bancario.md.
//
// Va sobre el MISMO CGI que `situacion.ts` (ADR-035) y `notificaciones.ts` (ADR-032) — Mi SII
// `CViewCarta.cgi` — con OTRO `opc` (119) y OTRO envelope propio (ese CGI no tiene forma común).
//
// ⚠️ SII envuelve la respuesta bajo la clave `listCarpetaTributaria` — un nombre engañoso que NO
// tiene relación con la Carpeta Tributaria Regular (ADR-033, un producto SII distinto). El tipo
// curado de este módulo nunca usa ese nombre, precisamente para no confundir los dos.
import { z } from 'zod';
import { HOSTS } from '../config/index.js';
import { BancarioError } from '../errors/index.js';
import type { PortalSession } from '../seams/index.js';

const asStr = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
};
const asNum = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Un semestre de abonos para un banco/tipo de cuenta. */
export interface InformeBancarioSemestre {
  /** Código de período de SII, VERBATIM — observado con dos valores distintos (`202502` y
   *  `202507`) llevando la MISMA glosa de `semestre` ("Primer semestre 2025"); no hay evidencia
   *  suficiente para decodificarlo de forma confiable (ADR-004, ADR-039). */
  readonly periodoDj: string | null;
  /** Glosa de SII, verbatim — ver la advertencia de `periodoDj` arriba. */
  readonly semestre: string | null;
  readonly banco: string | null;
  readonly tipoCuenta: string | null;
  readonly cantidadAbonos: number | null;
  readonly montoTotalAbonos: number | null;
}

const FilaSchema = z
  .object({
    periodoDj: z.unknown().optional(),
    glosaNombreBanco: z.unknown().optional(),
    glosaTipoCuenta: z.unknown().optional(),
    semestre: z.unknown().optional(),
    sumaCantidadAbonos: z.unknown().optional(),
    sumaMontoTotalAbonos: z.unknown().optional(),
  })
  .loose();

const EnvelopeSchema = z
  .object({
    // REQUERIDO (no `.nullish()`): la única señal de forma reconocida en este envelope es la
    // presencia de esta clave — un `[]` explícito es "sin informe" (legítimo), pero su AUSENCIA
    // total es una respuesta con forma irreconocible.
    listCarpetaTributaria: z.array(FilaSchema),
  })
  .loose();

/** Lee el informe bancario de abonos del titular de la sesión (sin parámetro de RUT — el mismo
 *  patrón session-keyed que `situacion`/`notificaciones`, ADR-039). Una fila vacía (`[]`) es un
 *  resultado legítimo ("sin informe"), nunca un error. */
export async function fetchInformeBancario(
  session: PortalSession,
): Promise<readonly InformeBancarioSemestre[]> {
  const res = await session.requestForm(HOSTS.notificacionesCgi, {
    method: 'POST',
    form: { opc: '119', VIEW: '1' },
  });
  let raw: unknown;
  try {
    raw = JSON.parse(res.body) as unknown;
  } catch {
    throw new BancarioError('Respuesta inesperada de SII (no es JSON) al consultar el informe bancario.');
  }
  const parsed = EnvelopeSchema.safeParse(raw);
  if (!parsed.success) {
    throw new BancarioError(
      'Respuesta inesperada de SII (formato no reconocido) al consultar el informe bancario.',
    );
  }
  return parsed.data.listCarpetaTributaria.map((f) => ({
    periodoDj: asStr(f.periodoDj),
    semestre: asStr(f.semestre),
    banco: asStr(f.glosaNombreBanco),
    tipoCuenta: asStr(f.glosaTipoCuenta),
    cantidadAbonos: asNum(f.sumaCantidadAbonos),
    montoTotalAbonos: asNum(f.sumaMontoTotalAbonos),
  }));
}
