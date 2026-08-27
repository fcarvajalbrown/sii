# Estado consolidado del proyecto sii — pendientes, cerrados y mejoras

**Fecha:** 2026-08-04. **Reemplaza como punto de entrada** a `NEXT-SPIKES-PLAN.md` (cerrado) y
complementa a `COVERAGE-GAP-ANALYSIS.md` (el análisis de brechas) y `BACKLOG.md` (detalle de
ingeniería). Este documento es el índice único de "qué falta, qué está hecho, qué hay que afinar",
**con la URL de cada recurso** para poder trabajar directamente sobre él.

> **Regla que gobierna las URLs (ADR-004):** cada una está marcada **OBSERVADA** (vista en vivo,
> con fecha) o **HIPÓTESIS** (aún no observada). Ningún spike puede escribir código contra una
> HIPÓTESIS sin confirmarla primero. ⛔ marca superficies de ESCRITURA que no deben tocarse sin su
> propio ADR.

---

## 1. Spikes faltantes y notas sin resolver

### 1.1 Spikes con trabajo previo — el camino ya está desbrozado

| # | Spike | Estado | URL | Qué falta exactamente |
|---|---|---|---|---|
| **G2** | **F29 presentado** (Fase 2) | 🔓 Transporte RESUELTO, decodificación GWT descartada (mismo riesgo que ADR-034) | `https://www4.sii.cl/rfiInternet/` **OBSERVADA** | Sin cambios este spike — sigue igual que giros: protocolo 7, sin esquema derivado. |
| **G2b** | **Consulta Integral F29** | 🔍 **Investigada 2026-08-05** (ver `docs/audits/2026-08-05-dia3-g2-g2b-f29-presentado.md`) | `https://www4.sii.cl/sifmConsultaInternet/index.html?dest=cifxx&form=29` **OBSERVADA** | Es la MISMA clase de riesgo que G2 (GWT protocolo 7, `getInfoIntegral` con tokens ofuscados sin esquema). **Pero su UI renderiza limpio**: la tabla de búsqueda es redundante con Fase 1, mas el botón "Ver" revela un **Historial de Eventos** con el **Cruce IVA Mensual** (señal de auditoría que NINGÚN módulo actual expone). Candidato concreto: un facade multi-paso que lea ese DOM (patrón ADR-034), su propia ADR. ⛔ Nueva superficie de escritura hallada: "Rectificar Declaración" en esa misma vista (§4.3). |
| **D** | **F50** | 🚫 Bloqueado por falta de datos | `https://www4.sii.cl/rfiInternet/consulta/index.html` **OBSERVADA** | Ver `audits/2026-08-04-spikeD-f50-bloqueado.md`. El contribuyente actual (ferretería) no presenta F50. Camino barato ya identificado: `getDeclaracionConEstados` con `formId` **1 o 3** (sin determinar cuál). Necesita un contribuyente CON F50. |
| **E** | ✅ **CERRADA (2026-08-05)** — DJ 1879 / 1887 validadas en vivo | `https://www2.sii.cl/app/djconsulta/<rut>/recurso/v1/dj/detalle` **OBSERVADA** | `dj detalle` funciona sin cambios contra ambas DJ, cada una con su propio layout de columnas (confirma que no hay que asumir el de la 1926). **Bonus confirmado**: `--pagina 2` y `--seccion 2` SÍ devuelven contenido distinto (pregunta abierta del contrato, ahora resuelta). Para este contribuyente, ninguna celda expone un RUT real (`contactoRut` correctamente `false` en 230+380 celdas) — es un reporte agregado por mes/tasa, no una lista literal por trabajador. Ver `docs/audits/2026-08-05-dia4-dj-1879-1887.md`. |

### 1.2 Spikes sin iniciar

