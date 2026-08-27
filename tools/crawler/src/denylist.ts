// Denylist de superficies de ESCRITURA (ADR-040 §Decision 4). Derivado 1:1 de
// `docs/ESTADO-CONSOLIDADO.md` §4.3 — la lista canónica de superficies que este proyecto entero
// tiene prohibido tocar. Esto es el ÚNICO gate real de seguridad del crawler: Llama 3.1 solo
// aporta una señal adicional para revisión humana, nunca decide qué se sigue (ADR-004).
//
// Dos capas independientes, cualquiera de las dos basta para bloquear un link:
//   1. Patrón en la URL/href (ruta o query string).
//   2. Patrón en el TEXTO VISIBLE del link (`<a>...</a>`), en español, como el SII lo rotula.
// El crawler NUNCA hace click ni envía formularios (ADR-040 §Decision 2) — esto bloquea además
// que se NAVEGUE (GET) a la página de escritura misma, no solo que se interactúe con ella.

/** Un patrón denylisted, citado contra la fila de `ESTADO-CONSOLIDADO.md` §4.3 que lo motiva. */
export interface DenylistEntry {
  readonly nombre: string;
  readonly patronUrl: RegExp | null;
  readonly patronTexto: RegExp | null;
  /** Cita: fila de §4.3 de la que sale este patrón. */
  readonly fuente: string;
}

export const WRITE_DENYLIST: readonly DenylistEntry[] = [
  {
    nombre: 'Pagar giros',
    patronUrl: /pagogiro-ui/i,
    patronTexto: /\bpagar\b/i,
    fuente: 'ESTADO-CONSOLIDADO §4.3: "Pagar giros" — pagogiro-ui / botón "Pagar" de rfiInternet',
  },
  {
    nombre: 'Declarar y pagar F50',
    patronUrl: /rfiInternet\/declarar\//i,
    patronTexto: null,
    fuente: 'ESTADO-CONSOLIDADO §4.3: "Declarar y pagar F50"',
  },
  {
    nombre: 'Rectificar F50',
    patronUrl: /rfiInternet\/rectificarF50\//i,
    patronTexto: null,
    fuente: 'ESTADO-CONSOLIDADO §4.3: "Rectificar F50"',
  },
  {
    nombre: 'Declarar término de giro',
    patronUrl: /sistgiInternet\/?\?opc=dec\b/i,
    patronTexto: /declarar t[ée]rmino de giro/i,
    fuente: 'ESTADO-CONSOLIDADO §4.3: "Declarar término de giro" — ?opc=dec (⛔ solo ?opc=con lee)',
  },
  {
    nombre: 'Generar carpeta tributaria',
    patronUrl: /generarcteregular|generarctepersonalizada/i,
    patronTexto: /generar carpeta tributaria/i,
    fuente: 'ESTADO-CONSOLIDADO §4.3: "Generar carpeta tributaria"',
  },
  {
    nombre: 'Anular carpeta tributaria',
    patronUrl: null,
    patronTexto: /\banular\b/i,
    fuente: 'ESTADO-CONSOLIDADO §4.3: "Anular carpeta tributaria" — acción "Anular" en cteregular',
  },
  {
    nombre: 'Aceptar/reclamar un DTE',
    // Toda la app se evita navegar (no solo el botón) — es donde viven esas acciones (ADR-036).
    patronUrl: /registrorechazodtej6ui/i,
    patronTexto: /\b(aceptar|reclamar)\b/i,
    fuente: 'ESTADO-CONSOLIDADO §4.3: "Aceptar/reclamar un DTE" — acciones en registrorechazodtej6ui',
  },
  {
    nombre: 'Ingresar correo de notificaciones',
    patronUrl: /opc=114\b/i,
    patronTexto: /ingresar correo/i,
    fuente: 'ESTADO-CONSOLIDADO §4.3: "Ingresar correo de notificaciones" — CViewCarta.cgi opc=114',
  },
  {
    nombre: 'Declarar Renta F22',
    patronUrl: /navegacionf22/i,
    patronTexto: null,
    fuente: 'ESTADO-CONSOLIDADO §4.3: "Declarar Renta F22"',
  },
  {
    nombre: 'Corregir/rectificar renta',
    patronUrl: /ren_mp\/REN_MenusRenta\.cgi/i,
    patronTexto: /\brectificar\b/i,
    fuente: 'ESTADO-CONSOLIDADO §4.3: "Corregir/rectificar renta"',
  },
  {
    nombre: 'Cerrar sesión (logout)',
    // No es una superficie de §4.3 (no tiene consecuencia tributaria), pero SÍ termina la
    // sesión que el crawler necesita para seguir — seguir este link se auto-saldría del SII a
    // mitad de una corrida. Bloqueado por seguridad OPERACIONAL del propio crawler, no fiscal.
    patronUrl: /cgi_AUT2000\/autTermino\.cgi/i,
    patronTexto: /cerrar sesi[óo]n/i,
    fuente: 'config.ts HOSTS.logoutPath — termina la sesión SII; el crawler nunca debe dispararlo',
  },
] as const;

export interface DenylistMatch {
  readonly entry: DenylistEntry;
  readonly via: 'url' | 'texto';
}

/** `null` si el link es seguro de seguir; si no, la primera entrada del denylist que lo bloqueó. */
export function matchDenylist(url: string, textoVisible: string): DenylistMatch | null {
  for (const entry of WRITE_DENYLIST) {
    if (entry.patronUrl?.test(url)) return { entry, via: 'url' };
    if (entry.patronTexto?.test(textoVisible)) return { entry, via: 'texto' };
  }
  return null;
}
