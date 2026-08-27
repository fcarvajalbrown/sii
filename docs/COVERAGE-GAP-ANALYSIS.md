# Cobertura actual vs. contabilidad chilena completa — análisis de brechas y plan de spikes

**Preparado:** 2026-08-03, tras cerrar los cinco candidatos de `NEXT-SPIKES-PLAN.md`.
**Sucede a:** `docs/NEXT-SPIKES-PLAN.md` (cerrado — los 5 candidatos originales están entregados).
**Método:** revisión del código fuente completo (`packages/core/src/portal`, `tasks`, `cli`, `mcp`),
más los ADR-001..033, `ROADMAP.md`, `BACKLOG.md` y `docs/sii-contract/*`.

> **Regla que gobierna todo este documento (ADR-004):** cada URL/endpoint aquí está marcado como
> **OBSERVADO** (visto en vivo, con fecha) o **HIPÓTESIS** (aún no observado). Ningún spike puede
> escribir código contra una HIPÓTESIS sin confirmarla en vivo primero. Varias URLs de este
> documento son OBSERVADAS porque fueron capturadas del propio catálogo de servicios del SII
> durante el spike 5 (2026-08-03) — eso reduce mucho el riesgo de routing, pero **no** sustituye
> la captura del contrato de wire de cada una.

---

## 1. Inventario de cobertura actual

25 superficies de lectura + 1 de escritura, sobre 9 formas de wire distintas.

| Módulo | CLI | MCP | Host / endpoint | Forma de wire | Completitud |
|---|---|---|---|---|---|
| **auth / identidad** | `auth login\|logout\|status`, `operate`, `whoami` | `auth_*`, `operate`, `whoami` | `zeusr.sii.cl`, `misiir.sii.cl` | HTML + `DatosCntrNow` inline | ✅ Completo (falta `profile` con domicilio) |
| **RCV** (Libros de Compra y Venta) | `rcv summary\|list\|all` | `rcv_summary\|list\|all` | `www4.sii.cl` SDI | SDI-JSON | ✅ Lectura completa; ❌ falta `rcv match` (conciliación con libro externo) |
| **F29** (IVA mensual) | `f29 formulario\|overview\|status` | `f29_*` | `www4.sii.cl/propuestaf29ui` | SDI-JSON | 🚧 **Solo la PROPUESTA**, no el formulario presentado (ADR-013 Fase 2 diferida) |
| **F22** (Renta anual) | `f22 status\|formulario\|observaciones\|historial` | `f22_*` | `www4.sii.cl/consultaestadof22ui` | SDI-JSON | ✅ El módulo más completo del repo |
| **BHE/BTE** (boletas honorarios) | `bte list`, `bte emit` | `bte_list`, `bte_emit*` | `loa.sii.cl/cgi_IMT` | Inline-JS-map + form-POST | ✅ Lectura; 🚧 emisión (preview validada, ISSUE sin validar); ❌ anulación |
| **BPST** (boletas de terceros) | `bpst list` | `bpst_list` | `zeus.sii.cl/cvc_cgi/bte` | form-POST → HTML | ✅ EMITIDAS validado; 🚧 RECIBIDAS sin fila real observada |
| **DTE autorizados** | `dte authorized` | `dte_authorized` | `palena.sii.cl` | HTML público | ✅ Consulta pública (solo "¿está autorizado a emitir?") |
| **Peticiones administrativas** | `peticiones list` | `peticiones_list` | `www3.sii.cl/sispadinternet` | GWT-RPC | ✅ Completo |
| **DJ — estado** | `dj status` | `dj_status` | `www2.sii.cl/app/djconsulta` | REST-JSON, RUT en path | ✅ Estado de todas las DJ (1835/1847/1879/1887/1926/1948) |
| **DJ — historial/detalle** | `dj historial`, `dj detalle` | `dj_historial`, `dj_detalle` | idem | REST-JSON | 🚧 Contenido validado **solo para DJ 1926**; el resto sin observar |
| **Notificaciones/Correspondencia** | `notificaciones list\|detalle` | `notificaciones_*` | `misiir.sii.cl/CViewCarta.cgi` | form-POST → JSON | ✅ Lista + detalle; 🚧 `opc=43` (detalle formal) sin datos reales |
| **Carpeta Tributaria** | `carpeta historial` | `carpeta_tributaria_historial` | `www2.sii.cl/app/cte-api-carpetatributaria` | REST-JSON (array plano) | 🚧 Contrato capturado 3×; re-verificación en vivo pendiente (401 por posible throttling) |
| **IVA (compuesto)** | `iva <periodo>` | `iva` | join RCV + F29 | — | 🚧 Cuadre crédito validado; **débito indeterminable** (falta código de fallback, `BACKLOG` §3.1) |
| **Renta (compuesto)** | `renta <anio>` | `renta` | join F22 + 12×F29 | — | 🚧 Construido, **sin validar en vivo** |
| **Honorarios (compuesto)** | `honorarios <anio>` | `honorarios` | join BHE + BPST + F29 + F22 | — | ✅ Validado en vivo (2023 y 2025 cuadran exacto) |
| **Giros / deuda** | `giros list` | `giros_list` | `www4.sii.cl/rfiInternet` | **DOM renderizado (SPA)** | ✅ Live-validado 2026-08-04 (3 giros reales, 2 años, coincidencia exacta) (ADR-034) |
| **Monitor de cumplimiento** | `monitor` | `monitor` | sweep F22+F29+peticiones+DJ+notificaciones+giros+LeyCOT | — | ✅ Ampliado a **7 familias** de señales (ADR-037), live-validado 2026-08-04 |

