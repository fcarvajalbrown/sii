# Orden del proyecto sii — explicado sin jerga

**Fecha:** 2026-08-19. Escrito para el dueño del proyecto, no para un programador.

---

## 1. Los tres conceptos, con tu propio proyecto como ejemplo

Vas a oír estas tres palabras todo el tiempo. Son simples:

### Commit — "un trabajo guardado y fechado"

Piensa en un **asiento contable**: tiene fecha, una glosa que explica qué pasó, y una vez
registrado queda ahí para siempre. Un *commit* es exactamente eso, pero para el código.

Ejemplo real de tu proyecto:

```
2026-08-06 | feat(core): Giros — deuda fiscal formal (ADR-034)
```

Eso dice: el 6 de agosto se guardó el trabajo que agregó la consulta de giros.

**Tu proyecto tiene 73 de estos**, del 25 de julio al 19 de agosto.

### Branch (rama) — "el cuaderno donde trabajas antes de pasar en limpio"

Imagina que tienes el **libro oficial** de la empresa, y aparte un **cuaderno de trabajo** donde
anotas todo el mes antes de pasarlo al libro. La rama es ese cuaderno.

Tu proyecto tiene dos:

| Nombre | Qué es |
|---|---|
| `main` | El **libro oficial**. Es lo que está publicado. |
| `feat/composite-iva-renta` | El **cuaderno de trabajo**. Aquí está TODO lo de las últimas 7 semanas. |

**Las cinco conversaciones escribieron todas en el mismo cuaderno.** Por eso no hay nada perdido
ni mezclado: aunque las conversaciones fueron separadas, el trabajo quedó en un solo lugar y
ordenado por fecha.

### Pull Request (PR) — "pedir que se pase del cuaderno al libro oficial"

Es la solicitud formal de decir: *"revisé el cuaderno, está bien, pásalo al libro oficial"*.
Sirve para que alguien lo revise antes de que sea definitivo.

**Tu proyecto no tiene ninguno abierto.** El cuaderno nunca se ha pasado al libro.

---

## 2. La buena noticia: no hay desorden

Sentiste que había caos porque hubo cinco conversaciones distintas. Pero **todas escribieron en el
mismo cuaderno**, así que el orden ya existe: es la fecha de cada trabajo guardado.

Nada está duplicado. Nada se perdió. Nada está en conflicto.

---

## 3. El orden real — qué se hizo y cuándo

Siete días de trabajo efectivo en siete semanas:

| Fecha | Trabajos | Qué se construyó |
|---|---|---|
| **25 jul** | 13 | Los tres módulos compuestos: **IVA mensual**, **Renta anual**, **Honorarios**. Más el **monitor de cumplimiento** y el endurecimiento de seguridad en Windows. |
| **26 jul** | 5 | Postura de escritura para la IA (que no pueda emitir documentos sola), caché local, y cuatro defectos encontrados validando contra el SII real. |
| **6 ago** | 17 | **El día más productivo.** Boletas de terceros, Declaraciones Juradas, Notificaciones, Carpeta Tributaria, **Giros/deuda**, **Situación tributaria**, Acuse de DTE, informe bancario, perfil, y descarga de PDF. (ADR-029 a ADR-042.) |
| **10 ago** | 21 | **Cambio de rumbo:** empieza el `auditor` — un proceso nocturno automático que audita solo, con trazabilidad y una compuerta de regresión. |
| **11 ago** | 4 | Correcciones del auditor. |
| **12 ago** | 5 | El auditor aprende a leer el F29 y el RCV por su cuenta. |
| **19 ago** | 8 | **Auditoría real de Empresa B** + cinco defectos que esa auditoría destapó + la semántica de cadenas de exportación. |

### Dónde encaja cada conversación tuya

| Tu conversación | Corresponde a |
|---|---|
| *Composite IVA Renta módulos* | 25 de julio (los tres módulos compuestos) |
| *Composite IVA Renta continuación* | 26 de julio |
| *Chrome login auth to SII* | El login con navegador — atraviesa varias fechas |
| *Spike 4/5: Notificaciones y Carpeta* | 6 de agosto |
| *Auditoría contable Empresa B* | 19 de agosto |
| *General coding session* | Probablemente el bloque del auditor (10–12 agosto) |
| *Auditoría Agrícola Fina SpA* | Otro cliente — puede que no haya tocado este proyecto |

---

## 4. ⚠️ El riesgo que encontré, y es el punto importante de este documento

**El libro oficial se actualizó por última vez el 3 de julio.**

```
main (versión oficial, también en GitHub):  3 de julio de 2026
tu cuaderno de trabajo:                     19 de agosto de 2026
```

Esto significa que **las siete semanas de trabajo — los 73 trabajos guardados — existen en un solo
lugar: este computador.** No están en GitHub. No están respaldados en ninguna parte.

Si este disco falla, se pierde todo lo hecho desde el 25 de julio.

### Por qué no se ha subido

Encontré dos cosas que lo impiden, y **una de ellas es una decisión deliberada tuya o de alguien
del equipo**:

1. **La subida a GitHub está desactivada a propósito.** La configuración fue reemplazada por un
   texto que dice literalmente `DISABLED-see-conversation-2026-08-10` — o sea, alguien la desactivó
   el 10 de agosto y dejó anotado que el motivo está en una conversación de ese día.
   **No la reactivé** porque no sé por qué se desactivó, y podría ser algo vigente e importante.

2. **La herramienta de GitHub no tiene sesión iniciada** (`gh auth login` sin ejecutar).

---

## 5. Qué hacer ahora, en este orden

### Primero — recuperar el motivo (5 minutos)

Busca tu conversación del **10 de agosto** y mira por qué se desactivó la subida. Puede haber sido
por algo serio (una credencial que se coló, una revisión pendiente) o por algo que ya se resolvió.

**No sigas al paso 2 sin esto.**

### Segundo — respaldar, aunque sea provisionalmente

Si el motivo ya no aplica, hay que subir el trabajo. Si todavía aplica, **igual hay que respaldar**
por otra vía — una copia del proyecto completo en un disco externo o en la nube. Siete semanas de
trabajo en un solo disco es un riesgo que no depende de git.

### Tercero — cerrar el cuaderno

Recién ahí tiene sentido el Pull Request: pasar los 73 trabajos del cuaderno al libro oficial.

### Cuarto — una regla para adelante

**Una conversación = un tema, y al terminar se sube.** El desorden que sentiste no vino de las
conversaciones; vino de que nunca se cerró el ciclo. Siete semanas acumuladas sin pasar al libro
oficial es lo que hace que todo se sienta disperso.

---

## 6. Nota sobre el estado actual del árbol

Mientras preparaba este documento, el proyecto **cambió solo dos veces en segundos** (aparecieron y
desaparecieron archivos preparados, y el último trabajo guardado cambió). Eso significa que **hay
otra sesión de Claude trabajando en este mismo proyecto ahora mismo**.

Antes de tocar nada, conviene cerrar las otras sesiones para que no se pisen entre ellas.
