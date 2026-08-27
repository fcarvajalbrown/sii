# SII wire contract — Giros y deuda (`rfiInternet`)

> **Estado: `giros list` CONSTRUIDO (ADR-034), leyendo el DOM renderizado.** Observado en vivo
> 2026-08-03, a real taxpayer account. **La decodificación GWT-RPC quedó DESCARTADA deliberadamente**
> (ADR-034: modo de falla) — el trabajo de transporte que sí se resolvió se conserva abajo porque
> sigue siendo válido y es lo que necesitará el F29 presentado (objetivo 2, pendiente).

## Qué es

`rfiInternet` es la app "Consulta y pago de giros" del SII: los giros emitidos al contribuyente
(deuda fiscal formal), con folio, formulario asociado, fechas de emisión/vencimiento, estado,
moneda y saldo. `BACKLOG.md` §3.3 identifica esta MISMA app como el camino al **F29 presentado**
(ADR-013 Fase 2) — confirmar eso es el segundo objetivo del spike.

## Routing (OBSERVADO 2026-08-03)

| Qué | URL |
|---|---|
| Página de consulta (solo lectura) | `https://www4.sii.cl/rfiInternet/?opcionPagina=ConsultaGiros` |
| Endpoint GWT-RPC | `https://www4.sii.cl/rfiInternet/formularioFacade` |
| Bootstrap GWT | `https://www4.sii.cl/rfiInternet/rfi.nocache.js` |
| Permutation compilado | `https://www4.sii.cl/rfiInternet/<PERM>.cache.html` (1,85 MB) |
| ⛔ **Pago — NUNCA TOCAR** | `https://www2.sii.cl/pagogiro-ui/` y el botón "Pagar" de la propia página |

## ⚠️ La página mezcla lectura y ESCRITURA

El DOM expone los botones `Volver`, `Limpiar Formulario`, **`Consultar`** y **`Pagar`**. Solo
`Consultar` es lectura. Cualquier facade construido aquí debe alcanzar **exclusivamente**
`findGiros`; el flujo de pago exige su propio ADR con la postura de escritura de ADR-017/ADR-026 y
**no debe construirse en el mismo trabajo**.

## Transporte — RESUELTO: replay en frío autenticado

Igual que peticiones/SISPAD (ADR-020), **un POST en frío funciona**: no hay que manejar la SPA.
Confirmado empíricamente comparando frío vs. tras `goto` — ambos devuelven `//OK[…]` de 9.373 bytes
idénticos.

**El header que lo desbloquea (y que peticiones NO necesita):**

```
Content-Type:        text/x-gwt-rpc; charset=utf-8
X-GWT-Module-Base:   https://www4.sii.cl/rfiInternet/
X-GWT-Permutation:   CD2B6AA3826B041E43F4BE765FCC2367
```

**Sin `X-GWT-Permutation` el servidor responde HTTP 500** (`The call failed on the server; see
server log for details`) — con el cuerpo byte-idéntico. Costó encontrarlo: fue necesario parchear
`XMLHttpRequest.prototype.setRequestHeader` en vivo para verlo. `portal/peticiones.ts` no envía
ese header y funciona, así que **es específico de esta app**, no una regla general de GWT en SII.

## Request `findGiros` (OBSERVADO verbatim)

```
7|0|9|https://www4.sii.cl/rfiInternet/|29E69C41F2D58960EDE7876E4AFF75B8|cl.sii.sdi.dim.rfi.web.client.service.FormularioFacade|findGiros|java.lang.Integer/3438268394|java.lang.Long/4227064769|java.lang.String/2004016611|java.lang.Boolean/476441737|7|1|2|3|4|6|5|5|6|5|7|8|5|<ANIO>|0|0|5|<RUT_BODY>|9|8|0|
```

Decodificado:

| Parte | Valor |
|---|---|
| Versión protocolo | **7** (peticiones usa **5** — protocolos distintos) |
| Tabla de strings | 9 entradas; la 9ª es el literal `"7"`, usado como parámetro String |
| Servicio | `cl.sii.sdi.dim.rfi.web.client.service.FormularioFacade` |
| Método | `findGiros` |
| Policy hash (este servicio) | `29E69C41F2D58960EDE7876E4AFF75B8` |
| Parámetros (6) | `Integer <ANIO>`, `Integer null`, `Long null`, `Integer <RUT_BODY>`, `String "7"`, `Boolean false` |

**Cada servicio de la app tiene su PROPIO policy hash** (observado): `formularioFacade`
→ `29E69C…`, `sdiFacade` → `5354C0…`, `SdiAATokenService` → `BF10D3…`, `sdiAAService` → `7C86B0…`.
El auto-sanado de hash de ADR-020 debe ser **por servicio**, no global.

Los parámetros 2 y 3 (`Integer null`, `Long null`) corresponden presumiblemente a período y folio
— las otras dos opciones de búsqueda del formulario (Anual / Período / Folio). **No confirmado**:
solo se ejercitó la búsqueda Anual.

## Respuesta — NO decodificada aún

`//OK[…]` de 9.373 bytes. **Dos diferencias que rompen el códec actual (`portal/gwt.ts`):**

1. **Contiene literales entre comillas SIMPLES** (`'0LTRH'`, `'Z7870YA'`, `'Ifs0uQ'`, `'Dd'`…).
   El `parseArray()` actual hace `JSON.parse`, que **falla** con comillas simples. La respuesta de
   peticiones era puramente numérica, por eso funcionaba.
2. Esos literales son **longs codificados en base64** (formato `LongLib` de GWT), no la pareja de
   enteros `a+b` que decodifica el op `'l'` actual.

Valores reconocibles a simple vista en la respuesta: `202604`, `202606` (períodos), `13101`,
`97011000`, `60803000`. **No se han interpretado** — asignarles significado sin el esquema es
exactamente el error silencioso que ADR-020 existe para evitar.

## Lo que SÍ renderiza el DOM (verificado)

Tras pulsar `Consultar` la app pinta una tabla limpia y rotulada:

```
Se encontraron 1 Giro(s)
Período | Folio Giro | Formulario Giro | Formulario Asociado | Fecha de Emisión |
Fecha de Vencimiento | Estado | Moneda | Saldo | Ver | Pagar en linea | Imprimir Giro

Abril 2026 | 9121778576 | 21 | 29 | 25/06/2026 | 20/05/2026 | Vigente | CLP | $0
```

Dato real del contribuyente: **un giro**, formulario 21 asociado a un **F29**, período abril 2026,
**saldo $0**. (Un giro "Vigente" con saldo 0 — no interpretar como deuda impaga sin confirmar la
semántica de `Estado` vs `Saldo`.)

## El obstáculo pendiente: el esquema

ADR-020 exige derivar el esquema por tipo de los **deserializadores del permutation compilado**,
nunca de muestras de respuesta. Para `rfiInternet` eso requiere **re-derivar el extractor**:

| | sispadinternet (resuelto) | rfiInternet (pendiente) |
|---|---|---|
| Versión GWT | 2.0.3, protocolo 5 | protocolo **7** |
| Registro RPC | `p5[sigVar]=[inst,deser,ser]` | **ese patrón no existe**; registro ofuscado distinto |
| Helpers de lectura | `p1b`, `OIb`, `b1b` | sin identificar |
| Tipos | 109 clases | **255 firmas** (`cl.sii.sdi.dim.rfi.to.*`) |
| Longs | dos enteros (`a+b`) | strings base64 |

`docs/sii-contract/peticiones-schema-extract.py` **no aplica sin reescribir su set de regex**.

## Riesgo — por qué esto no se apuró

Un esquema mal derivado **no falla ruidosamente**: decodifica campos en la posición incorrecta y
produce un monto o una fecha de vencimiento silenciosamente equivocados. Sobre **deuda fiscal con
fechas de vencimiento**, ese error tiene consecuencia real. Es el mismo razonamiento por el que la
sesión anterior se detuvo antes de improvisar un decodificador GWT
(`docs/audits/2026-08-03-spike4-notificaciones-progress.md`) y por el que ADR-031 se negó a
construir un parser semántico para el detalle de DJ.