**Formas de wire dominadas:** SDI-JSON · inline-JS-map · form-POST→HTML · GWT-RPC · HTML público ·
REST-JSON-RUT-en-path · form-POST→JSON · REST-JSON-array-plano · DOM-renderizado-sobre-SPA.

---

## 2. Mapa de referencia — obligaciones de una contabilidad chilena completa

Agrupadas por cadencia. Marcadas ✅ cubierto / 🚧 parcial / ❌ ausente.

### Permanente / evento a evento
| Obligación | Estado |
|---|---|
| Emisión de DTE (factura, boleta, NC, ND, guía) | ❌ |
| **Recepción de DTE y acuse de recibo / reclamo (Ley 19.983 — plazo de 8 días corridos)** | 🚧 estado de acuse ✅ `dte acuse` (ADR-036); estado "pendiente" no publicado por SII |
| Registro de Compras y Ventas (RCV) — el libro legal | ✅ |
| Timbraje / CAF (folios autorizados) | ❌ |
| Boletas de honorarios emitidas y recibidas | ✅ |
| Boletas de terceros (BPST) | ✅ |
| Libros contables electrónicos (inscripción y envío) | ❌ |

### Mensual
| Obligación | Estado |
|---|---|
| **F29** — IVA, PPM, retenciones (Art. 42 N°2, 48, impuesto único trabajadores) | 🚧 solo propuesta |
| **F50** — impuestos de retención/adicionales | ❌ (spike D bloqueado: sin datos para validar) |
| Cuadre RCV ↔ F29 (crédito/débito fiscal) | 🚧 débito indeterminable |
| Consulta de giros / deuda vigente | ✅ `giros list` (ADR-034) — solo consulta, nunca paga |
| Cotizaciones previsionales | ⛔ **fuera del SII** (ver §2.1) |

### Anual
| Obligación | Estado |
|---|---|
| **F22** — Declaración de Renta | ✅ |
| **DJ de Renta** (1879 honorarios, 1887 sueldos, 1835, 1847, 1926 RLI/balance, 1948 retiros) | 🚧 estado ✅ / contenido solo 1926 |
| Determinación de RLI y régimen (14 A General / 14 D Pro-Pyme) | 🚧 RLI vía DJ 1926; **régimen vigente ✅ `situacion`** (ADR-035) |
| Balance de 8 columnas y EERR tributario | 🚧 vía DJ 1926 |
| Cuadre honorarios ↔ F29 151 ↔ DJ 1879 | 🚧 falta la pata DJ 1879 |
| Cuadre sueldos ↔ F29 48 ↔ DJ 1887 | ❌ |

