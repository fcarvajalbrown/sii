import type { AuditEntry, AuditSink, Clock } from '../seams/index.js';

/** Keys whose presence (substring, case-insensitive) means "secret" — dropped
 *  before the line hits the sink. RUTs are NOT secrets and pass through. */
const SECRET_KEY = /password|clave|cookie|secret|token/i;

/** Recursion cap. Audit entries are shallow by construction; this only stops a pathological or
 *  cyclic structure from blowing the stack (the sink is best-effort and must never throw). */
const MAX_DEPTH = 8;

/** Strip secret-named keys at ANY depth. A depth-1 scrub let a nested `{detail:{cookie}}` reach
 *  the log verbatim (code review F-04) — and this scrub is the DOCUMENTED safety net for the
 *  audit file, while new modules are added by an append-only pattern that invites richer
 *  objects. Non-objects pass through untouched; arrays are scrubbed element-wise. */
function scrub(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) return '[depth]';
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
  // `typeof null === 'object'`, so null must be excluded before treating this as a record.
  if (typeof value !== 'object' || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY.test(k)) continue;
    out[k] = scrub(v, depth + 1);
  }
  return out;
}

/** Compose the final receipt: stamp `ts` from the clock, drop secret-substring
 *  keys AT EVERY DEPTH, hand it to the sink. Never throws (the sink is best-effort). (ADR-004) */
export function recordAudit(deps: { clock: Clock; audit: AuditSink }, entry: AuditEntry): void {
  const safe: Record<string, unknown> = { ts: deps.clock.now().toISOString() };
  for (const [k, v] of Object.entries(entry)) {
    if (SECRET_KEY.test(k)) continue;
    safe[k] = scrub(v, 1);
  }
  deps.audit.record(safe as AuditEntry);
}
