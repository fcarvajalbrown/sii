// Public peticiones task the surfaces call (ADR-003). Wraps the GWT-RPC facade in
// `withSession` — consume a live session, resolve the body RUT (override > pointer > self,
// ADR-005) — and writes ONE audit receipt. Peticiones is BODY-RUT (like RCV): `--rut`/
// operate selects a represented empresa; the operable-set gate lives in `withSession`.
// The audit records only that a read happened (rut + count) — NEVER petition contents
// (materia, estados, the SII messages are PII/business data, ADR-006 / ADR-020).
import { withSession } from '../auth/index.js';
import { recordAudit } from '../audit/index.js';
import { DEFAULT_SETTINGS } from '../config/index.js';
import { Rut } from '../rut/index.js';
import { fetchPeticiones } from '../portal/peticiones.js';
import type { PeticionesResult } from '../portal/peticiones.js';
import type { AuditEntry, Runtime } from '../seams/index.js';

export type { EstadoPeticion, Peticion, PeticionesResult } from '../portal/peticiones.js';

interface PeticionesArgs {
  /** Per-call operating RUT override (must be in the operable set); else the pointer. */
  readonly rut?: string;
}

const sessionOpts = (rut?: string): { rut?: string } => (rut !== undefined ? { rut } : {});

/** Pace for the policy-hash self-heal fan-out. The happy path is ONE POST; this only bounds the
 *  rare rotation case, which was previously unpaced and uncapped (code review F-07, ADR-004). */
const pacingMs = (): number => Math.round(1000 / DEFAULT_SETTINGS.rateLimitRps);

function audit(runtime: Runtime, result: string, extra: Partial<AuditEntry>): void {
  recordAudit(runtime, { action: 'peticiones_list', result, ...extra });
}

export async function peticionesList(
  runtime: Runtime,
  args: PeticionesArgs = {},
): Promise<PeticionesResult> {
  const start = runtime.clock.now().getTime();
  try {
    const { res, sessionRut } = await withSession(
      runtime,
      async (session, ctx) => ({
        res: await fetchPeticiones(session, { rut: Rut.parse(ctx.operatingRut) }, () =>
          runtime.clock.sleep(pacingMs()),
        ),
        sessionRut: ctx.sessionRut,
      }),
      sessionOpts(args.rut),
    );
    audit(runtime, 'ok', {
      rut: res.rut,
      count: res.peticiones.length,
      durationMs: runtime.clock.now().getTime() - start,
      ...(res.rut !== sessionRut ? { rutAuth: sessionRut } : {}),
    });
    return res;
  } catch (e) {
    audit(runtime, 'failed', {});
    throw e;
  }
}
