// Prefijos de URL ya catalogados en `docs/ESTADO-CONSOLIDADO.md` §4.1 (en uso) y §4.2
// (identificadas, sin usar) — usados por `report.ts` para distinguir un candidato REALMENTE
// nuevo de algo que el proyecto ya conoce. Mantener sincronizado a mano cuando ese documento
// cambie (no hay una fuente única en código para esto — es deliberadamente un archivo de datos
// simple, no una fachada).
export const KNOWN_URL_PREFIXES: readonly string[] = [
  // §4.1 — en uso por el código en producción
  'https://zeusr.sii.cl/AUT2000/InicioAutenticacion/IngresoRutClave.html',
  'https://zeusr.sii.cl/cgi_AUT2000/autTermino.cgi',
  'https://misiir.sii.cl/cgi_misii/siihome.cgi',
  'https://www4.sii.cl/propuestaf29ui/',
  'https://loa.sii.cl/cgi_IMT',
  'https://zeus.sii.cl/cvc_cgi/bte',
  'https://www2.sii.cl/app/djconsulta',
  'https://misiir.sii.cl/cgi_misii/CViewCarta.cgi',
  'https://www2.sii.cl/app/cte-api-carpetatributaria',
  'https://www2.sii.cl/carpetatributaria/cteregular',
  'https://www4.sii.cl/rfiInternet/?opcionPagina=ConsultaGiros',
  'https://www3.sii.cl/sispadinternet',
  'https://palena.sii.cl',
  // §4.2 — identificadas y NO utilizadas todavía (candidatos ya conocidos, no "nuevos")
  'https://www4.sii.cl/rfiInternet/consulta/index.html',
  'https://www4.sii.cl/sifmConsultaInternet/',
  'https://www4.sii.cl/rfiInternet/consultaTerceros/',
  'https://www4.sii.cl/registrorechazodtej6ui',
  'https://www4.sii.cl/consemitidosinternetui/',
  'https://www2.sii.cl/carpetatributaria/cterevisar',
  'https://www4.sii.cl/cteInternet/',
  'https://zeus.sii.cl/cvc/vdc/index.html',
  'https://www4.sii.cl/sistgiInternet/?opc=con',
  'https://www4.sii.cl/copiaCertificadosBlobstoreInternet/',
  'https://www3.sii.cl/Coreca1Internet/MuestraPdf',
  'https://www4.sii.cl/validanotifInternet/',
  'https://www4.sii.cl/bolcoreinternetui/',
  'https://www2.sii.cl/bolcore/',
  'https://www.sii.cl/servicios_online/1039-1186.html',
  'https://www.sii.cl/factura_electronica/Webservice_Registro_Reclamo_DTE_V1.2.pdf',
  'https://www4.sii.cl/seeui/see/internet',
];

export function esUrlConocida(url: string): boolean {
  return KNOWN_URL_PREFIXES.some((p) => url.startsWith(p));
}