## Decisión tomada: leer el DOM (ADR-034)

Dos caminos con perfiles de riesgo opuestos; se eligió **B** por decisión explícita del dueño:

| | **A. Decodificar GWT** | **B. Leer la tabla del DOM (ELEGIDO)** |
|---|---|---|
| Esfuerzo | Alto (re-derivar extractor + generalizar `gwt.ts`) | Medio |
| Modo de falla | **Silencioso** (campo corrido ⇒ monto errado) | **Ruidoso** (cabecera no coincide ⇒ "scraper roto") |
| Fragilidad | Baja una vez hecho (replay en frío) | Manejar la SPA = la fragilidad que ADR-013 evita |
| Precedente | ADR-020 lo prefiere | ADR-020 lo rechazó — pero por un motivo **empíricamente falso aquí** ("los datos no están en globals limpios"): esta tabla SÍ está limpia y rotulada |

Razón decisiva: sobre **deuda fiscal con fechas de vencimiento**, un monto silenciosamente errado
es peor que una rotura ruidosa. Razonamiento completo en ADR-034.

### Contrato del DOM que consume `portal/giros.ts`

- Tabla: `table.tabla_internet` que contenga el texto `Folio Giro`.
- Fila 0: título `Consulta Giros`. Fila 1: cabeceras. Filas 2+: datos.
- **Cabeceras EXIGIDAS** (si falta una ⇒ `GirosError` "scraper roto"): `Período`, `Folio Giro`,
  `Formulario Giro`, `Formulario Asociado`, `Fecha de Emisión`, `Fecha de Vencimiento`, `Estado`,
  `Moneda`, `Saldo`.
- Columnas de acción **descartadas** y nunca expuestas: `Ver`, `Pagar en linea`, `Imprimir Giro`.
- Conteo declarado por la página: `Se encontraron N Giro(s)` — se compara contra las filas leídas.

### Filas reales observadas (2026-08-03)

| Año | Período | Folio | Form. giro | Form. asociado | Emisión | Vencimiento | Estado | Saldo |
|---|---|---|---|---|---|---|---|---|
| 2026 | Abril 2026 | 9121778576 | 21 | 29 | 25/06/2026 | 20/05/2026 | Vigente | $0 |
| 2021 | Febrero 2021 | 7458541866 | 21 | 29 | 22/06/2022 | 22/03/2021 | Vigente | $0 |
| 2021 | Agosto 2021 | 7757526896 | 21 | 29 | 03/10/2023 | 20/09/2021 | Vigente | $0 |

⚠️ **`Estado: "Vigente"` apareció junto a `Saldo: $0` en los TRES giros.** "Vigente" describe el
documento, **no** significa impago. La deuda es `Saldo`. No asumir lo contrario en ningún informe.

## Trabajo ya resuelto que NO hay que repetir

- Routing y endpoint ✅
- Header `X-GWT-Permutation` (el bloqueador del 500) ✅
- Request `findGiros` verbatim, con año y RUT parametrizados ✅
- **Replay en frío confirmado** (no hace falta manejar la SPA) ✅
- Permutation descargado y caracterizado ✅
- Confirmado que el policy hash es **por servicio** ✅

## Abierto / sin confirmar

- Decodificación de la respuesta (el esquema).
- Búsqueda por **Período** y por **Folio** (solo se ejercitó Anual).
- El **F29 presentado** en esta misma app (objetivo 2 del spike) — sin capturar.
- Semántica de `Estado` vs `Saldo` en un giro.
- Alcance para empresa representada — sin probar.
- Esta app también carga scripts de **Queue-It** (sala de espera virtual), igual que carpeta
  tributaria (ADR-033) — posible throttling bajo llamadas repetidas, no medido.