| # | Spike | Prioridad | URL | Nota |
|---|---|---|---|---|
| **G** | Seam binaria + descarga de PDF | 🚧 **Arquitectura cerrada (ADR-042), verificación en vivo PENDIENTE** | `https://www3.sii.cl/Coreca1Internet/MuestraPdf?codCarta=<n>` **HIPÓTESIS no confirmada** (3 códigos reales probados 2026-08-06, los 3 fallaron HTTP 500) | `requestBinary` seam + `portal/documentos.ts` + `tasks/documentos.ts` + `sii carta pdf` construidos con TDD verde. La URL de `MuestraPdf` era una inferencia de un global JS (`jwscarta`) nunca confirmada con el enlace real — recapturar antes de confiar en el comando. Ver `docs/audits/2026-08-06-dia5-g-h.md`. |
| **H** | Carpeta tributaria RECIBIDA | 🔍 **Investigada 2026-08-06 — premisa corregida, NADA construido** | `https://www2.sii.cl/carpetatributaria/cterevisar` **OBSERVADA** | **NO es un historial** (a diferencia de ADR-033) — es un formulario que exige código+clave entregados fuera de banda por el emisor de la carpeta. Sin datos reales contra los que verificar, no se construyó código. Ver `docs/audits/2026-08-06-dia5-g-h.md` y `BACKLOG.md` §4. |
| **I** | Timbraje / CAF | 🟡 Media | `https://zeus.sii.cl/cvc/vdc/index.html` **OBSERVADA** | Verificar folios autorizados. Nota: `situacion` ya expone los **timbrajes por tipo de documento** (ADR-035), así que parte del valor ya está cubierto. |
| **J** | Infracciones y condonaciones | 🟢 Baja | `https://www.sii.cl/servicios_online/1045-3212.html` **OBSERVADA** (catálogo) | La app real se resuelve siguiendo ese link en vivo. |
| **K** | Término de giro (consulta) | 🟢 Baja | `https://www4.sii.cl/sistgiInternet/?opc=con` **OBSERVADA** | ⛔ **`?opc=dec` DECLARA término de giro — jamás tocar.** Usar solo `opc=con`. |
| **L** | Bienes raíces / contribuciones | 🟢 Baja | `https://www.sii.cl/servicios_online/1048-4544.html` **OBSERVADA** · `opc=16`/`opc=34` en `CViewCarta.cgi` | Solo relevante si el cliente tiene propiedades. |

### 1.3 Notas y preguntas abiertas (no son spikes, son incógnitas)

| Nota | Dónde vive | Qué falta |
|---|---|---|
| **`opc=9` devuelve HTTP 401** | `sii-contract/situacion.md` | "Inicio Actividades" en `CViewCarta.cgi` pide alguna precondición no observada. |
| **`opc=8` y `opc=11` devuelven VACÍO** | `sii-contract/situacion.md`, `audits/…spikeD…` | Rotulados "Situación Tributaria" y "Declaraciones F50" y no entregan nada. **Tres de doce etiquetas del `MISII_OPC_MAP` mienten** (`8`, `11`, `29`). |
| **Estado COT en incumplimiento** | `sii-contract/situacion.md` | Solo se observó el caso "Cumple". El texto de incumplimiento nunca se ha visto. |
| **`opc=43` (detalle notificación formal)** | `sii-contract/notificaciones.md` | Sin datos reales: este contribuyente no tiene notificaciones formales. |
| **Estado "pendiente" de acuse de DTE** | ADR-036 | SII **no publica** un estado pendiente ni una bandeja. Si existe, aparecerá como un `eventoReceptor` no observado. |
| **Código de débito del F29** | `BACKLOG.md` §3.1 | Bloquea medio `iva`. **Se cierra con UNA lectura**: `f29 formulario` de cualquier período con ventas. |
| **F22 código 1412** | `BACKLOG.md` §3.2 | Nombrado por la observación B92, ausente de la taxonomía. `honorarios` lo expone sin adjudicar. |
| **Netting de Notas de Débito (tipo 56)** | `BACKLOG.md` §3.5 | El netting de NC (61) se validó contra el código 511; el lado débito nunca se aisló. |
| **Fiabilidad de carpeta tributaria** | ADR-033 | HTTP 401 tras ~10 llamadas en 20 min. Re-verificar espaciado. |
| **Alcance para empresa representada** | ADR-030..036 | Ninguna superficie reciente se probó con una empresa representada. |
| **Paginación de giros y notificaciones** | ADR-032, ADR-034 | No observada; se expone `masPaginas`/`aniosDescuadrados` en vez de truncar en silencio. |
| **Regeneración del esquema GWT** | `BACKLOG.md` §6 | `gwt-schema.ts` (109 clases) se regenera con `peticiones-schema-extract.py` cuando SISPAD se recompile. |

---

## 2. Elementos cerrados y su estado final

### 2.1 Superficies de lectura en producción

