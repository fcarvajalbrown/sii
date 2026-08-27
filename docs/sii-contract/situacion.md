# SII wire contract — Situación tributaria (Mi SII `CViewCarta.cgi`, otros `opc`)

> Observado en vivo 2026-08-04, a real taxpayer account. Mismo CGI que
> `docs/sii-contract/notificaciones.md` (ADR-032), distintos `opc`. Implementado en
> `packages/core/src/portal/situacion.ts` (ADR-035).

## Hallazgo estructural: `CViewCarta.cgi` NO tiene un envelope común

ADR-032 documentó el envelope `{estado, glosa, data, metaData}` para `opc=40/41/42/43`. **Ese
envelope NO es del CGI: es de esos `opc`.** Sondeando diez `opc` de lectura aparecieron **seis
formas distintas**. El CGI es un despachador, no una API con contrato único — por eso
`portal/situacion.ts` tiene tres esquemas zod separados, no uno.

| `opc` | Etiqueta en `MISII_OPC_MAP` | Resultado real (observado) | Forma de la respuesta |
|---|---|---|---|
| `8` | Situación Tributaria | **cuerpo VACÍO** (len=0) — *no* es la fuente pese al nombre | — |
| `118` | Obligaciones Tributarias (Ley COT) | ✅ el "¿estoy en regla?" | `{semestreActual, atributos[], historicos, estado, mostrarObligacionTributaria}` |
| `29` | Alertas | ⚠️ **la etiqueta MIENTE**: son reportes "¿cómo se usaron mis impuestos?" | `{data:{codigoResultado,reportes[]}, metaData}` |
| `33` | Mensajes emergentes | avisos con glosa/solución | `{codigoError, descripcionError, sysdate, mensajes[]}` |
| `112` | Datos Contribuyente completo | ✅ perfil íntegro (7,7 KB) | `{codigoError, …, contribuyente{}, actEcos[], direcciones[], representantes[], socios[], timbrajes[]}` |
| `22` | Mis Características | ✅ **régimen tributario** | `{codigoError, …, atributos[]}` |
| `28` | Socios | vacío para este RUT | `{objSalida, codigo, descripcion}` |
| `31` | Sociedades a las que pertenece | vacío para este RUT | `{codigoError, …, listParticipSocio}` |
| `21` | Giros / Actividades | vacío para este RUT | `{numRegistros, listHistoricoGiros}` |
| `9` | Inicio Actividades | **HTTP 401** — requiere algo no observado | `{error}` |

**⛔ `opc=114` ("Ingresar correo Vigente") es ESCRITURA** — excluido explícitamente del sondeo y
del código. No debe llamarse nunca desde una superficie de lectura.

## `opc=118` — cumplimiento de la Ley COT

```
POST https://misiir.sii.cl/cgi_misii/CViewCarta.cgi
opc=118&VIEW=1
```

```json
{
  "semestreActual": "",
  "atributos": [
    { "atrCodigo": "NDIR", "cumple": "SI", "condicion": "B",
      "titulo": "No tener atrasos en declaración de IVA y/o Renta",
      "descripcion": "…no has presentado, a lo menos en 􀆟empo y forma…" },
    { "atrCodigo": "DQDT", "cumple": "SI", "condicion": "C", "titulo": "No tener denuncias o querellas por delito", "descripcion": "…" },
    { "atrCodigo": "ATPJ", "cumple": "SI", "condicion": "D", "titulo": "No tener antecedentes y/o documentos tributarios por justificar", "descripcion": "…" }
  ],
  "historicos": null,
  "estado": "Cumple sus obligaciones tributarias",
  "mostrarObligacionTributaria": "1"
}
```

- `estado` es la respuesta de titular: verbatim, **sin enum cerrado** (solo se observó el caso
  "cumple"; el texto de incumplimiento no se ha visto).
- `cumple`: `"SI"`/`"NO"`. Cualquier otro valor **no se coerce** a booleano — se expone
  `cumple: null` + `cumpleTexto` verbatim.
- `atrCodigo` observados: `NDIR`, `DQDT`, `ATPJ`. Sin enum cerrado.

