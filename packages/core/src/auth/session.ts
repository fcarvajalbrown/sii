import { DEFAULT_SETTINGS } from '../config/index.js';
import { SessionExpiredError } from '../errors/index.js';
import { NotAuthenticatedError } from '../errors/index.js';
import { readOperateState, resolveOperableTarget } from '../identity/index.js';
import type { Clock, KeyValueStore, PortalSession, Runtime } from '../seams/index.js';

// Distinct KeyValueStore key (ADR-007) — never shares a file with `identity`'s 'operate'.
const SESSION_KEY = 'session';

export interface StoredSession {
  /** Canonical session-principal RUT (read from the portal, not a credential). */
  readonly rut: string;
  /** Cookies-only storage state (opaque to the core). */
  readonly cookies: unknown;
  readonly savedAt: string;
}

export async function readSession(store: KeyValueStore): Promise<StoredSession | null> {
  return store.read<StoredSession>(SESSION_KEY);
}

export async function writeSession(store: KeyValueStore, session: StoredSession): Promise<void> {
  await store.write(SESSION_KEY, session);
}

export async function deleteSession(store: KeyValueStore): Promise<void> {
  await store.delete(SESSION_KEY);
}

/** Is the stored jar older than the configured TTL? A LOCAL staleness hint only — SII remains
 *  the authority and the first real request is still the liveness test. Enforcing it fails fast
 *  instead of spending a doomed round-trip, and shortens the window in which a stolen jar is
 *  useful. Before this the TTL had zero consumers and a jar was reused forever (code review
 *  F-05). An unparseable `savedAt` is NOT treated as expired: we never lock a user out on a
 *  local parsing detail — let SII decide. */
function jarIsStale(savedAt: string, clock: Clock): boolean {
  const saved = Date.parse(savedAt);
  if (Number.isNaN(saved)) return false;
  const ageMinutes = (clock.now().getTime() - saved) / 60_000;
  return ageMinutes > DEFAULT_SETTINGS.sessionTtlMinutes;
}

export interface SessionContext {
  /** Canonical session-principal RUT (who is logged in). */
  readonly sessionRut: string;
  /** Canonical RUT this operation acts as: `--rut` override > operate pointer > self
   *  (ADR-005). Body-RUT facades put this in the request; session-keyed surfaces
   *  ignore it and authorize by `sessionRut`. */
  readonly operatingRut: string;
}

/** Acquire a live `PortalSession` from the stored cookies-only session and run `fn`
 *  against it. This is how DOMAIN TASKS reach SII: they consume a session, they
 *  NEVER mint one (only `login` mints — ADR-006, sii-py ADR-019). The operating/body
 *  RUT is resolved by precedence (override > pointer > self — ADR-005) and handed to
 *  `fn`. The session is ALWAYS closed; a missing local session raises
 *  `NotAuthenticated`. It does NOT eagerly probe liveness — an expired cookie jar
 *  surfaces as the facade's own typed error (representacion.ts) — and it NEVER
 *  retries after a SII block (CONVENTIONS). */
export async function withSession<T>(
  runtime: Runtime,
  fn: (session: PortalSession, ctx: SessionContext) => Promise<T>,
  options: { rut?: string } = {},
): Promise<T> {
  const stored = await readSession(runtime.store);
  if (!stored) {
    throw new NotAuthenticatedError('No hay sesión. Ejecuta `sii auth login`.');
  }
  // Local staleness gate (ADR-004 pacing spirit: don't spend a request that cannot succeed).
  // SessionExpired is a NotAuthenticated subclass, so a generic catch still treats it as such.
  if (jarIsStale(stored.savedAt, runtime.clock)) {
    throw new SessionExpiredError(
      'La sesión guardada superó su tiempo de vida local y probablemente ya expiró en el SII. ' +
        'Ejecuta `sii auth login`.',
    );
  }
  // Resolve the operating/body RUT (ADR-005). A `--rut` override is the same
  // value-domain as the operate pointer, so it is validated against the operable set
  // HERE (empresa account / out-of-set RUT rejected locally, not round-tripped to SII)
  // — the single enforcement point for per-call `--rut`. No override → the operate
  // pointer; missing operate state alongside a session is broken → re-login.
  const operateState = await readOperateState(runtime.store);
  let operatingRut: string;
  if (options.rut !== undefined) {
    if (!operateState) {
      throw new NotAuthenticatedError('No hay sesión. Ejecuta `sii auth login`.');
    }
    operatingRut = resolveOperableTarget(operateState, options.rut);
  } else {
    operatingRut = operateState?.operatingRut ?? stored.rut;
  }

  let s: PortalSession | null = null;
  try {
    s = await runtime.portal.restore(stored.cookies);
    return await fn(s, { sessionRut: stored.rut, operatingRut });
  } finally {
    await s?.close();
  }
}