| Superficie | CLI | MCP | ADR | Estado final |
|---|---|---|---|---|
| Auth / identidad | `auth login\|logout\|status`, `operate`, `whoami` | `auth_*`, `operate`, `whoami` | 005, 006, 010 | ✅ Validado en vivo |
| RCV (libros) | `rcv summary\|list\|all` | `rcv_*` | 017, 028 | ✅ Lectura completa; falta `rcv match` |
| F22 (renta) | `f22 status\|formulario\|observaciones\|historial` | `f22_*` | — | ✅ El módulo más completo |
| F29 (IVA) | `f29 formulario\|overview\|status` | `f29_*` | 013 | 🚧 **Solo la propuesta**, no lo presentado |
| BHE/BTE | `bte list`, `bte emit` | `bte_*` | 017, 026 | ✅ lectura; 🚧 emisión (ISSUE sin validar) |
| BPST | `bpst list` | `bpst_list` | 029 | ✅ EMITIDAS validado; RECIBIDAS sin fila real |
| DTE autorizados | `dte authorized` | `dte_authorized` | 014 | ✅ Consulta pública |
| Peticiones | `peticiones list` | `peticiones_list` | 020 | ✅ Completo (GWT-RPC) |
| DJ | `dj status\|historial\|detalle` | `dj_*` | 030, 031 | ✅ Estado completo; contenido solo DJ 1926 |
| Notificaciones | `notificaciones list\|detalle` | `notificaciones_*` | 032 | ✅ Lista + detalle |
| Carpeta tributaria | `carpeta historial` | `carpeta_tributaria_historial` | 033 | 🚧 Re-verificación en vivo pendiente |
| **Giros / deuda** | `giros list` | `giros_list` | **034** | ✅ **Live-validado** (3 giros reales) |
| **Situación / Ley COT** | `situacion` | `situacion_tributaria` | **035** | ✅ **Live-validado** |
| **Acuse de DTE** | `dte acuse` | `dte_acuse` | **036** | ✅ Live-validado (G3 **parcial**) |
| IVA (compuesto) | `iva` | `iva` | 022 | 🚧 Crédito validado; **débito indeterminable** |
| Renta (compuesto) | `renta` | `renta` | 022 | 🚧 Sin validar en vivo |
| Honorarios (compuesto) | `honorarios` | `honorarios` | 023, 029 | ✅ 2023 y 2025 cuadran exacto |
| **Monitor** | `monitor` | `monitor` | 024, 037, **038** | ✅ 7 familias de señales; plazo F29 y anclaje reales (ADR-038) — **live-validado 2026-08-05** |
| **Informe bancario** | `bancario resumen` | `bancario_resumen` | **039** | ✅ **Live-validado 2026-08-05** — abonos por semestre, cierra E1 |
| **Perfil (profile)** | `profile [--incluir-terceros]` | `profile` | **041** | ✅ **Live-validado 2026-08-05** — domicilio propio siempre, socios/representantes con opt-in, cierra P8 |

### 2.2 Brechas del análisis, estado final

| Brecha | Estado |
|---|---|
| **G1** Deuda fiscal y giros | ✅ **CERRADA** (ADR-034) |
| **G5** Situación tributaria + Ley COT | ✅ **CERRADA** (ADR-035) |
| **G17** Monitor no vigila señales nuevas | ✅ **CERRADA** (ADR-037) — encontró 3 DJ observadas invisibles |
| **G3** Recepción/acuse de DTE | 🚧 **PARCIAL** (ADR-036) — falta el estado "pendiente", que SII no publica |
| **G4** F50 | 🚫 **BLOQUEADA** por falta de datos observables |
| G2, G6..G16 | 📋 Abiertas (ver §1) |

### 2.3 Los cinco candidatos originales de `NEXT-SPIKES-PLAN.md`

Todos cerrados: DJ status (030), DJ historial/detalle (031), Notificaciones (032), Carpeta
tributaria (033). Ese plan queda archivado.

### 2.4 Guardrails al cierre

`npx vitest run` → **670 tests / 104 archivos** (2026-08-06, ADR-042) · `pnpm build` limpio ·
`pnpm lint` limpio · **verificado en vivo hoy**: `f22 historial` (a real empresa account) y `sii carta
pdf` (3 intentos reales, los 3 HTTP 500 — resultado negativo documentado, no oculto). Sesiones
previas (2026-08-05): `monitor --dry-run` (P1/P2, `errores: []`) y `bancario resumen` (3 semestres
reales) — ver `docs/audits/2026-08-05-dia1-p1-p2.md`, `docs/audits/2026-08-05-e1-informe-bancario.md`
y `docs/audits/2026-08-06-dia5-g-h.md`.

