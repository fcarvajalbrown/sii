# ADR-035: Situación tributaria (`situacion`) — cumplimiento Ley COT, régimen y perfil

## Status

Accepted — 2026-08-04. Cierra las brechas **G5** (situación tributaria + obligaciones Ley COT) y
buena parte de **G8** de `docs/COVERAGE-GAP-ANALYSIS.md` (spike B). **Extiende ADR-032**, que
introdujo el CGI `CViewCarta.cgi` para notificaciones, con otros `opc` del mismo CGI — y **corrige
una afirmación suya**: ese envelope no era del CGI, era de esos `opc`.

## Context

`COVERAGE-GAP-ANALYSIS.md` marcó el spike B como la mejor relación valor/esfuerzo del plan: cuatro
brechas sobre un CGI **ya dominado** (ADR-032: POST en frío, sin bootstrap). El `MISII_OPC_MAP`,
leído en vivo del propio `misii.min.js`, enumeraba los `opc` candidatos.

El sondeo en vivo (diez `opc` de lectura, paceados) confirmó el valor y produjo tres hallazgos que
cambian cómo hay que tratar este CGI (contrato: `docs/sii-contract/situacion.md`):

1. **`CViewCarta.cgi` no tiene un envelope común.** Es un despachador: aparecieron **seis formas
   de respuesta distintas** entre diez `opc`. ADR-032 documentó `{estado, glosa, data, metaData}`
   como "el envelope"; en realidad es el envelope **de `opc=40/41/42/43`**.
2. **Las etiquetas del `MISII_OPC_MAP` no son fiables.** `opc=29` está rotulado "Alertas" pero
   devuelve los reportes "¿cómo se usaron mis impuestos?". Y `opc=8`, rotulado "Situación
   Tributaria" —el nombre exacto de lo que buscábamos— devuelve **cuerpo vacío**. El mapa sirve
   para *encontrar candidatos*, nunca para *asumir contenido*.
3. **`opc=112` expone `fechaInicioActividades`** — un campo que `docs/CONVENTIONS.md` declaraba
   inexistente y por cuya ausencia `monitor.ts` implementa una heurística de "anclar en la
   evidencia más antigua".

## Decision

1. **Nueva fachada `portal/situacion.ts` con TRES funciones y TRES esquemas zod** —
   `fetchCumplimientoCot` (opc=118), `fetchRegimenes` (opc=22), `fetchPerfilContribuyente`
   (opc=112). No se intentó un esquema único: sería una mentira sobre la forma real del CGI.
   Reutiliza el seam `requestForm` y la ausencia de bootstrap ya establecidas por ADR-032.
2. **Nuevo task `situacionTributaria`** que compone las tres en UNA sesión, paceadas, y añade
   `requisitosIncumplidos` (los requisitos COT con `cumple === false`) para que el consumidor no
   tenga que filtrar a mano lo que es la señal accionable.
3. **PII: solo se cuentan socios, representantes y direcciones — nunca se identifican.**
   `opc=112` trae RUT, nombres y **porcentajes de participación** de socios; RUT y nombre del
   representante legal; y el domicilio con el **RUT del propietario del inmueble** (un tercero).
   Saber *cuántos* hay es informativo; identificarlos es exponer terceros sin necesidad. Se
   expone `conteos: {socios, representantes, direcciones}` y nada más. Pinneado por test.
   Tampoco se exponen `eMail`/`telefonoMovil` propios: ese es territorio de `whoami`, que declara
   su exposición explícitamente (ADR-006).
4. **Se descarta `usuarioActivacion`/`usuarioDesactivacion` de `opc=22`** — el identificador del
   funcionario del SII que hizo el cambio. Mismo criterio con el que `peticiones.ts` quita el
   nombre del funcionario de la glosa.
5. **Se normalizan DOS puntos de código PUA, citados; ningún otro.** SII sirve su propio texto con
   ligaduras tipográficas del Área de Uso Privado: `U+10019F` donde va `"ti"` y `U+1001A1` donde
   va `"tí"` (`"􀆟empo"` por `"tiempo"`, `"ar􀆡culo"` por `"artículo"`). Es corrupción de SII, no
   información, y deja el texto ilegible para un humano y para un LLM. Se normalizan **solo los
   dos observados**; cualquier otro PUA pasa intacto (ADR-004: no adivinar).
6. **`estado` y `cumple` pasan verbatim, sin enum cerrado.** Solo se observó el caso "Cumple sus
   obligaciones tributarias"; el texto de incumplimiento **no se ha visto**. Un `cumple` distinto
   de `SI`/`NO` da `cumple: null` + `cumpleTexto` verbatim, nunca un booleano inventado.
7. **⛔ `opc=114` ("Ingresar correo Vigente") queda excluido** por ser escritura — del sondeo y del
   código.
8. **Session-keyed, self only**, como todo lo que sirve este CGI (ADR-032).

## Alternatives Considered

1. **Un esquema zod único para `CViewCarta.cgi`.** Rechazado: el sondeo probó que no existe tal
   contrato. Forzarlo obligaría a `.loose()` en todo y perdería la validación de borde que ADR-011
   busca.
2. **Confiar en las etiquetas del `MISII_OPC_MAP`.** Rechazado empíricamente: dos de diez etiquetas
   resultaron equivocadas o vacías. El mapa es una pista de dónde mirar, no una fuente.
3. **Exponer socios/representantes/direcciones con una denylist de campos.** Rechazado por el mismo
   criterio de ADR-004 que llevó a BTE/BPST a eliminar `raw`: el conjunto de campos de terceros no
   es demostrablemente enumerable, así que se elimina el bloque entero. Una superficie `profile`
   con opt-in explícito puede exponerlos más adelante, declarándolo.
4. **Dejar el texto con las ligaduras PUA intacto, por pureza de "verbatim".** Rechazado: no es
   información de SII, es un defecto de codificación que hace el texto ilegible. Normalizar dos
   puntos de código citados es un arreglo de presentación, no una reinterpretación de contenido.
5. **Usar `fechaInicioActividades` inmediatamente dentro de `monitor.ts`.** Diferido a propósito
   (ver Consequences): cambiar la lógica de severidad del monitor merece su propio trabajo con sus
   propios tests, no un efecto colateral de este spike.

## Consequences

- Responde de una sola lectura: *¿en qué régimen estoy?*, *¿desde cuándo existo?*, *¿qué
  actividades declaro?*, *¿qué documentos tengo timbrados?* y *¿estoy en regla con la Ley COT?*.
- **Habilita una mejora real de `monitor.ts`** (no incluida aquí): hoy ancla en la evidencia más
  antigua encontrada porque no tenía la fecha de inicio de actividades; ahora puede usar el dato
  autoritativo. La heurística actual queda **validada** por este hallazgo (inicio 19-06-2019
  explica exactamente el falso positivo de AT2019 documentado en `CONVENTIONS.md`), así que el
  cambio es una mejora de precisión, no una corrección de un error.
- Corrige el alcance de lo que ADR-032 llamó "el envelope" de `CViewCarta.cgi`.
- **Seguimiento abierto:** `opc=9` devuelve 401 (precondición no observada); `opc=8` vuelve vacío;
  el texto de `estado` en incumplimiento sigue sin observarse; una superficie `profile` con opt-in
  cerraría `BACKLOG` §3.4 (domicilio); alcance para empresa representada sin probar.
