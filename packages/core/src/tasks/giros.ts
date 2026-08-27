// API pública de giros que consumen las superficies (ADR-003 / ADR-034). SOLO LECTURA —
// nunca alcanza el flujo de pago de la misma app SII (ver el encabezado de `portal/giros.ts`).
// SESSION-KEYED: maneja la propia UI del SII, que opera sobre el titular de la sesión.
import { withSession } from '../auth/index.js';
import { recordAudit } from '../audit/index.js';
import { DEFAULT_SETTINGS } from '../config/index.js';
import { GirosError } from '../errors/index.js';
import { readOperateState } from '../identity/index.js';
import { Anio } from '../periodo/index.js';
import { Rut } from '../rut/index.js';
import { fetchGirosAnual, type Giro } from '../portal/giros.js';
import type { AuditEntry, Runtime } from '../seams/index.js';

export type { Giro } from '../portal/giros.js';

const DEFAULT_YEARS = 1;
const MAX_YEARS = 10;

const pacingMs = (): number => Math.round(1000 / DEFAULT_SETTINGS.rateLimitRps);

function audit(runtime: Runtime, action: string, result: string, extra: Partial<AuditEntry>): void {
  recordAudit(runtime, { action, result, ...extra });
}

/** Rechaza un puntero operate representando a otro RUT ANTES de abrir sesión (ADR-005): esta
 *  fachada maneja la UI del SII, que siempre actúa sobre el titular de la sesión. */
async function assertSelfOperating(runtime: Runtime): Promise<void> {
  const op = await readOperateState(runtime.store);
  if (op && op.operatingRut !== op.selfRut) {
    throw new GirosError(
      `La consulta de giros es session-keyed: el SII autoriza por el titular de la sesión, no por ` +
        `el RUT operado (${Rut.parse(op.operatingRut).formatted}). Para los giros de esa empresa, ` +
        'inicia sesión como ella (`sii auth logout` y luego `sii auth login`).',
    );
  }
}

/** Un giro con el año bajo el que fue consultado. */
export interface GiroConAnio extends Giro {
  readonly anio: string;
}

export interface GirosResult {
  readonly rut: string;
  /** Años efectivamente consultados, del más reciente al más antiguo. */
  readonly anios: readonly string[];
  readonly giros: readonly GiroConAnio[];
  /** Suma de los saldos interpretables. `null` cuando ningún giro trajo saldo legible. */
  readonly saldoTotal: number | null;
  /** Años donde el conteo declarado por SII no coincidió con las filas leídas — señal de
   *  truncamiento/paginación no observada, nunca silenciada. */
  readonly aniosDescuadrados: readonly string[];
}

export interface GirosListArgs {
  /** Año único a consultar. Excluye `years`. */
  readonly anio?: string;
  /** Cuántos años hacia atrás barrer desde el actual (por defecto 1, máx 10). */
  readonly years?: number;
}

/** Giros emitidos al titular. Por defecto solo el año en curso; `anio` fija uno, `years` barre
 *  hacia atrás. Todo en UNA sesión, paceado, sin reintentos (ADR-004). */
export async function girosList(runtime: Runtime, args: GirosListArgs): Promise<GirosResult> {
  const anios: Anio[] = args.anio
    ? [Anio.parse(args.anio)] // valida antes de abrir sesión
    : (() => {
        const n = Math.min(MAX_YEARS, Math.max(1, Math.trunc(args.years ?? DEFAULT_YEARS)));
        const current = runtime.clock.now().getFullYear();
        return Array.from({ length: n }, (_, i) => Anio.of(current - i));
      })();

  await assertSelfOperating(runtime);
  const start = runtime.clock.now().getTime();

  try {
    const result = await withSession(runtime, async (session, ctx) => {
      const rut = Rut.parse(ctx.sessionRut); // session-keyed: siempre el titular
      const pace = (): Promise<void> => runtime.clock.sleep(pacingMs());
      const giros: GiroConAnio[] = [];
      const descuadrados: string[] = [];

      for (let i = 0; i < anios.length; i++) {
        if (i > 0) await pace();
        const anio = anios[i]!;
        const res = await fetchGirosAnual(session, { rut, anio }, pace);
        for (const g of res.giros) giros.push({ ...g, anio: anio.canonical });
        if (res.conteoDeclarado !== null && res.conteoDeclarado !== res.giros.length) {
          descuadrados.push(anio.canonical);
        }
      }

      const conSaldo = giros.filter((g) => g.saldo !== null);
      return {
        rut: rut.canonical,
        anios: anios.map((a) => a.canonical),
        giros,
        saldoTotal: conSaldo.length > 0 ? conSaldo.reduce((a, g) => a + (g.saldo ?? 0), 0) : null,
        aniosDescuadrados: descuadrados,
      } satisfies GirosResult;
    });

    // Recibo: rut, años y conteo. NUNCA un folio ni un monto (ADR-006).
    audit(runtime, 'giros_list', 'ok', {
      rut: result.rut,
      period: result.anios.join(','),
      count: result.giros.length,
      durationMs: runtime.clock.now().getTime() - start,
    });
    return result;
  } catch (e) {
    audit(runtime, 'giros_list', 'failed', { period: anios.map((a) => a.canonical).join(',') });
    throw e;
  }
}