---

## 3. Precisiones y mejoras necesarias

Ordenadas por relación valor/esfuerzo.

| # | Qué ajustar | Por qué | Dónde |
|---|---|---|---|
| **P1** | ✅ **CERRADA + live-validada (ADR-038, 2026-08-05)** — el mes anterior ya no se marca como incumplido antes de vencer su plazo | La corrida del 2026-08-04 marcó `F29 2026-07` en severidad **alta**, pero vence el 12 o el 20 de agosto. `estadoFindings` ahora usa `autorizadoDeclararDia20` (`opc=112`) para eximir el mes anterior (`info`) mientras su plazo real (día 12 o 20) sigue abierto; sin el dato, mantiene el comportamiento previo. **Confirmado en vivo**: `F29 2026-07` → `info`, "el plazo (día 20) todavía no vence". | `tasks/monitor.ts` → `estadoFindings`. Tests: `monitor.test.ts` "P1: plazo del mes anterior" (4 casos). |
| **P2** | ✅ **CERRADA + live-validada (ADR-038, 2026-08-05)** — `fechaInicioActividades` cableado en el anclaje de severidad | `monitor.ts` usaba una heurística ("anclar en la evidencia más antigua") porque el campo se creía inexistente. Ahora usa el dato real (`opc=112`, AT = añoComercialInicio+1); la heurística queda de respaldo si el perfil falla. **Confirmado en vivo**: `F22 AT2019` → `info`, cita `fechaInicioActividades=2019-06-19` real, no la heurística. | `tasks/monitor.ts` → `estadoFindings`. Tests: `monitor.test.ts` "P2: anclaje por fechaInicioActividades" (2 casos). |
| **P3** | 🔍 **Investigado en vivo (2026-08-05), sigue ABIERTO — más difícil de lo estimado** | Bloquea medio `iva`: el veredicto del débito sigue en `null`. Seis meses reales CON ventas confirmaron que 538 nunca aparece (no era un artefacto de "sin ventas"). Se encontró un candidato (código `502`, coincide exacto con IVA ventas SIN netear) pero **se decidió NO usarlo**: sin un componente que nete las Notas de Crédito emitidas, wirearlo produciría un descuadre espurio en cada mes real de este contribuyente (mismo bug de raw-vs-netted que ADR-022 corrigió del lado crédito). Pinneado por test. Ver `docs/audits/2026-08-05-p3-f29-debito.md`. | `tasks/iva.ts` → `COD_DEBITO_FALLBACK`. `BACKLOG` §3.1 |
| **P4** | **Re-verificar carpeta tributaria en vivo, espaciado** | Dio HTTP 401 consistente tras ~10 llamadas en 20 min. Su página carga scripts de Queue-It (sala de espera), único caso en el repo. | ADR-033 |
| **P5** | **Validar `renta` en vivo** | Construido y con tests, **nunca validado contra SII**. Es de las pocas superficies en ese estado. | `tasks/renta.ts` |
| **P6** | **BPST RECIBIDAS sin fila real** | Solo se observó la cabecera; ninguna fila de datos. El parser podría fallar con datos reales. | ADR-029 |
| **P7** | **Generalizar `portal/gwt.ts`** | Acoplado a peticiones en 3 puntos (esquema global, `PeticionesError` incrustado, constructor fijo). Bloquea cualquier segunda superficie GWT. **Refactor especulativo hasta que exista consumidor** — hacerlo cuando llegue G2. | `portal/gwt.ts` |
| **P8** | ✅ **CERRADA (ADR-041, 2026-08-05)** — Superficie `profile` con opt-in | Construida y live-validada: domicilio propio siempre; socios/representantes/RUT del arrendador solo con `--incluir-terceros`. Cierra `BACKLOG` §3.4. | ADR-041 |
| **P9** | **`rcv match`** — conciliación con libro externo | Desbloqueado desde `rcvListAll`. Necesita **una decisión del usuario**: formato del libro externo y criterio de match. | `BACKLOG` §4 |
| **P10** | **Medir cobertura de tests** | `vitest.config.ts` no define provider ni umbrales. 596 tests, cobertura desconocida. | `vitest.config.ts` |
| **P11** | **Windows en CI** | No está en la matriz; dos defectos Windows-only ya se colaron. | `.github/workflows/ci.yml` |
| **P12** | **Driver basado en `fetch`** | Tres de cinco primitivas son HTTP con cookies emitido *a través de* Playwright. Un driver `fetch` quitaría ~300 MB y casi toda la latencia. | `BACKLOG` §6 |

