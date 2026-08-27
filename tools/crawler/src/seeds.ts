// Semillas del crawler (ADR-040 §Decision 7): Mi SII + las URLs ya en producción del proyecto
// (`HOSTS`, `@dostertags/sii-core`) — varias superficies conocidas viven en subdominios que
// Mi SII no enlaza directamente, así que partir SOLO de Mi SII dejaría ramas enteras sin
// alcanzar. Deliberadamente EXCLUIDAS: `HOSTS.login` (página de login, no autenticada — no aporta
// nada nuevo) y el logout (termina la sesión; además ya está en el denylist por si algún link
// interno apunta ahí).
import { HOSTS } from '@dostertags/sii-core';

export const SEEDS: readonly string[] = [
  HOSTS.miSii,
  HOSTS.portal,
  HOSTS.portalApi,
  HOSTS.bheCgi,
  HOSTS.bpstCgi,
  HOSTS.djConsulta,
  HOSTS.notificacionesCgi,
  HOSTS.sispad,
  HOSTS.rfiInternet,
  HOSTS.carpetaTributariaUi,
  HOSTS.dteWs,
];