### ⚠️ SII corrompe su propio texto con ligaduras del Área de Uso Privado Unicode

Las `descripcion` traen caracteres PUA en lugar de letras: **`U+10019F` donde va `"ti"`** y
**`U+1001A1` donde va `"tí"`**. Es decir, SII sirve `"􀆟empo"` por `"tiempo"`, `"respec􀆟vo"` por
`"respectivo"`, `"ar􀆡culo"` por `"artículo"`. Es un artefacto de una fuente tipográfica (probable
origen PDF), no información.

`portal/situacion.ts` normaliza **solo esos dos puntos de código observados**; cualquier otro
carácter PUA pasa intacto (ADR-004: no adivinar). Si aparece texto ilegible nuevo, hay que
observar el punto de código y añadirlo con su cita.

## `opc=22` — régimen tributario vigente

```json
{ "codigoError": 0, "atributos": [
  { "rut": 77777777, "dv": "7", "atrCodigo": "M14A",
    "descAtrCodigo": "REGIMEN GENERAL SEMI INTEGRADO (14A)",
    "fechaInicio": "01-01-2022", "fechaTermino": null,
    "valor": "PR2022 Ingresos Promedio Mayor a 75.000 UF y Supera las 85.000 UF en un periodo",
    "usuarioActivacion": "S6080300", "usuarioDesactivacion": null,
    "eliminado": null, "fechaCreacion": "28-07-2022" } ] }
```

Cuatro atributos observados en vivo para este RUT — **no es solo el régimen**, es un conjunto de
características tributarias:

| `atrCodigo` | `descAtrCodigo` | desde |
|---|---|---|
| `M14A` | REGIMEN GENERAL SEMI INTEGRADO (14A) | 01-01-2022 |
| `REGS` | CONTRIBUYENTE PERTENECE AL REGISTRO DE SOCIEDADES | 11-06-2019 |
| `FAEL` | FACTURADOR ELECTRONICO | 09-07-2019 |
| `SGGC` | GRAN EMPRESA | 01-01-2026 |

**PII:** `usuarioActivacion`/`usuarioDesactivacion` traen el identificador del **funcionario del
SII** que hizo el cambio (`S6080300`). Se descarta, igual que `peticiones.ts` quita el nombre del
funcionario de la glosa (ADR-006).

## `opc=112` — perfil del contribuyente

Devuelve seis bloques: `contribuyente` (45 campos), `actEcos[]`, `direcciones[]`,
`representantes[]`, `socios[]`, `timbrajes[]`.

### 🔑 `fechaInicioActividades` — el campo que `monitor.ts` daba por inexistente

`contribuyente.fechaInicioActividades` = `"2019-06-19 00:00:00.0"` (observado).

`docs/CONVENTIONS.md` afirmaba: *"no observed 'fecha de inicio de actividades' field exists to
consult (ADR-004 forbids asserting one we have not seen live)"*, y `monitor.ts` implementa por eso
una heurística de "anclar en la evidencia más antigua". **Ahora el campo está observado.** Y
confirma que la heurística acertaba: el hallazgo en vivo de 2026-07-29 (AT2019 marcado
falsamente como incumplimiento para este contribuyente) se explica exactamente porque el inicio de
actividades es **19-06-2019**, posterior al año comercial que cubre AT2019.

⚠️ **Formatos de fecha inconsistentes dentro de la MISMA respuesta**: `fechaInicioActividades` usa
`"YYYY-MM-DD HH:MM:SS.s"` mientras `actEcos[].fechaInicio` usa `"DD-MM-YYYY"`. Ambos se pasan
verbatim; el consumidor decide.

### Otros campos útiles de `contribuyente`

`razonSocial`, `tipoContribuyenteDescripcion` ("PERSONA JURIDICA COMERCIAL"),
`subtipoContribuyenteDescrip` ("SOCIEDAD POR ACCIONES"), `segmentoDescripcion` ("GRAN EMPRESA"),
`glosaActividad`, `fechaConstitucion`, `fechaTerminoGiro` (null si vigente), `declaraTG`,
`autorizadoDeclararDia20` **(curado — `"S"` para este contribuyente; ahora expuesto como
`autorizadoDeclararDia20: boolean | null` en `PerfilContribuyente`, define si el plazo mensual de
F29 es el día 12 o el 20, cableado en `monitor.ts` para el falso positivo del mes anterior, P1)**,
`capitalEnterado`, `unidadOperativaDescripcion`.