---

## 4. Levantamiento de recursos SII con URL

### 4.1 En uso por el código en producción (todas OBSERVADAS)

| Recurso | URL | Módulo |
|---|---|---|
| Login Clave Tributaria | `https://zeusr.sii.cl/AUT2000/InicioAutenticacion/IngresoRutClave.html` | `auth` |
| Logout | `https://zeusr.sii.cl/cgi_AUT2000/autTermino.cgi` | `auth` |
| Mi SII (home + `DatosCntrNow`) | `https://misiir.sii.cl/cgi_misii/siihome.cgi` | `auth`, `whoami` |
| SDI JSON (RCV/F22/F29) | `https://www4.sii.cl` | `rcv`, `f22`, `f29` |
| Propuesta F29 | `https://www4.sii.cl/propuestaf29ui/services/data/facadeAdapterService` | `f29` |
| BHE/BTE legacy | `https://loa.sii.cl/cgi_IMT` | `bte` |
| BPST | `https://zeus.sii.cl/cvc_cgi/bte` | `bpst` |
| DJ (REST, RUT en path) | `https://www2.sii.cl/app/djconsulta` | `dj` |
| Notificaciones / situación | `https://misiir.sii.cl/cgi_misii/CViewCarta.cgi` | `notificaciones`, `situacion` |
| Carpeta tributaria (API) | `https://www2.sii.cl/app/cte-api-carpetatributaria` | `carpeta` |
| Carpeta tributaria (UI bootstrap) | `https://www2.sii.cl/carpetatributaria/cteregular` | `carpeta` |
| Giros | `https://www4.sii.cl/rfiInternet/?opcionPagina=ConsultaGiros` | `giros` |
| SISPAD (GWT-RPC) | `https://www3.sii.cl/sispadinternet` | `peticiones` |
| Palena (DTE público) | `https://palena.sii.cl` | `dte` |
| Informe bancario (`opc=119`) | `https://misiir.sii.cl/cgi_misii/CViewCarta.cgi` | `bancario` |

### 4.2 Identificadas y NO utilizadas todavía

| Recurso | URL | Estado |
|---|---|---|
| F29/F50 estado de declaración | `https://www4.sii.cl/rfiInternet/consulta/index.html` | OBSERVADA — spike D |
| Consulta Integral F29 | `https://www4.sii.cl/sifmConsultaInternet/index.html?dest=cifxx&form=29` | OBSERVADA — sin contrato |
| Verificar declaración por terceros | `https://www4.sii.cl/rfiInternet/consultaTerceros/index.html` | OBSERVADA — sin explorar |
| Acuse/reclamo de DTE (consulta por folio) | `https://www4.sii.cl/registrorechazodtej6ui` | OBSERVADA — no es bandeja |
| Factibilidad de cesión de DTE | `https://www4.sii.cl/registrorechazodtej6ui/#/consultadtecedible` | OBSERVADA — sin explorar |
| Mis DTE emitidos | `https://www4.sii.cl/consemitidosinternetui/#/defaultInternet` | OBSERVADA — sin explorar |
| Carpeta tributaria recibida | `https://www2.sii.cl/carpetatributaria/cterevisar` | OBSERVADA — spike H |
| Carpeta por mandato a instituciones | `https://www4.sii.cl/cteInternet/` | OBSERVADA — sin explorar |
| Consultar timbraje | `https://zeus.sii.cl/cvc/vdc/index.html` | OBSERVADA — spike I |
| Término de giro (consulta) | `https://www4.sii.cl/sistgiInternet/?opc=con` | OBSERVADA — spike K |
| Certificados emitidos | `https://www4.sii.cl/copiaCertificadosBlobstoreInternet/#consulta` | OBSERVADA — sin explorar |
| PDF de cartas | `https://www3.sii.cl/Coreca1Internet/MuestraPdf?` | OBSERVADA — spike G |
| Validar firma de notificación | `https://www4.sii.cl/validanotifInternet/` | OBSERVADA — sin explorar |
| Boleta electrónica (validez) | `https://www4.sii.cl/bolcoreinternetui/#!/home` | OBSERVADA — sin explorar |
| Boleta electrónica (contenido) | `https://www2.sii.cl/bolcore/` | OBSERVADA — sin explorar |
| Consulta de contribuyentes | `https://www.sii.cl/servicios_online/1039-1186.html` | OBSERVADA (catálogo) |
| WebService acuse/reclamo DTE | `https://www.sii.cl/factura_electronica/Webservice_Registro_Reclamo_DTE_V1.2.pdf` | OBSERVADA — es la vía de ESCRITURA |
| Expediente electrónico (SEE) | `https://www4.sii.cl/seeui/see/internet` | OBSERVADA — path válido, payload sin capturar |

