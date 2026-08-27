# ADR-034: Giros (`giros list`) — leer el DOM renderizado en vez de decodificar GWT-RPC

## Status

Accepted — 2026-08-04. Primera lectura de deuda fiscal formal en este proyecto. Cierra la brecha
**G1** de `docs/COVERAGE-GAP-ANALYSIS.md` (spike A). **Refina ADR-020**, que estableció la
capacidad GWT-RPC y rechazó explícitamente el scraping de DOM: aquí se toma la decisión contraria,
y este ADR documenta por qué el razonamiento de ADR-020 no aplica a esta app.

## Context

`docs/COVERAGE-GAP-ANALYSIS.md` identificó "deuda fiscal y giros pendientes" como la brecha
crítica G1 — la pregunta N°1 de cualquier cliente ("¿debo algo?"), invisible para la herramienta.
El mismo análisis encontró que el link *"Consultar y pagar giros"* apunta a **`www4.sii.cl/rfiInternet/`**,
la MISMA app que `BACKLOG.md` §3.3 identifica como el camino al F29 presentado (ADR-013 Fase 2).

El spike en vivo (2026-08-03, a real taxpayer account) confirmó la hipótesis de tecnología y resolvió el
transporte por completo (contrato: `docs/sii-contract/giros.md`):

- **Es GWT**, como se esperaba, y **un replay en frío autenticado funciona** — no hace falta
  manejar la SPA para llamar al RPC.
- **Falta un header que peticiones no necesita: `X-GWT-Permutation`.** Sin él, el servidor
  responde HTTP 500 con el cuerpo byte-idéntico. Costó encontrarlo (hubo que parchear
  `XMLHttpRequest.prototype.setRequestHeader` en vivo).
- **El policy hash es POR SERVICIO**, no global por app.

Pero la decodificación resultó ser un problema de otra categoría. `rfiInternet` habla **GWT
protocolo 7**; `sispadinternet` habla el **5**:

| | sispadinternet (ADR-020) | rfiInternet |
|---|---|---|
| Protocolo | 5 | **7** |
| Registro RPC en el permutation | `p5[sigVar]=[inst,deser,ser]` | **ese patrón no existe** |
| Longs | dos enteros (`a+b`) | **strings base64** |
| Literales de string en la respuesta | ninguno (respuesta puramente numérica) | **comillas simples** → el `JSON.parse` de `parseArray()` **revienta** |
| Tipos | 109 clases | **255 firmas**, permutation de 1,85 MB |

Es decir: reutilizar `portal/gwt.ts` exigiría generalizarlo (esquema parametrizable, error
parametrizable, constructor de request genérico), reescribir el parser de la respuesta, **y
re-derivar desde cero el extractor de esquema** (`peticiones-schema-extract.py` no aplica: su set
de regex apunta a patrones compilados de GWT 2.0.3 que aquí no existen).

## Decision

**Leer la tabla de resultados renderizada en el DOM**, mapeando **por nombre de cabecera**, en vez
de decodificar el GWT-RPC.

El argumento decisivo es el **modo de falla**, no el esfuerzo:

| | Decodificar GWT | **Leer el DOM (elegido)** |
|---|---|---|
| Si SII cambia algo | Un esquema mal derivado corre un campo de posición y devuelve un **monto o una fecha de vencimiento silenciosamente equivocados** | La cabecera esperada no aparece ⇒ **`GirosError` "scraper roto"**, fuerte y visible |
| Sobre qué datos | **Deuda fiscal con fechas de vencimiento** | idem |
| Esfuerzo | Alto | Medio |
| Fragilidad | Baja una vez hecho | Manejar la SPA |

Sobre deuda fiscal, un número silenciosamente errado es peor que una rotura ruidosa. Es el mismo
criterio que ya aplicó dos veces este proyecto: la sesión anterior se detuvo antes de improvisar un
decodificador GWT (`docs/audits/2026-08-03-spike4-notificaciones-progress.md`) y ADR-031 se negó a
construir un parser semántico para el detalle de DJ.

**Por qué el rechazo de ADR-020 al DOM no aplica aquí.** ADR-020 (alternativa 3) descartó el
scraping con dos razones: *(a)* "los datos no están en globals JS limpios (widgets GWT; el modal
renderiza mal)" y *(b)* manejar la SPA en headless es la fragilidad de F29-Fase-2. La razón (a) es
**empíricamente falsa en esta app**: la tabla renderizada es limpia, tabular y rotulada
(`table.tabla_internet`, fila de cabecera con nueve columnas nombradas). La razón (b) sigue siendo
cierta y se acepta como el costo consciente de esta decisión.