### `actEcos[]` y `timbrajes[]`

- `actEcos`: `codigo` (CIIU), `descripcion`, `categoriaTributaria`, `afectoIva` (`"S"`/`"N"`),
  `fechaInicio`. Seis observadas.
- `timbrajes`: `codigo` (tipo DTE), `descripcion`, `fechaLegalizacion`. Ocho observados —
  **incluye el timbraje de cada tipo de documento**, útil para verificar qué puede emitir.

### PII en `fetchPerfilContribuyente` (superficie `situacion`): lo que NO expone

| Bloque | Contenido | Decisión |
|---|---|---|
| `socios[]` | RUT, nombres, **participación en capital y utilidades** de terceros | ❌ solo se informa el CONTEO |
| `representantes[]` | RUT + nombres del representante legal | ❌ solo el CONTEO |
| `direcciones[]` | calle/número/comuna + teléfono + **`rutPropietario`** (el arrendador) | ❌ solo el CONTEO |
| `contribuyente.eMail` / `telefonoMovil` | contacto propio | ❌ territorio de `whoami`, que declara su exposición |

### `fetchPerfilCompleto` (superficie `profile`, ADR-041) — campos REALES observados

Re-confirmado en vivo 2026-08-05, a real taxpayer account (**valores reales de terceros NO citados
aquí** — son PII de personas/empresas distintas del contribuyente; solo se citan nombres de
campo). Misma petición `opc=112`, otra proyección — `fetchPerfilContribuyente` no cambia.

- **`socios[]`**: `rut`, `dv`, `razonSocial` (si el socio es una empresa) o `nombres` +
  `apellidoPaterno` + `apellidoMaterno` (si es persona), `participacionCapital`,
  `participacionUtilidades`, `porcentajeAtribucion`, `fechaIncorporacion`,
  `fechaFinParticipacion`, `fechaModificacion`, `vigente` (`"S"`/`"N"`). Cada elemento trae
  además `codigoError`/`descripcionError`/`sysdate`/`index` — ruido de un envelope repetido por
  fila, NO datos del socio; descartados. `sraGpk`/`sraNdr` observados siempre `null` — significado
  desconocido, no curados (ADR-004: no adivinar).
- **`representantes[]`**: `rut`, `dv`, `razonSocial` (raro) o `nombres`+apellidos, `fechaInicio`,
  `fechaTermino`, `vigente`.
- **`direcciones[]`**: `calle`, `numero`, `comunaDescripcion`, `regionDescripcion`,
  `tipoDomicilioDescripcion`, `tipoPropiedadDescripcion`, `telefono`, `canon`,
  **`rutPropietario`/`dvPropietario`** (el arrendador — el ÚNICO tercero en esta forma),
  `fechaModiRegistro`.

`profile` (`tasks/profile.ts`) cura estos tres bloques pero solo los expone con
`incluirTerceros: true` — sin eso, igual que `situacion`, solo el conteo. El domicilio PROPIO
(calle/comuna/región/tipo/teléfono) se expone SIEMPRE; solo `rutPropietario`/`dvPropietario` se
redactan a `null` sin el opt-in.

## Abierto / sin confirmar

- **`opc=9`** (Inicio Actividades) devuelve **401** — requiere algún parámetro o precondición no
  observada.
- **`opc=8`** devuelve vacío: puede requerir parámetros, o estar en desuso.
- El texto de `estado` cuando el contribuyente **NO** cumple (solo se observó el caso positivo).
- `opc=28`/`31`/`21` devolvieron estructuras vacías para este RUT — sus formas pobladas no se han
  visto.
- Alcance para empresa representada: no probado (misma cautela que el resto de superficies
  session-keyed).
- Significado real de `sraGpk`/`sraNdr` en `socios[]` — siempre `null` en la observación
  disponible.
