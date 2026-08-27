// SII production hostnames — the single source of truth (ADR-004). Never
// hard-code a SII host anywhere else. Ported from first-hand observation in the
// Python sii-cli; prod-only, no env switch (sii-py ADR-016).

export const HOSTS = {
  /** Clave Tributaria login host. Landing here ⇒ NOT authenticated (URL-based detection). */
  login: 'https://zeusr.sii.cl',
  /** Login page path; takes the post-login destination as an UNKEYED query string (observed). */
  loginPath: '/AUT2000/InicioAutenticacion/IngresoRutClave.html',
  /** Server-side logout endpoint path; the close redirects OFF this path (sii-py, observed). */
  logoutPath: '/cgi_AUT2000/autTermino.cgi',
  /** Mi SII landing — serves the inline `DatosCntrNow` object with the contribuyente snapshot. */
  miSii: 'https://misiir.sii.cl/cgi_misii/siihome.cgi',
  portal: 'https://www.sii.cl',
  /** SPA JSON facades (RCV / F29 / F22) live under this host. */
  portalApi: 'https://www4.sii.cl',
  /** Legacy BHE/BTE consulta CGIs (boletas de honorarios). HTML skeleton filled
   *  client-side from inline JS maps; read via `PortalSession.goto`/`evaluate`, NOT
   *  the SDI-JSON facade. The `.sii.cl` session cookie SSO-carries here (observed
   *  2026-06-30). Session-keyed (`rut_arrastre` = the principal). (#20 / ADR-004) */
  bheCgi: 'https://loa.sii.cl/cgi_IMT',
  /** BPST — Boleta de Prestación de Servicios de Terceros Electrónica (ADR-029). A THIRD legacy
   *  CGI family, distinct from `bheCgi` above despite SII's own UI calling this product "BTE"
   *  (naming collision with this repo's unrelated `bte.ts` — see the ADR). Plain HTML table,
   *  reached via `PortalSession.requestForm` (form-POST → HTML), NOT `goto`/`evaluate` on inline
   *  JS maps. Session-keyed. (#BPST / ADR-029, observed 2026-07-29) */
  bpstCgi: 'https://zeus.sii.cl/cvc_cgi/bte',
  /** Estado de Declaraciones Juradas (ADR-030). A SIXTH wire shape: plain REST JSON, the
   *  subject RUT embedded in the URL path (`.../djconsulta/<rut>/recurso/v1/dj/...`), reached via
   *  `PortalSession.requestJson` — but NOT the SDI envelope family (no `respEstado`/
   *  `facadeAdapterService`). (#DJ / ADR-030, observed 2026-08-03) */
  djConsulta: 'https://www2.sii.cl/app/djconsulta',
  /** Notificaciones / Correspondencia — Mi SII's OWN `CViewCarta.cgi` (ADR-032). Same host as
   *  `miSii` (`misiir.sii.cl`); a form-POST (`opc=<n>`) answering JSON with an envelope
   *  `{estado, glosa, data, metaData}` distinct from every other envelope in this codebase.
   *  No bootstrap `goto` needed (unlike DJ) — a cold POST works directly (observed 2026-08-03). */
  notificacionesCgi: 'https://misiir.sii.cl/cgi_misii/CViewCarta.cgi',
  /** SISPAD — peticiones administrativas. A GWT-RPC app: `text/x-gwt-rpc` POST to
   *  `/sispadinternet/peticion` returns a `//OK[…]` object graph; reached via
   *  `PortalSession.requestText` (a cold authenticated POST), NOT the SDI-JSON facade.
   *  The `.sii.cl` session cookie SSO-carries here (observed 2026-07-03). Body-RUT.
   *  (#74 / ADR-020) */
  sispad: 'https://www3.sii.cl/sispadinternet',
  /** `rfiInternet` — "Consulta y pago de giros" (ADR-034). Una app GWT (protocolo 7, distinto
   *  del 5 de `sispad`). Este proyecto la lee por el DOM RENDERIZADO (`goto`/`evaluate`), NO por
   *  GWT-RPC: ver ADR-034 para el razonamiento de modo de falla. ⛔ La misma app expone pago
   *  ("Pagar", `www2.sii.cl/pagogiro-ui/`) — SOLO se alcanza `?opcionPagina=ConsultaGiros`.
   *  (observado 2026-08-03) */
  rfiInternet: 'https://www4.sii.cl/rfiInternet',
  /** Carpeta Tributaria Regular — historial of issued credit-application dossiers (ADR-033).
   *  Same `www2.sii.cl` REST-JSON-with-RUT-in-path family as `djConsulta` — requires the SAME
   *  bootstrap (`goto` the UI page + paced wait) before any GET or the API answers a bare HTTP
   *  401. Response is a BARE JSON ARRAY (no `{estado,...}`/`{data,...}` wrapper), simpler than
   *  every other endpoint in this family. RUT is a URL path segment, inserted per-call. Base
   *  excludes it. (#carpeta / ADR-033, observed 2026-08-03) */
  carpetaTributariaApi: 'https://www2.sii.cl/app/cte-api-carpetatributaria',
  /** The Carpeta Tributaria Regular UI page — the bootstrap `goto` target `fetchCarpetaTributariaHistorial`
   *  navigates before its GET (same precondition shape as `djConsulta`). */
  carpetaTributariaUi: 'https://www2.sii.cl/carpetatributaria/cteregular',
  /** Palena: DTE SOAP web services AND the public, login-free consulta CGIs
   *  (e.g. `/cvc_cgi/dte/ee_empresa_rut` — empresas autorizadas a emitir DTE, ADR-014). */
  dteWs: 'https://palena.sii.cl',
  /** PDF de cartas/notificaciones SII, por `codCarta` (ya expuesto por `f22 historial` desde
   *  2026-06-29). GET autenticado vía `PortalSession.requestBinary` (ADR-042); el body NUNCA se
   *  decodifica a texto. (observado, ADR-042) */
  cartaPdf: 'https://www3.sii.cl/Coreca1Internet/MuestraPdf',
  claveUnica: 'https://accounts.claveunica.gob.cl/openid/authorize/',
} as const;

