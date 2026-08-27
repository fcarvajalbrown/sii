// Public BPST task API the surfaces call (ADR-003 / ADR-029). Boleta de Prestación de Servicios
// de Terceros Electrónica, read-only. `bpstList(periodo, side)` returns one month's boletas.
//
// SESSION-KEYED (ADR-005, by construction — no RUT field in the consulta form; mirrors BTE/F22/
// F29): reads ONLY self and REJECTS a representing operate pointer UP FRONT with an actionable
// "log in as the empresa" message — it ignores the pointer and takes NO `--rut`. The período is
// validated locally BEFORE any session. Pagination is paced via `Clock.sleep` (ADR-004); the
// facade reaches `zeus.sii.cl` via `PortalSession.goto` (bootstrap) + `requestForm` (query) — see
// docs/sii-contract/bpst.md.
import { withSession } from '../auth/index.js';
import { recordAudit } from '../audit/index.js';
import { readOperateState } from '../identity/index.js';
import { Periodo } from '../periodo/index.js';
import { Rut } from '../rut/index.js';
import { BpstError } from '../errors/index.js';
import { DEFAULT_SETTINGS } from '../config/index.js';
import { fetchBpstMensual } from '../portal/bpst.js';
import type { BpstMensual, BpstSide } from '../portal/bpst.js';
import type { AuditEntry, Runtime } from '../seams/index.js';

export type { BpstBoleta, BpstMensual, BpstSide, BpstTotales } from '../portal/bpst.js';

/** Inter-page pace (ms) for the monthly pagination fan-out — never hammer SII (ADR-004). */
const pacingMs = (): number => Math.round(1000 / DEFAULT_SETTINGS.rateLimitRps);

function audit(runtime: Runtime, action: string, result: string, extra: Partial<AuditEntry>): void {
  recordAudit(runtime, { action, result, ...extra });
}

/** Reject a representing operate pointer BEFORE opening a session (ADR-005, session-keyed). The
 *  empresa RUT is already user-visible (`operate --list`), so it is safe to echo; the razón social
 *  is PII and is NOT included. No operate state → defer to `withSession` (raises NotAuthenticated). */
async function assertSelfOperating(runtime: Runtime): Promise<void> {
  const op = await readOperateState(runtime.store);
  if (op && op.operatingRut !== op.selfRut) {
    throw new BpstError(
      `Las boletas de prestación de servicios de terceros son session-keyed: el SII autoriza ` +
        `por el titular de la sesión, no por el RUT operado (${Rut.parse(op.operatingRut).formatted}). ` +
        'Para las BPST de esa empresa, inicia sesión como ella (`sii auth logout` y luego `sii auth login`).',
    );
  }
}

/** One month's BPST boletas for the session principal (ADR-005), emitidas or recibidas. An empty
 *  month is a clean 0-boleta result, not an error. */
export async function bpstList(
  runtime: Runtime,
  args: { periodo: string; side: BpstSide },
): Promise<BpstMensual> {
  const periodo = Periodo.parse(args.periodo); // fail fast on a bad período — no session opened
  await assertSelfOperating(runtime);
  const start = runtime.clock.now().getTime();
  try {
    const res = await withSession(runtime, async (session, ctx) =>
      fetchBpstMensual(
        session,
        { rut: Rut.parse(ctx.sessionRut), periodo, side: args.side }, // session-keyed: the principal
        () => runtime.clock.sleep(pacingMs()),
      ),
    );
    audit(runtime, 'bpst_list', 'ok', {
      rut: res.rut,
      period: periodo.canonical,
      side: args.side,
      durationMs: runtime.clock.now().getTime() - start,
    });
    return res;
  } catch (e) {
    audit(runtime, 'bpst_list', 'failed', { period: periodo.canonical, side: args.side });
    throw e;
  }
}