### 4.3 ⛔ Superficies de ESCRITURA — identificadas para NO tocarlas

| Acción | URL |
|---|---|
| Pagar giros | `https://www2.sii.cl/pagogiro-ui/` y el botón "Pagar" de `rfiInternet` |
| Declarar y pagar F50 | `https://www4.sii.cl/rfiInternet/declarar/index.html` |
| Rectificar F50 | `https://www4.sii.cl/rfiInternet/rectificarF50/index.html` |
| Declarar término de giro | `https://www4.sii.cl/sistgiInternet/?opc=dec` |
| Generar carpeta tributaria | `https://www2.sii.cl/carpetatributaria/generarcteregular` · `…/generarctepersonalizada` |
| Anular carpeta tributaria | acción "Anular" en `cteregular` |
| Aceptar/reclamar un DTE | acciones en `registrorechazodtej6ui` |
| Ingresar correo de notificaciones | `CViewCarta.cgi` **`opc=114`** |
| Declarar Renta F22 | `https://www2.sii.cl/navegacionf22/` |
| Corregir/rectificar renta | `https://alerce.sii.cl/dior_cgi/ren_mp/REN_MenusRenta.cgi?opcion=1` |
| Rectificar declaración F29 (Consulta Integral) | Botón "Rectificar Declaración" en `sifmConsultaInternet` → CONSULTA DE ESTADO — hallazgo 2026-08-05, spike G2b |

---

## 5. Revisión estratégica — qué más conviene mapear

Elementos que **no estaban en ningún listado** y que tienen valor de negocio real para un servicio
contable.

| # | Recurso | URL | Por qué importa |
|---|---|---|---|
| **E1** | ✅ **CERRADA (ADR-039, 2026-08-05)** — Informe bancario (`bancario resumen`) | `https://misiir.sii.cl/cgi_misii/CViewCarta.cgi` | Re-confirmado en vivo (la cita previa no tenía log propio) y construido de punta a punta: `portal/bancario.ts` + `tasks/bancario.ts` + CLI + MCP. Abonos y montos por semestre y banco, verificado contra los 3 semestres reales del contribuyente (1.433/1.485/1.543 abonos, $619,8M/$656,5M/$700,4M). Es el insumo del **cruce de fiscalización más agresivo del SII**. Ver `docs/audits/2026-08-05-e1-informe-bancario.md`. |
| **E2** | **Consulta de contribuyentes / verificación de actividad** | `https://www.sii.cl/servicios_online/1039-1186.html` · `https://www.sii.cl/servicios_online/1039-4671.html` | Due-diligence de proveedores. Combinado con `dte authorized` (ya construido) permitiría un "¿es confiable este proveedor?" antes de aceptar su factura. |
| **E3** | **Mis DTE emitidos** | `https://www4.sii.cl/consemitidosinternetui/#/defaultInternet` | El RCV da el libro; esta app da el **estado de envío** de cada DTE emitido. Un DTE rechazado por SII no llega al RCV y hoy es invisible. |
| **E4** | **Expediente electrónico (SEE)** | `https://www4.sii.cl/seeui/see/internet` | Repositorio documental que el SII mantiene del contribuyente. Path validado, payload nunca capturado. Relevante en una fiscalización. |
| **E5** | **Certificados emitidos** | `https://www4.sii.cl/copiaCertificadosBlobstoreInternet/#consulta` | Certificados que el contribuyente ha solicitado. Evidencia para trámites. |
| **E6** | **Factibilidad de cesión de DTE (factoring)** | `https://www4.sii.cl/registrorechazodtej6ui/#/consultadtecedible` | Si el cliente usa factoring, saber qué facturas son cedibles es dinero directo. Nadie lo mira automáticamente. |
| **E7** | **Boleta electrónica — contenido** | `https://www2.sii.cl/bolcore/` | Para negocios con boleta (retail), el detalle de boletas no está en el RCV con el mismo grano. |
| **E8** | **Devolución anticipada / remanente crédito IVA** | `https://www4.sii.cl/devolucion-anticipada/informacion-beneficios-iva` | Beneficio real en efectivo. Un cliente con remanente acumulado y sin solicitarlo está dejando plata parada. |
| **E9** | **Pago diferido** | `https://www4.sii.cl/pagodiferidoui/internet/` | Opción de flujo de caja ante deuda. Complementa `giros`. |
| **E10** | **Consulta pública de normas / circulares** | `https://www.sii.cl/normativa_legislacion/circulares/2026/indcir2026.htm` | Vigilar cambios normativos que invaliden un supuesto del código. Barato de scrapear, alto valor de mantenimiento. |
| **E11** | **Valores UF / UTM / dólar** | `https://www.sii.cl/valores_y_fechas/uf/uf2026.htm` · `…/utm/utm2026.htm` | Varias reglas dependen de UF/UTM (tramos de régimen, límites). Hoy no hay fuente de estos valores en el proyecto. |
| **E12** | **Previred** (⚠️ **fuera del SII**) | `https://www.previred.com` | Cotizaciones previsionales, AFP, salud, Caja de Compensación **no son del SII**. Si el servicio promete cumplimiento del empleador, requiere integrar otro sistema con su propia autenticación y ToS. **Decisión de producto, no un spike.** |

