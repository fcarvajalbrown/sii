# SII wire contract — Informe bancario (Mi SII `CViewCarta.cgi`, `opc=119`)

> Observado en vivo 2026-08-05, a real taxpayer account. Mismo CGI que
> `docs/sii-contract/notificaciones.md` (ADR-032) y `docs/sii-contract/situacion.md` (ADR-035),
> otro `opc`. Implementado en `packages/core/src/portal/bancario.ts` (ADR-039).

## Request

```
POST https://misiir.sii.cl/cgi_misii/CViewCarta.cgi
opc=119&VIEW=1
```

Sin parámetro de RUT — igual que `situacion`/`notificaciones`, la sesión (cookie) determina de
quién es el informe. No se observó forma de pedir el informe de una empresa representada.

## Response (observada en vivo, 2026-08-05)

```json
{
  "listCarpetaTributaria": [
    {
      "rutTitularC2": 77777777, "dvTitularC2": "7",
      "periodoDj": 202502,
      "glosaNombreBanco": "BANCO DEL ESTADO DE CHILE",
      "glosaTipoCuenta": "CUENTA CORRIENTE",
      "semestre": "Primer semestre 2025",
      "sumaCantidadAbonos": 1433,
      "sumaMontoTotalAbonos": 619837498
    },
    {
      "rutTitularC2": 77777777, "dvTitularC2": "7",
      "periodoDj": 202507,
      "glosaNombreBanco": "BANCO DEL ESTADO DE CHILE",
      "glosaTipoCuenta": "CUENTA CORRIENTE",
      "semestre": "Primer semestre 2025",
      "sumaCantidadAbonos": 1485,
      "sumaMontoTotalAbonos": 656476413
    },
    {
      "rutTitularC2": 77777777, "dvTitularC2": "7",
      "periodoDj": 202601,
      "glosaNombreBanco": "BANCO DEL ESTADO DE CHILE",
      "glosaTipoCuenta": "CUENTA CORRIENTE",
      "semestre": "Primer semestre 2026",
      "sumaCantidadAbonos": 1543,
      "sumaMontoTotalAbonos": 700377279
    }
  ]
}
```

Una fila por semestre × banco × tipo de cuenta.

## ⚠️ La clave `listCarpetaTributaria` es engañosa

SII envuelve esta respuesta bajo una clave que sugiere relación con la Carpeta Tributaria Regular
(ADR-033) — **no la tiene**. Son productos SII completamente distintos que comparten, aparentemente
por reutilización interna de SII, un nombre de campo. `portal/bancario.ts` NUNCA usa ese nombre en
su tipo curado, precisamente para no confundir los dos módulos.

## ⚠️ `periodoDj` no decodifica de forma confiable a un semestre

`periodoDj: 202502` y `periodoDj: 202507` llevan **la misma glosa** `"Primer semestre 2025"` — dos
períodos distintos, la misma etiqueta de semestre. No hay evidencia suficiente para inferir la
regla exacta de codificación (¿mes de cierre del informe? ¿versión de la declaración jurada
subyacente?). `portal/bancario.ts` pasa `periodoDj` y `semestre` **verbatim, sin decodificar**
(ADR-004: no adivinar un formato con datos insuficientes para confirmarlo).

## Campos curados

| Campo curado | Origen | Notas |
|---|---|---|
| `periodoDj` | `periodoDj` | Verbatim, como string. Sin decodificar (ver arriba). |
| `semestre` | `semestre` | Verbatim. |
| `banco` | `glosaNombreBanco` | |
| `tipoCuenta` | `glosaTipoCuenta` | |
| `cantidadAbonos` | `sumaCantidadAbonos` | |
| `montoTotalAbonos` | `sumaMontoTotalAbonos` | |

`rutTitularC2`/`dvTitularC2` se DESCARTAN del tipo curado — son siempre el RUT de la sesión (nunca
un tercero, confirmado en la observación), así que no aportan dato nuevo; el RUT ya viaja en el
resultado de la tarea (`BancarioInforme.rut`), como en el resto del proyecto.

## Envelope

Otra forma más de las muchas que expone este CGI (ADR-035 ya documentó que no hay un envelope
común). Este `opc` no trae `codigoError`/`descripcionError` ni `estado`/`glosa` — es un objeto con
una sola clave (`listCarpetaTributaria`), un array vacío `[]` para "sin informe" (no observado aún
con datos reales, pero consistente con el resto del proyecto: ausencia es un resultado legítimo,
nunca un error).

## Abierto / sin confirmar

- La regla exacta de `periodoDj` → rango de fechas.
- Si existe una vista con el detalle transacción-por-transacción (esta respuesta es un AGREGADO
  por semestre; no se observó una vía de desglose en el mismo `opc`).
- Alcance para una empresa representada (misma cautela que el resto de superficies session-keyed
  de este CGI).
- El caso `[]` (sin informe bancario para el RUT) — no observado con datos reales.
