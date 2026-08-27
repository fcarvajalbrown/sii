// Domain error hierarchy. The CLI maps these to exit codes (in @dostertags/sii-cli):
// NotAuthenticated → 2, LoginFailed → 3, RateLimit → 4. Pass SII's Spanish
// messages through unchanged (sii-py error-surfacing convention).

export class SiiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** No valid cached session; the user must run `sii auth login`. */
export class NotAuthenticatedError extends SiiError {}

/** A cached session existed but the cookies are dead. Carries an actionable
 *  recovery message (e.g. re-run the browser login). Subclass of NotAuthenticated
 *  so a generic catch still treats it as "not authenticated". */
export class SessionExpiredError extends NotAuthenticatedError {}

/** Browser login was not completed (timeout / window closed). No partial
 *  session is ever written. */
export class LoginFailedError extends SiiError {}

/** SII server-side rate limit / block. NEVER retry — surface verbatim and stop. */
export class RateLimitError extends SiiError {}

/** A stored credential was required (e.g. unattended re-mint) but none resolved. */
export class CredentialNotFoundError extends SiiError {}

/** Invalid user input: bad RUT, an operate target not in the operable set, etc. */
export class ValidationError extends SiiError {}

/** SII rejected a portal/SDI facade request (error envelope or unparseable
 *  response). Carries SII's message verbatim — never translated (ADR-004). */
export class RepresentacionError extends SiiError {}

/** SII rejected an RCV (Registro de Compras y Ventas) facade request, or the
 *  response was not parseable. SII's message verbatim — never translated (ADR-004). */
export class RcvError extends SiiError {}

/** SII rejected an F22 (Declaración Anual de Renta) facade request, or the response
 *  was not parseable. SII's message verbatim — never translated (ADR-004). */
export class F22Error extends SiiError {}

/** SII rejected an F29 (Declaración Mensual de IVA) facade request, the response was
 *  not parseable, OR the operation is invalid for F29's session-keyed contract — F29
 *  authorizes by the session principal, so operating as a represented empresa is
 *  rejected up front (ADR-005). SII's message verbatim — never translated (ADR-004). */
export class F29Error extends SiiError {}

/** SII rejected a BTE/BHE (boletas de honorarios) consulta, or the inline report map was
 *  absent / unparseable (a non-report or cross-RUT page). SII's message verbatim where one
 *  exists — never translated (ADR-004). NOT raised for an empty month (a clean 0-boletas
 *  result). */
export class BteError extends SiiError {}

/** SII rejected a SISPAD peticiones (peticiones administrativas) GWT-RPC read, the
 *  response was a `//EX[…]` business error (surfaced verbatim — ADR-004), or the GWT
 *  object graph could not be decoded against the observed schema ("scraper roto", a loud
 *  fail — the app was recompiled with changed types). Peticiones is BODY-RUT (validate
 *  `--rut` vs the operable set, like RCV — ADR-005 / ADR-020). Never retried after a SII
 *  error; a `LOGIN_HOST` bounce surfaces as `SessionExpiredError`, not this. */
export class PeticionesError extends SiiError {}

/** SII rejected a BPST (Boleta de Prestación de Servicios de Terceros Electrónica) consulta,
 *  or the HTML report page was absent / unparseable (a non-report or cross-RUT page). SII's
 *  message verbatim where one exists — never translated (ADR-004). NOT raised for an empty
 *  month (a clean 0-boletas result). Distinct from `BteError` (standard Boletas de Honorarios
 *  Electrónicas, `loa.sii.cl`) — BPST is a different SII product on `zeus.sii.cl` that happens
 *  to share the "BTE" name in SII's own UI (ADR-029 naming-collision note). */
export class BpstError extends SiiError {}

/** SII rejected a DJ (Declaraciones Juradas) estado consulta, the response envelope was
 *  unrecognized, or a `periodo` inside the requested window returned SII's "out of range" error
 *  for a reason OTHER than running off the front of the taxpayer's history (ADR-030). SII's
 *  message verbatim — never translated (ADR-004). NOT raised when the sweep intentionally stops
 *  at the oldest periodo with real data (a soft stop, not a failure). */
export class DjError extends SiiError {}

/** SII rejected a Notificaciones/Correspondencia consulta (Mi SII's `CViewCarta.cgi`), or the
 *  response envelope was unrecognized. SII's message verbatim — never translated (ADR-004).
 *  NOT raised for the documented empty state (`estado: 1403`, "No existen registros") — that is
 *  a legitimate absence, same posture as every other facade in this codebase (ADR-032). */
export class NotificacionesError extends SiiError {}

/** SII rejected a Carpeta Tributaria Regular (historial) consulta, the response wasn't the
 *  expected bare JSON array, or the `www2.sii.cl` bootstrap (goto + pace) precondition wasn't
 *  met. No business-error envelope has been observed live for this endpoint (ADR-033) — this
 *  error is raised only for a genuinely unrecognized/non-JSON response, never for an empty
 *  history (a legitimate `[]` result, no carpetas ever issued). */
export class CarpetaTributariaError extends SiiError {}

/** SII rejected a giros consulta, or the rendered results table was absent / had unexpected
 *  column headers ("scraper roto" — a LOUD fail, ADR-034: this facade reads the rendered DOM, so
 *  a changed table must never be silently mis-mapped onto the curated fields). NOT raised for a
 *  año with no giros — that is a legitimate empty result. */
export class GirosError extends SiiError {}

/** SII rechazó una consulta de situación tributaria (Mi SII `CViewCarta.cgi`, ADR-035) o la
 *  respuesta no fue el JSON esperado. Cada `opc` de ese CGI tiene su PROPIO envelope, así que
 *  este error cubre las tres consultas que compone `situacion` (118 / 22 / 112). NO se lanza
 *  para una lista vacía — ausencia es un resultado legítimo. */
export class SituacionError extends SiiError {}

/** SII rechazó una consulta de informe bancario (Mi SII `CViewCarta.cgi`, `opc=119`, ADR-039) o
 *  la respuesta no tuvo la forma esperada (`{listCarpetaTributaria: [...]}`, un nombre de clave
 *  engañoso que NO tiene relación con la Carpeta Tributaria Regular — ADR-033 es un producto
 *  distinto). NO se lanza para una lista vacía — ausencia de informe es un resultado legítimo. */
export class BancarioError extends SiiError {}

/** The public DTE-authorized consulta could not be completed for a non-user reason —
 *  the network/CGI failed, a non-200 came back, or the portal HTML changed shape
 *  ("scraper roto"). A RUT that is simply not a DTE emisor is NOT this error: it is a
 *  clean negative result (`autorizado: false` + SII's verbatim message). Fail loud,
 *  never retry (ADR-004 / ADR-014). */
export class DteError extends SiiError {}

/** SII rejected a binary document download (a PDF de carta, ADR-042), the response was not a
 *  recognizable PDF (unexpected `content-type` or a non-200 status), or the `www3.sii.cl` GET
 *  failed for a non-user reason. Never retried after a SII error (ADR-004). */
export class DocumentoError extends SiiError {}
