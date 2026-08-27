// PDF de cartas/notificaciones SII (ADR-042). Full contract: docs/sii-contract/documentos.md.
//
// The FIRST facade to use PortalSession.requestBinary (ADR-042) — every other facade in this
// codebase decodes its response body to text; a PDF must survive as raw bytes. `codCarta` is
// already exposed by `f22 historial` (buscaEventos, since 2026-06-29) and is the same key SII's
// own UI links to for this download.
import { HOSTS } from '../config/index.js';
import { DocumentoError, NotAuthenticatedError, RateLimitError } from '../errors/index.js';
import type { PortalSession } from '../seams/index.js';

export interface CartaPdf {
  readonly codCarta: string;
  readonly bytes: Buffer;
  readonly contentType: string | null;
}

/** Download the PDF of a carta/notificación by its `codCarta`. Validates the observed
 *  `content-type` (`application/pdf`) before returning — never hands back bytes SII didn't
 *  actually label as a PDF (same "fail loud on the unexpected" posture as `nonJsonResponseError`,
 *  ADR-014). A `NotAuthenticatedError`/`SessionExpiredError` from the seam propagates unchanged. */
export async function fetchCartaPdf(
  session: PortalSession,
  params: { codCarta: string },
): Promise<CartaPdf> {
  const { codCarta } = params;
  const url = `${HOSTS.cartaPdf}?codCarta=${encodeURIComponent(codCarta)}`;
  let response;
  try {
    response = await session.requestBinary(url);
  } catch (e) {
    // Session death and a server-side block are both actionable — never rewrapped (ADR-004).
    if (e instanceof NotAuthenticatedError || e instanceof RateLimitError) throw e;
    throw new DocumentoError(
      `No se pudo descargar el PDF de la carta ${codCarta} (fallo de red o CGI).`,
    );
  }
  if (response.status !== 200) {
    throw new DocumentoError(
      `El SII respondió HTTP ${response.status} al descargar el PDF de la carta ${codCarta}.`,
    );
  }
  const contentType = response.contentType?.toLowerCase() ?? '';
  if (!contentType.includes('application/pdf')) {
    throw new DocumentoError(
      `La respuesta para la carta ${codCarta} no es un PDF (content-type: ` +
        `${response.contentType ?? 'ausente'}). El SII pudo haber devuelto una página de error.`,
    );
  }
  return { codCarta, bytes: response.body, contentType: response.contentType };
}
