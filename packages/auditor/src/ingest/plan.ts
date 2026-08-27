// The default fetch plan (ADR-043 stage 1, ADR-044's `fetch` half).
//
// EVERY STEP IS A THIN CALL INTO A SHIPPED `core` TASK. There is no fetch code here and there must
// never be: `packages/core`'s facades are the live-observed, cited parsers this project spent a
// year acquiring (ADR-004), with the pacing, audit and session rails ADR-003 centralised. A step
// invokes one and lets `recordingDriver` capture the raw responses on the way past.
//
// WHAT IS IN THE PLAN, and why it is not "everything":
//
//   * The surfaces below are the ones the shipped reconciliations actually consume — RCV and F29
//     feed `iva`, F22 feeds `renta`, and DJ/giros/situación feed `monitor`. Fetching a surface
//     nothing reads costs a session's worth of SII requests and buys nothing.
//   * SESSION-KEYED surfaces (F22, F29, situación, DJ, giros) only ever read the logged-in
//     principal (ADR-005). A sweep therefore captures the taxpayer whose session is live; a
//     configured subject that is not logged in fails with SII's own `NotAuthenticated` message,
//     which stage 1 records per-taxpayer and moves on from.
//
// A NOTE ON WHAT A MULTI-TAXPAYER SWEEP REALLY MEANS. ADR-006 keeps login interactive, so one
// process holds one session. Sweeping N subjects is N logins, each triggered by a human before its
// own `sii-auditor fetch`. The stage supports N because the store and the manifest are
// multi-taxpayer, not because one invocation can authenticate as several people.

import {
  f22Status,
  f29Formulario,
  f29Overview,
  rcvSummary,
  situacionTributaria,
} from '@dostertags/sii-core';
import type { FetchStep } from '../loop/stages/ingest.js';

/**
 * Periods to refresh, newest first, derived from the runtime clock.
 *
 * Derived rather than configured so a run is reproducible from its manifest: the same `meses` and
 * the same clock always yield the same list.
 */
function recentPeriods(now: Date, meses: number): readonly string[] {
  const out: string[] = [];
  for (let i = 0; i < meses; i += 1) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    out.push(`${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

function recentYears(now: Date, anios: number): readonly string[] {
  const out: string[] = [];
  for (let i = 0; i < anios; i += 1) out.push(String(now.getUTCFullYear() - i));
  return out;
}

export const DEFAULT_FETCH_PLAN: readonly FetchStep[] = [
  {
    id: 'situacion',
    describes:
      'Situación tributaria — régimen, inicio de actividades, cumplimiento Ley COT (ADR-035)',
    async run(runtime) {
      await situacionTributaria(runtime);
    },
  },
  {
    id: 'rcv-resumen',
    describes: 'RCV resumen COMPRA + VENTA per período — the IVA ledger (ADR-022)',
    async run(runtime, scope) {
      for (const periodo of recentPeriods(runtime.clock.now(), scope.meses)) {
        // Both sides: `iva` reconciles débito (ventas) against crédito (compras).
        await rcvSummary(runtime, { periodo, side: 'COMPRA' });
        await rcvSummary(runtime, { periodo, side: 'VENTA' });
      }
    },
  },
  {
    id: 'f29-overview',
    describes: 'F29 per-month position across the refreshed range (ADR-013 Fase 1)',
    async run(runtime, scope) {
      const periods = recentPeriods(runtime.clock.now(), scope.meses);
      const hasta = periods[0];
      const desde = periods[periods.length - 1];
      if (hasta === undefined || desde === undefined) return;
      await f29Overview(runtime, { desde, hasta });
    },
  },
  {
    id: 'f29-propuesta',
    describes:
      'F29 propuesta per período — the ONE swept surface a registered strategy parses (f29-propuesta@2)',
    async run(runtime, scope) {
      // One SDI POST per período (`getDeclaracionConCondicionesYTipoPropuesta`). This step is what
      // gives extract something to match: without it the plan fetched only surfaces no strategy
      // parses, and every learn reported the whole store `unmatched` (ADR-046).
      for (const periodo of recentPeriods(runtime.clock.now(), scope.meses)) {
        await f29Formulario(runtime, { periodo });
      }
    },
  },
  {
    id: 'f22-status',
    describes: 'F22 estado per año tributario — the annual return (ADR-019)',
    async run(runtime, scope) {
      for (const anio of recentYears(runtime.clock.now(), scope.anios)) {
        await f22Status(runtime, { anio });
      }
    },
  },
];
