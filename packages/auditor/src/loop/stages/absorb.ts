// Stage 3 — ABSORB FEEDBACK (ADR-043).
//
// Pull in the three learning signals. They are genuinely different in kind, and conflating them is
// how a loop learns the wrong lesson:
//
//  1. AUDITOR CORRECTIONS since the last run (`ReviewQueue.resolvedSince`). The strongest signal —
//     a human looked at a specific value and said what it should have been. A `corrected` verdict
//     is ground truth. A `confirmed` verdict is quieter but still information: the extraction was
//     right and confidence was too low, which is evidence about the WEIGHTS, not the parser.
//
//  2. AUTOMATED CONSISTENCY CHECKS. Self-evident arithmetic that needs no human:
//       * do extracted line items reconcile to the declared totals? (F29 códigos summing to the
//         declared total; RCV detalle summing to the resumen)
//       * do subsidiary ledgers tie to the general ledger? (per-DTE-type detalle vs the resumen's
//         per-type magnitudes)
//     TWO TRAPS ARE ENCODED, both learned the hard way and both currently living in `CONVENTIONS`:
//       * RCV resumen rows are RAW MAGNITUDES, not pre-netted. A total that sums them without
//         subtracting the reversing types (nota de crédito, tipo 61) disagrees with SII's own
//         totals by exactly the reversed amount. That bug produced a phantom descuadre in 15 of 16
//         real months. A consistency check that repeats it would generate a nightly stream of
//         false corrections and teach the loop that the parser is broken when it is not.
//       * Per-page totals are not per-month totals. BPST under-counted a real month by 44.5% from
//         page one alone. A check must compare like with like or it manufactures discrepancies.
//
//  3. WEBAPP CHANGE DETECTIONS from stage 1 (`BehaviorMap.changesSince`). A structural change that
//     `breaksFacade` is a different diagnosis from a low-confidence extraction, even though both
//     present as bad data: one needs a parser fix, the other may just be an unusual month.
//
// This stage READS and CLASSIFIES. It changes no rule and fixes no parser — that is stages 4–7.

import { NotImplemented } from '../../errors.js';
import type { LoopContext, StageResult } from '../context.js';

export async function absorbStage(ctx: LoopContext): Promise<StageResult> {
  void ctx;
  throw new NotImplemented(
    'loop/stages/absorb',
    'needs the review queue and behavior map to be readable; the consistency checks additionally ' +
      'need the reversing-DTE netting rule (tipo 61) encoded as a rule record, or they will ' +
      'reproduce the phantom-descuadre bug as nightly false feedback',
  );
}