### Estado / vigilancia
| Obligación | Estado |
|---|---|
| Situación tributaria (vigencia, timbraje, actividades) | ✅ `situacion` (ADR-035) |
| Obligaciones tributarias pendientes (Ley COT) | ✅ `situacion` (ADR-035) |
| Anotaciones y alertas vigentes | ❌ |
| **Deuda fiscal y giros pendientes** | ✅ `giros list` (ADR-034) |
| Infracciones, multas y condonaciones | ❌ |
| Notificaciones y citaciones Art. 63 | ✅ |
| Carpeta tributaria (emitidas / recibidas) | 🚧 solo emitidas |
| Peticiones administrativas | ✅ |
| Bienes raíces y contribuciones | ❌ |
| Socios / sociedades relacionadas | ❌ |
| Término de giro | ❌ |

### 2.1 Corrección de alcance — lo que **no** vive en el SII

El brief menciona *"Payroll contributions (Formulario 1801) and social security (Caja de
Compensación)"*. Dos precisiones necesarias antes de planificar cualquier spike:

- **No existe (ni este proyecto ha observado) un formulario SII "1801".** La DJ anual de rentas
  del trabajo dependiente es la **1887**, y aparece en vivo en el `dj status` de este
  contribuyente. Si el número 1801 vino de otra fuente, hay que verificarlo antes de usarlo.
- **Las cotizaciones previsionales, AFP, salud y Caja de Compensación NO son obligaciones ante el
  SII.** Se declaran y pagan vía **Previred** (o directo a cada institución). Un spike contra el
  SII para esto no encontraría nada. La huella *tributaria* de la nómina, que sí es del SII, es:
  **F29 código 48** (Retención Impuesto Único a los Trabajadores, Art. 74 N°1 — ya en la taxonomía
  del repo) y la **DJ 1887** anual.