### Recomendación estratégica

1. ✅ **E1 (informe bancario) — CERRADA 2026-08-05** (ADR-039). Era la mayor oportunidad no
   explotada; ahora tiene fachada + tarea + CLI + MCP, live-validada.
2. ✅ **P1 + P2 juntas — CERRADAS 2026-08-05** (ADR-038, falsos positivos del monitor).
3. 🔍 **P3 — investigada 2026-08-05, sigue ABIERTA.** Resultó más difícil de lo estimado: "una
   sola lectura" no bastó — 538 nunca aparece con ventas reales, y el candidato encontrado (`502`)
   es inseguro de usar sin un neteo de NC que no se pudo aislar. Ver `docs/audits/2026-08-05-p3-f29-debito.md`.
4. **E6 (factoring)** y **E8 (remanente IVA)** son las dos con impacto monetario directo para el
   cliente final.

---

## 6. Mapa visual del proyecto (graphify)

Generado 2026-08-04 sobre 330 archivos (~260k palabras).

```
graphify-out/graph.html        ← grafo interactivo (abrir en navegador)
graphify-out/GRAPH_REPORT.md   ← informe de auditoría
graphify-out/graph.json        ← datos crudos
```

**2.225 nodos · 5.164 aristas · 128 comunidades.**

**Nodos-dios (las abstracciones centrales del proyecto, por conectividad):**

| Nodo | Aristas |
|---|---|
| `Rut` | 60 |
| `withSession()` | 52 |
| `recordAudit()` | 47 |
| `Runtime` | 47 |
| `PortalSession` | 43 |

Esto **confirma la arquitectura declarada**: `Rut`, `withSession`, `recordAudit`, `Runtime` y
`PortalSession` son exactamente los cinco puntos por los que ADR-003 dijo que debía pasar todo
(seams inyectables + un recibo de auditoría + una sola vía de sesión). Que sean los más conectados
significa que la regla se cumplió en el código, no solo en la documentación.

**Conexión inesperada que el grafo detectó por su cuenta:**

> `whoami — Authenticated Account's Own Identity` ⟷ `opc=112 — Datos Contribuyente Completo`

El grafo notó que `whoami` y el `opc=112` del spike B resuelven **el mismo problema** por dos vías
distintas — que es justo la superficie `profile` pendiente (P8).

### ⚠️ Limitación honesta de este grafo

**2 de 5 lotes de extracción semántica se perdieron** por límite de sesión: los que cubrían
`CLAUDE.md`, `ARCHITECTURE.md`, `CONVENTIONS.md`, `BACKLOG.md`, `ROADMAP.md`,
`COVERAGE-GAP-ANALYSIS.md` y los logs de auditoría. El grafo **sí** cubre el código completo (AST)
más los 37 ADRs y los 10 contratos de wire. El diagnóstico reporta **940 aristas colgantes**,
consistente con esa pérdida.

**Para completarlo:** `/graphify . --update` (re-extrae solo lo que falta; los 3 lotes que sí
llegaron están cacheados).
