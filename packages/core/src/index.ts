// Public API of @dostertags/sii-core. Surfaces (CLI, MCP) import ONLY from here — the task
// layer plus the seam interfaces + the runtime factory (ADR-003). Reaching into
// a sub-module (auth/portal/identity internals) from a surface is forbidden.

// --- tasks: the public operations ---
// NOTE: `consoleLogin` (takes a Clave) is intentionally NOT here — it lives in the
// CLI-only subpath `@dostertags/sii-core/cli`, so the MCP server (which imports this barrel)
// cannot wire a password-taking task (ADR-006).
export { login, logout, authStatus, statusRefresh, whoami } from './tasks/auth.js';
export type {
  AuthIdentity,
  AuthLoginResult,
  AuthLogoutResult,
  AuthStatusLocal,
  AuthWhoami,
} from './tasks/auth.js';
export { operate, operateSelf, operatingStatus, listOperable } from './tasks/operate.js';
export type { OperateResult, OperableList } from './tasks/operate.js';
export { describeOperating, formatOperableEntry } from './identity/index.js';
export type { OperatingContext, OperableEntry } from './identity/index.js';
export { rcvSummary, rcvList, rcvListAll } from './tasks/rcv.js';
export type {
  RcvResumen,
  RcvResumenRow,
  RcvDetalle,
  RcvDetalleDoc,
  RcvDetalleAll,
  RcvDetalleAllDoc,
  RcvSide,
} from './tasks/rcv.js';
export { f22Status, f22Overview, f22Observaciones, f22Historial } from './tasks/f22.js';
export type {
  F22Estado,
  F22Declaraciones,
  F22Overview,
  F22Observaciones,
  F22Historial,
  F22Grupos,
  DeclaracionF22,
  CodigoF22,
  EventoF22,
  ObservacionF22,
} from './tasks/f22.js';
export { f29Formulario, f29Overview, f29Status, F29_GRUPO_LABELS } from './tasks/f29.js';
export type {
  F29Formulario,
  F29Overview,
  F29OverviewArgs,
  MesF29,
  LineaF29,
  F29Grupo,
  F29Estado,
  F29Propuesta,
  CodigoF29,
  DeclaracionEstadoF29,
} from './tasks/f29.js';
export { dteAuthorized } from './tasks/dte.js';
export type { DteAutorizados, DteAutorizado } from './tasks/dte.js';
// Acuse de recibo / reclamo de DTE recibidos (ADR-036). Composición sobre RCV — el estado de
// acuse ya viaja en el propio RCV. SOLO LECTURA: nunca acepta ni reclama (efecto jurídico).
export { dteAcuse } from './tasks/acuse.js';
export type { DteAcuseResult, AcuseDoc, AcuseGrupo, DteAcuseArgs } from './tasks/acuse.js';
export { bteList, bteEmitPreview, bteEmit } from './tasks/bte.js';
// ADR-026: the preview mints the server-side confirmation that authorises issuing that boleta.
export type { BtePreviewConfirmable } from './tasks/bte.js';
export { resetEmitConfirmations } from './tasks/bte-confirm.js';
export type {
  BteMensual,
  BteBoleta,
  BteTotales,
  BteSide,
  BteEmitArgs,
  BteEmitResult,
  BteEmitida,
  BtePreview,
  BteRetiene,
  BteLineaEmision,
} from './tasks/bte.js';
export { peticionesList } from './tasks/peticiones.js';
export type { PeticionesResult, Peticion, EstadoPeticion } from './tasks/peticiones.js';
// Composite reads (ADR-022): joins over existing facades, one session each.
export { ivaMensual } from './tasks/iva.js';
export type { IvaMensual, IvaLado, IvaTipoDoc, IvaF29, IvaReconciliacion } from './tasks/iva.js';
export { rentaAnual } from './tasks/renta.js';
export type { RentaAnual, RentaF22, RentaIva, RentaMes } from './tasks/renta.js';
// Local read-through cache (ADR-027): inspect/purge. `cachedRead` itself stays internal — tasks
// opt in, surfaces do not reach for it (ADR-003).
export { clearCache, readCacheStats } from './tasks/cache.js';
export type { CacheStats } from './tasks/cache.js';
export { monitorSweep, readMonitorSnapshot } from './tasks/monitor.js';
export type {
  MonitorResult,
  MonitorCambio,
  MonitorResumen,
  MonitorSnapshot,
  MonitorSeveridad,
  MonitorTipo,
} from './tasks/monitor.js';
export { honorariosAnual } from './tasks/honorarios.js';
export type {
  HonorariosAnual,
  HonorariosMes,
  HonorariosTotales,
  HonorariosF22,
  HonorariosF22Codigo,
  HonorariosReconciliacion,
} from './tasks/honorarios.js';
// BPST — Boleta de Prestación de Servicios de Terceros Electrónica (ADR-029). Distinct from
// `bteList` above (SII's OWN "BTE" acronym collides with this repo's unrelated existing module —
// see the ADR's naming-collision note); named `bpst` throughout to avoid deepening it.
export { bpstList } from './tasks/bpst.js';
export type { BpstMensual, BpstBoleta, BpstTotales, BpstSide } from './tasks/bpst.js';
// DJ — Estado de Declaraciones Juradas (ADR-030). Session-keyed self-only for now (RUT-in-path
// reach for a represented empresa is unconfirmed — see the ADR).
export { djStatus, djHistorial, djDetalle } from './tasks/dj.js';
export type {
  DjStatusResult,
  DjEstadoRow,
  DjHistorialAnual,
  DjHistorialItem,
  DjHistorialRow,
  DjDetalle,
  DjSeccion,
  DjTablaNombrada,
  DjFila,
  DjCelda,
} from './tasks/dj.js';
// Notificaciones / Correspondencia — Mi SII's own CViewCarta.cgi (ADR-032). Session-keyed
// self-only for now (no represented-empresa reach observed — see the ADR).
export { notificacionesList, notificacionesDetalle } from './tasks/notificaciones.js';
export type {
  NotificacionCategoria,
  NotificacionesLista,
  NotificacionItem,
  NotificacionDetalle,
  NotificacionAdjunto,
} from './tasks/notificaciones.js';
// Carpeta Tributaria Regular — historial of issued credit-application dossiers (ADR-033).
// READ ONLY (never generates or annuls one). Session-keyed self-only for now.
export { carpetaTributariaHistorial } from './tasks/carpeta.js';
export type {
  CarpetaTributariaHistorial,
  CarpetaTributariaItem,
  CarpetaTributariaParametros,
} from './tasks/carpeta.js';
// Giros — deuda fiscal formal emitida al contribuyente (ADR-034). SOLO LECTURA: nunca alcanza
// el flujo de pago de la misma app SII. Session-keyed.
export { girosList } from './tasks/giros.js';
export type { Giro, GiroConAnio, GirosResult } from './tasks/giros.js';
// Situación tributaria — cumplimiento Ley COT, régimen vigente y perfil del contribuyente
// (ADR-035). Session-keyed. NO expone socios/representantes/direcciones (PII de terceros).
export { situacionTributaria } from './tasks/situacion.js';
export type {
  SituacionResult,
  CumplimientoCot,
  RequisitoCot,
  RegimenTributario,
  PerfilContribuyente,
  ActividadEconomica,
  Timbraje,
  ConteosPerfil,
} from './tasks/situacion.js';
// Informe bancario — abonos por semestre, banco y tipo de cuenta (ADR-039). Session-keyed. El
// insumo del cruce de fiscalización que compara depósitos bancarios contra ventas declaradas.
export { bancarioInforme } from './tasks/bancario.js';
export type { BancarioInformeResult, InformeBancarioSemestre } from './tasks/bancario.js';
// Perfil del titular — domicilio propio siempre, socios/representantes con opt-in explícito
// (ADR-041). Session-keyed.
export { profile } from './tasks/profile.js';
export type { ProfileResult, Socio, Representante, Direccion } from './tasks/profile.js';
// PDF de cartas/notificaciones, por codCarta (ADR-042). Session-keyed. El body NUNCA se
// text-decodea — llega como Buffer crudo (la primera fachada que usa requestBinary).
export { descargarCartaPdf } from './tasks/documentos.js';
export type { CartaPdf } from './tasks/documentos.js';

// --- seams: the injectable contract a consumer composes a Runtime from ---
// The Node default adapters + `createNodeRuntime` live in the `./node` subpath
// (ADR-016), so this barrel's static graph stays free of node:* and playwright.
export type {
  AuditEntry,
  AuditSink,
  Clock,
  CredentialLoginOptions,
  InteractiveLoginOptions,
  KeyValueStore,
  PortalDriver,
  PortalSession,
  Runtime,
  SecretStore,
} from './seams/index.js';

// --- shared primitives ---
export { Rut } from './rut/index.js';
export { formatMoney, formatRut } from './format/index.js';
export { Periodo, Anio } from './periodo/index.js';
export { HOSTS, LOGIN_HOST } from './config/index.js';
export * from './errors/index.js';

// --- testing helpers: in-memory fakes for surface / integration tests ---
export * as testing from './adapters/fake/index.js';