- **Cobertura previsional completa requeriría integrar Previred**, un sistema ajeno con su propia
  autenticación y ToS. Es una decisión de producto (¿el alcance del proyecto es "SII" o "cumplimiento
  del empleador"?), no un spike SII. **Recomendación: mantener fuera de alcance** salvo decisión
  explícita del dueño, y decirlo al cliente contable como límite conocido del servicio.

---

## 3. Análisis de brechas

| # | Brecha | Importancia | Por qué falta hoy |
|---|---|---|---|
| ~~G1~~ | ~~**Deuda fiscal y giros pendientes**~~ | 🔴 Crítica | ✅ **CERRADA** por `sii giros list` (ADR-034, spike A), live-validada 2026-08-04. |
| **G2** | **F29 presentado** (no la propuesta) | 🔴 Crítica | ADR-013 difirió GWT-RPC por frágil; luego ADR-020 construyó el códec, pero nadie retomó Fase 2. Todo el cuadre de IVA se compara contra una *sugerencia*, no contra lo declarado. |
| 〽 G3 | **Recepción/acuse de DTE (Ley 19.983)** | 🔴 Crítica | 🚧 **PARCIALMENTE cerrada** por `sii dte acuse` (ADR-036), live-validada 2026-08-04. El estado de acuse ya viaja en el RCV. **Lo que sigue abierto:** SII no publica un estado "pendiente / dentro de plazo" ni una bandeja de pendientes, así que no se puede responder "¿qué facturas requieren acción AHORA?". |
| **G4** | **F50** (retenciones mensuales) | 🟠 Alta | 🚫 **Spike D intentado 2026-08-04, NO cerrado: bloqueado por falta de datos observables** — este contribuyente (ferretería) no presenta F50, así que no hay con qué validar un parser. Routing y camino barato YA identificados (`getDeclaracionConEstados` con `formId` 1 o 3 — sin determinar cuál). Ver `docs/audits/2026-08-04-spikeD-f50-bloqueado.md`. |
| ~~G5~~ | ~~**Situación tributaria + obligaciones Ley COT**~~ | 🟠 Alta | ✅ **CERRADA** por `sii situacion` (ADR-035), live-validada 2026-08-04. Nota: `opc=8` resultó devolver VACÍO; la fuente real es `opc=118` + `22` + `112`. |
| **G6** | **DJ 1879 / 1887 — contenido** | 🟠 Alta | `dj detalle` funciona pero solo se validó DJ 1926. Sin 1879/1887 no se cierra el cuadre anual de honorarios y sueldos. |
| **G7** | **Cuadre RCV↔F29 lado débito** | 🟠 Alta | Bloqueado por falta de un código observado (`BACKLOG` §3.1): la cuenta de prueba no tuvo ventas. |
| **G8** | **Anotaciones / alertas vigentes** | 🟡 Media | `opc=29`/`opc=33` observados en el mapa, sin explorar. |
| **G9** | **Descarga de PDF (evidencia)** | 🟡 Media | No existe seam de respuesta binaria. Todo es JSON; para auditoría se necesitan los documentos. |
| **G10** | **Carpeta tributaria RECIBIDA** | 🟡 Media | `cterevisar` identificado (observado), no explorado (ADR-033). |
| **G11** | **Timbraje / CAF** | 🟡 Media | URL observada (`zeus.sii.cl/cvc/vdc/`), sin explorar. |
| **G12** | **Bienes raíces / contribuciones** | 🟡 Media | `opc=16`/`opc=34` observados; relevante solo si el cliente tiene propiedades. |
| **G13** | **Socios / sociedades relacionadas** | 🟢 Baja | `opc=28`/`opc=31` observados. Útil para mapear grupos empresariales. |
| **G14** | **Infracciones y condonaciones** | 🟢 Baja | Catálogo observado (`1045-3212.html`), sin explorar. |
| **G15** | **Término de giro** | 🟢 Baja | `sistgiInternet` observado. Evento raro pero crítico cuando ocurre. |
| **G16** | **Emisión de DTE** | ⛔ Bloqueada | Requiere certificado digital, XMLDSig, SOAP, gestión de CAF. Semanas de trabajo + certificado real del dueño (`BACKLOG` §5). |
| ~~G17~~ | ~~**`monitor` no vigila las señales nuevas**~~ | 🟠 Alta | ✅ **CERRADA** por ADR-037, live-validada 2026-08-04: el barrido pasó de 3 a 7 familias de señales y en la primera corrida encontró **3 DJ observadas** que el proyecto no podía ver. |

---

## 4. Spikes propuestos, en orden de prioridad

### 🥇 Spike A — `rfiInternet`: giros, deuda **y** el F29 presentado (G1 + G2)

**El hallazgo de mayor apalancamiento de esta revisión.** Durante el spike 5 se capturó del propio
catálogo del SII el link *"Consultar y pagar giros"* → **`https://www4.sii.cl/rfiInternet/?opcionPagina=ConsultaGiros`**
(OBSERVADO 2026-08-03). `BACKLOG.md` §3.3 identifica **`rfiInternet`** como el camino para el F29
*presentado* (ADR-013 Fase 2). **Son la misma aplicación**: un solo spike GWT-RPC desbloquea las
dos brechas críticas.

- **Exploración:** cargar `rfiInternet` con sesión real, interceptar `XMLHttpRequest`/`fetch`
  (mismo método que DJ y notificaciones), capturar una petición GWT-RPC real de la consulta de
  giros y otra del F29 presentado.
- **Esquema:** derivarlo del *permutation* compilado con `docs/sii-contract/peticiones-schema-extract.py`
  (ADR-020) — **nunca** inferido de muestras de respuesta.
- **Riesgo legal:** la app **también paga giros** (`www2.sii.cl/pagogiro-ui/`, OBSERVADO). Ese flujo
  es escritura con consecuencia monetaria: **jamás tocarlo**. Solo `opcionPagina=ConsultaGiros`.
- **Reutiliza:** `portal/gwt.ts` + `gwt-schema.ts` + `requestText` ya existen. No hay seam nueva.
- **Implementación:** `portal/giros.ts` + `tasks/giros.ts` → `sii giros list` / `giros_list`;
  y `fuente:'presentada'` en `f29 formulario` (sin cambiar la forma del resultado, per ADR-013).
- **Cierra además:** G7 — el F29 presentado trae el débito real, resolviendo el cuadre indeterminable.

### 🥈 Spike B — Mi SII `CViewCarta.cgi`: situación tributaria, obligaciones COT, alertas (G5 + G8)

Cuatro brechas por el precio de una, sobre un CGI **ya dominado** (ADR-032, sin bootstrap, POST en
frío). El propio `MISII_OPC_MAP` de SII (OBSERVADO 2026-08-03 en `misii.min.js`) enumera:

| `opc` | Contenido | Brecha |
|---|---|---|
| `8` | Situación Tributaria | G5 |
| `118` | Obligaciones Tributarias (Ley COT) | G5 |
| `29` | Alertas | G8 |
| `33` | Mensajes emergentes / avisos | G8 |
| `112` | Datos contribuyente completo | cierra `profile`/domicilio (`BACKLOG` §3.4) |
| `22` | Mis Características (incl. régimen tributario) | régimen 14A/14D |
| `28`/`31` | Socios / sociedades relacionadas | G13 |
| `16`/`34` | Bienes raíces / propiedades | G12 |

- **Exploración:** POST `opc=<n>` uno por uno, paceado, y documentar la forma de cada respuesta.
  Ya sabemos que el envelope es `{estado, glosa, data, metaData}` y que `estado:1403` = vacío legítimo.
- **Riesgo:** bajo — todos son `opc` de consulta. **Excepción: `opc=114` ("Ingresar correo Vigente")
  es ESCRITURA** — excluirlo explícitamente del spike.
- **Esfuerzo:** bajo. El facade, el envelope zod y los tests ya existen en `portal/notificaciones.ts`;
  esto es extender el patrón, no inventarlo.
- **Implementación:** `portal/misii.ts` + `tasks/situacion.ts` → `sii situacion` / `situacion_tributaria`.

### 🥉 Spike C — Recepción y acuse de DTE, Ley 19.983 (G3)

- **Punto de partida OBSERVADO:** catálogo `www.sii.cl/servicios_online/1039-3201.html`
  ("Registro de Aceptación o Reclamo de un DTE"). La app real se resuelve siguiendo ese link en
  vivo (técnica ya probada en los spikes 4 y 5).
- **Por qué importa:** el plazo de **8 días corridos** para reclamar es legal y perentorio; pasado
  ese plazo la factura queda tácitamente aceptada y se vuelve título ejecutivo. Un servicio
  contable que no vigila esto asume un riesgo real por su cliente.
- **⚠️ Riesgo legal alto:** aceptar o reclamar un DTE **es escritura con efecto jurídico**. Este
  spike es **estrictamente de LECTURA**: listar DTE recibidos, su estado de acuse y los días
  restantes. Cualquier acción de aceptar/reclamar exige su propio ADR con la postura de escritura
  de ADR-017/ADR-026 (preview + `--confirm`, `destructiveHint`), y **no debe construirse en el
  mismo trabajo**.
- **Implementación:** `portal/dte-recepcion.ts` → `sii dte recibidos` con `diasParaReclamar`
  calculado; alimenta `monitor` como hallazgo `alta` cuando quedan ≤2 días.

### 4º — Spike D — F50 (G4)

- **Punto de partida OBSERVADO:** `opc=11` ("Declaraciones F50") en el `MISII_OPC_MAP`, más el
  catálogo `1042-3265.html` y `1042-3266.html` ("Consulta y seguimiento F29 y F50").
- **Hipótesis fuerte:** F50 es hermano de F29 y probablemente comparte app/wire. Confirmar en vivo.
- **Implementación:** si el wire coincide con F29, `portal/f50.ts` es casi un clon de `f29.ts`
  (estado + formulario + overview). Esfuerzo bajo si la hipótesis se confirma.
- **Nota de alcance:** solo aplica a contribuyentes que retienen; para muchas PyMEs estará siempre
  vacío — y un F50 vacío es un resultado legítimo, no un error.

### 5º — Spike E — DJ 1879 y 1887 (G6)

- **Sin exploración de routing:** `dj detalle` **ya funciona**; lo que falta es validar su tabla
  fiel contra DJ distintas de la 1926 y confirmar que la estructura de secciones/columnas se
  sostiene.
- **⚠️ La trampa documentada en ADR-031 aplica con más fuerza:** el significado de cada columna
  cambia por número de DJ y solo se conoce leyendo la fila `cabecera` alineada. **No construir un
  parser semántico por DJ** — mantener la tabla fiel y dejar la interpretación al lector.
- **Valor:** cierra el cuadre anual — `honorarios` gana la pata DJ 1879, y aparece el cuadre de
  sueldos (F29 código 48 ↔ DJ 1887) que hoy no existe.
- **Riesgo PII:** DJ 1879/1887 traen RUT y montos **por persona**. Aplicar la regla `contactoRut`
  de ADR-031 y, si el set de campos propios no es enumerable, **no exponer `raw`**.

### 6º — Spike F — Extender `monitor` (G17)

**Sin exploración: puro trabajo de integración.** `monitor` vigila 3 señales; hoy son legibles
también DJ, notificaciones, carpeta y (tras el spike A) giros y deuda.

- Añadir al sweep: DJ observadas/no presentadas, notificaciones formales nuevas, giros nuevos,
  deuda > 0, y DTE por vencer plazo de reclamo (tras el spike C).
- **Respetar ADR-024:** el snapshot en disco guarda **solo identificadores y estados**, nunca texto
  libre. Y la regla de "anclar en la evidencia más antigua" antes de asignar severidad.
- **Máximo valor por unidad de esfuerzo** una vez existan A y C: convierte lecturas sueltas en
  vigilancia real.

### 7º — Spike G — Seam binaria + descarga de PDF (G9)

- Añadir `requestBinary` a `PortalSession` (la sexta primitiva).
- Desbloquea: PDF de cartas (`www3.sii.cl/Coreca1Internet/MuestraPdf?`, OBSERVADO, con `codCarta`
  ya expuesto por `f22 historial`), PDF de carpeta tributaria ("Ver PDF inicial", OBSERVADO),
  y el *document vault* de `BACKLOG` §4.
- **Valor:** JSON es análisis; PDF es **evidencia**. Para reconstruir libros perdidos o defender
  una posición ante el SII, se necesita el documento.

### Menor prioridad
- **Spike H** — Carpeta recibida (`cterevisar`, OBSERVADO) — G10.
- **Spike I** — Timbraje/CAF (`zeus.sii.cl/cvc/vdc/`, OBSERVADO) — G11.
- **Spike J** — Infracciones y condonaciones (`1045-3212.html`, OBSERVADO) — G14.
- **Spike K** — Término de giro (`www4.sii.cl/sistgiInternet/?opc=con`, OBSERVADO — usar **solo**
  `opc=con`, jamás `opc=dec` que **declara**) — G15.
- **Spike L** — Bienes raíces (`opc=16`/`34`) — G12.

### Bloqueado (no es spike, es proyecto)
- **G16 — Emisión de DTE.** Necesita carga de certificado `.pfx`/`.p12`, canonicalización XML,
  XMLDSig, SOAP y gestión de folios CAF. `BACKLOG` §5 lo estima en semanas y requiere el
  certificado real del dueño. **Debe ser su propio proyecto con su propio ADR**, no un spike.

---

## 5. Plan de integración (común a todos los spikes)

El patrón está probado seis veces (BPST, DJ×2, notificaciones, carpeta) y no debe reinventarse:

1. **Spike en vivo**, solo lectura, con script desechable en scratch, paceado vía `Clock.sleep`.
2. **`docs/sii-contract/<mod>.md`** — request, response, fecha de observación, y una sección
   explícita de "qué NO se pudo confirmar".
3. **ADR** con el siguiente número libre en `docs/decisions/_index.md`.
4. **TDD**: test rojo → facade → verde. `portal/<mod>.ts` (zod en el borde, curado + política PII)
   → `tasks/<mod>.ts` (`withSession` + un recibo de auditoría **sin PII**) → `cli/src/commands/<mod>.ts`
   (`register<Mod>`) → `mcp/src/tools/<mod>.ts` (`register<Mod>Tools`), registro **append-only**.
5. **Guardrails antes de cerrar**: `npx vitest run` (suite COMPLETA), `pnpm build`, `pnpm lint`,
   más verificación en vivo del binario compilado.
6. **Docs en el mismo commit**: ROADMAP + ARCHITECTURE + `_index.md` + CONVENTIONS si aparece un
   patrón nuevo + un log en `docs/audits/`.

**Normalización y almacenamiento:** los tasks devuelven objetos JSON-serializables planos
(ADR-012); montos en pesos como `number`, fechas verbatim como las entrega el SII, ningún `Date`.
Los períodos cerrados pueden entrar al caché de lectura (ADR-027) — **`monitor` y `giros`/`deuda`
deben quedar SIN caché** por diseño: su valor es que estén frescos.

---

## 6. Recomendaciones

### Ganancias rápidas (bajo esfuerzo, alto retorno)
1. **Spike B** — cuatro brechas sobre un CGI ya dominado, sin wire nuevo. El mejor retorno del plan.
2. **Spike F** — extender `monitor` no requiere ninguna exploración; es integración pura sobre
   lecturas que ya existen.
3. **Cerrar `BACKLOG` §3.1** (código de débito F29) — un solo `f29 formulario` sobre **cualquier**
   período con ventas y el cuadre de IVA queda completo. Es literalmente una observación pendiente.

### Alto esfuerzo, alta recompensa
1. **Spike A (`rfiInternet`)** — el de mayor apalancamiento: deuda + giros + F29 presentado en un
   solo trabajo GWT-RPC, reutilizando un códec que ya existe. Es *el* spike a hacer primero pese a
   su costo.
2. **Spike C (recepción DTE)** — el único con un **plazo legal** encima; diferencia real frente a
   un servicio contable que no lo vigila.
3. **G16 (emisión DTE)** — el salto de "herramienta de lectura y control" a "sistema contable
   completo". Decisión de producto, no de ingeniería.

### Consideraciones legales y de riesgo
- **Nunca mezclar lectura y escritura en un mismo spike.** Tres superficies exploradas ya
  exponían escritura junto a la lectura (anular carpeta, pagar giros, aceptar/reclamar DTE,
  declarar término de giro). Cada escritura exige su propio ADR con la postura de ADR-017/026.
- **`opc=114` y `sistgiInternet?opc=dec` son escritura** — excluirlos explícitamente de los
  spikes B y K respectivamente.
- **PII:** DJ 1879/1887 (RUT y montos por persona) y la carpeta recibida son los payloads más
  sensibles que quedan. Aplicar la regla de ADR-004/ADR-031: si el set de campos propios no es
  demostrablemente enumerable, **eliminar `raw`**, no intentar una denylist.
- **Fuera del SII:** cotizaciones previsionales / Caja de Compensación (§2.1). Si el servicio las
  promete, requiere integrar Previred — otro sistema, otra autenticación, otros ToS, otra decisión.
- **Fiabilidad:** la carpeta tributaria mostró posible throttling (ADR-033). Antes de vender un
  SLA sobre cualquier módulo nuevo, medir su tolerancia a llamadas repetidas.

### Secuencia sugerida
```
A (giros + deuda + F29 presentado)  →  cierra G1, G2 y G7
B (Mi SII opc: situación + COT + alertas + régimen + profile)
F (extender monitor con lo ya legible + A)
C (recepción DTE, solo lectura)
D (F50)  ·  E (DJ 1879/1887)  ·  G (seam binaria + PDF)
H..L (menor prioridad, según el perfil del cliente)
```

---

## 7. Qué NO asumir

- **No asumir que un módulo comparte wire con otro** aunque viva en el mismo host: este repo ya
  encontró **ocho** formas distintas, y dos endpoints del *mismo* host `www2.sii.cl` (DJ y carpeta)
  difieren en el envelope y hasta en el tipo del campo `periodo`.
- **No asumir que un link "oficial" del menú es de lectura.** El spike 4 gastó una sesión completa
  en una app GWT que resultó ser un flujo de *configuración de correo*, no el lector de
  notificaciones (ADR-032). Leer siempre el tooltip y la función JS real antes de invertir.
- **No asumir que la ausencia de datos es un error.** `estado:1403`, `[]` y un mes sin boletas son
  resultados legítimos, y en el caso de las notificaciones formales la *ausencia* fue exactamente
  la respuesta que buscaba la auditoría.
- **No asumir fechas de vencimiento ni severidades.** Aplica la regla de `monitor.ts`: anclar en la
  evidencia más antigua observada antes de declarar un incumplimiento.