Detalles de la implementación:

1. **`portal/giros.ts`** — `goto` a `?opcionPagina=ConsultaGiros`, `pace()`, un `evaluate` que
   maneja la UI, `pace()`, un segundo `evaluate` que devuelve las filas **crudas**. **Toda la
   interpretación ocurre en TypeScript**, no dentro del navegador: así es testeable con fakes.
2. **Mapeo por cabecera, nunca posicional.** `REQUIRED_HEADERS` lista las nueve columnas
   observadas; si falta cualquiera ⇒ `GirosError` con las cabeceras recibidas en el mensaje. Un
   test pinnea que **insertar** una columna nueva no descoloca el mapeo, y que **renombrar** una
   exigida falla fuerte.
3. **⛔ SOLO LECTURA, pinneado por test.** La misma página expone un botón "Pagar" y enlaza
   `www2.sii.cl/pagogiro-ui/`. El script de manejo pulsa **exclusivamente** "Consultar", y un test
   verifica que la expresión enviada al navegador **no menciona "Pagar"**. Cualquier flujo de pago
   exige su propio ADR con la postura de escritura de ADR-017/ADR-026.
4. **`estado` pasa verbatim, sin enum cerrado — y con una advertencia explícita.** Se observó
   `"Vigente"` **junto a saldo $0** en los tres giros reales del contribuyente: **"Vigente"
   describe el documento, NO significa impago.** La deuda es `saldo`. Esto se dice en el tipo, en
   la ayuda del CLI y en la descripción de la tool MCP, porque es exactamente la clase de
   malinterpretación que produciría un informe de auditoría equivocado.
5. **`conteoDeclarado`** guarda el "Se encontraron N Giro(s)" que declara la propia página; el
   task expone `aniosDescuadrados` cuando no coincide con las filas leídas — nunca se trunca en
   silencio (la paginación de esta tabla no se observó).
6. **Session-keyed, self only.** La fachada maneja la UI del SII, que siempre actúa sobre el
   titular de la sesión; se rechaza un puntero `operate` representando a otro RUT antes de abrir
   sesión, igual que F22/F29/DJ/notificaciones/carpeta.

## Alternatives Considered

1. **Decodificar el GWT-RPC siguiendo ADR-020 al pie de la letra.** Rechazado por el modo de falla
   (arriba). El trabajo de transporte ya hecho queda documentado en `docs/sii-contract/giros.md`
   por si un caso futuro obliga a retomarlo.
2. **Generalizar `gwt.ts` ahora, aunque no se use para giros.** Rechazado: refactor especulativo
   sin consumidor: el único consumidor GWT sigue siendo peticiones. Se hará cuando exista una
   segunda superficie GWT que sí se decodifique.
3. **Exponer el saldo únicamente como texto (`"$0"`), sin parsear.** Rechazado: el caso de uso
   central es sumar deuda; un número es necesario. Se conservan **ambos** (`saldo` + `saldoTexto`),
   así que el valor verbatim de SII nunca se pierde.
4. **Barrer muchos años por defecto.** Rechazado: cada año es una carga de página completa más el
   manejo de la SPA. El defecto es el año en curso; `--years` (máx 10) lo amplía explícitamente.

## Consequences

- Cierra la brecha **G1**. Un contador puede responder "¿debo algo?" con folio, formulario de
  origen, fecha de vencimiento y saldo.
- **NO cierra G2 (F29 presentado).** El objetivo 2 del spike A queda pendiente: vive en la misma
  app, pero necesita su propia captura y su propia decisión de decodificación. El trabajo de
  transporte ya resuelto (replay en frío + `X-GWT-Permutation`) se reutiliza tal cual.
- **Deuda asumida conscientemente:** esta es la primera fachada del repo que depende de manejar
  una SPA. Si SII rehace la página, se rompe — pero **ruidosamente**. Revalidar en vivo con más
  frecuencia que las fachadas de wire estable.
- La app carga scripts de **Queue-It** (sala de espera virtual), igual que carpeta tributaria
  (ADR-033) — posible throttling bajo llamadas repetidas, no medido.
- **Seguimiento abierto:** búsqueda por Período y por Folio (solo se ejercitó Anual); paginación
  de la tabla; semántica exacta de `Estado`; alcance para empresa representada.