/** URL hostname that indicates an unauthenticated session (sii-py ADR-009). */
export const LOGIN_HOST = 'zeusr.sii.cl';

/** Full login page URL (host + path). */
export const LOGIN_URL = `${HOSTS.login}${HOSTS.loginPath}`;

/** Full server-side logout URL (host + path). The close redirects OFF this path. */
export const LOGOUT_URL = `${HOSTS.login}${HOSTS.logoutPath}`;

export interface Settings {
  /** Max requests/second used to pace portal POSTs (sii-py ADR-011). */
  readonly rateLimitRps: number;
  /** Cookies-only session TTL, minutes — ENFORCED by `withSession` as a local staleness gate.
   *  SII remains the authority (the first real request is still the liveness test); this only
   *  avoids spending a round-trip that cannot succeed, and bounds how long a stolen jar is
   *  useful. Set from first-hand observation: a jar minted 2026-07-25 14:32 was still live at
   *  ~11:25 the next morning but rejected by ~00:51 — i.e. real expiry sits above 10 h. 12 h is
   *  the smallest round number safely past that, so a working session is never cut short. */
  readonly sessionTtlMinutes: number;
}

export const DEFAULT_SETTINGS: Settings = {
  rateLimitRps: 1,
  sessionTtlMinutes: 12 * 60,
};

/** The post-login destinations we ever send. A CLOSED union rather than `string` (code review
 *  F-08): the login URL takes an UNKEYED query (`?<destination>`, the observed format), so the
 *  value cannot be percent-encoded without breaking it — which means the only safe guard is to
 *  forbid caller-supplied values at the type level. Nothing reachable today passes user input;
 *  this keeps it that way. */
export type LoginDestination = typeof HOSTS.miSii;

/** Build the login URL: `<LOGIN_URL>?<destination>` — unkeyed query, observed format. */
export function loginUrl(destination: LoginDestination): string {
  return `${LOGIN_URL}?${destination}`;
}
