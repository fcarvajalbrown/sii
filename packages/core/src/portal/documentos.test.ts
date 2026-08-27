import { describe, it, expect } from 'vitest';
import { FakePortalSession } from '../adapters/fake/index.js';
import { DocumentoError, SessionExpiredError } from '../errors/index.js';
import { fetchCartaPdf } from './documentos.js';

describe('documentos facade — fetchCartaPdf (fake session, no SII)', () => {
  it('downloads the PDF bytes for a codCarta and never text-decodes them', async () => {
    // A byte sequence that is NOT valid UTF-8 text (would corrupt through TextDecoder) —
    // proves the facade carries the buffer through untouched (ADR-042).
    const pdfBytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0xff, 0xfe, 0x00, 0x01]);
    const session = new FakePortalSession({
      requestBinary: () => ({ status: 200, body: pdfBytes, contentType: 'application/pdf' }),
    });

    const res = await fetchCartaPdf(session, { codCarta: '000483' });

    expect(res.codCarta).toBe('000483');
    expect(Buffer.compare(res.bytes, pdfBytes)).toBe(0);
    expect(res.bytes.length).toBe(pdfBytes.length);
  });

  it('sends the codCarta as a query param on the MuestraPdf URL', async () => {
    const session = new FakePortalSession({
      requestBinary: () => ({
        status: 200,
        body: Buffer.from('x'),
        contentType: 'application/pdf',
      }),
    });

    await fetchCartaPdf(session, { codCarta: '000400' });

    expect(session.lastBinaryRequest?.url).toContain('codCarta=000400');
    expect(session.lastBinaryRequest?.url).toContain('MuestraPdf');
  });

  it('an unexpected content-type (not a PDF) raises DocumentoError — never assumes the bytes are a PDF', async () => {
    const session = new FakePortalSession({
      requestBinary: () => ({
        status: 200,
        body: Buffer.from('<html>not a pdf</html>'),
        contentType: 'text/html; charset=UTF-8',
      }),
    });

    await expect(fetchCartaPdf(session, { codCarta: '000483' })).rejects.toBeInstanceOf(DocumentoError);
  });

  it('a non-200 status raises DocumentoError', async () => {
    const session = new FakePortalSession({
      requestBinary: () => ({ status: 404, body: Buffer.alloc(0), contentType: null }),
    });

    await expect(fetchCartaPdf(session, { codCarta: '999999' })).rejects.toBeInstanceOf(DocumentoError);
  });

  it('a dead session (bounced to the login host) raises SessionExpiredError', async () => {
    // FakePortalSession has no explicit login-wall simulation for requestBinary beyond the
    // script itself — the facade must surface whatever the seam throws, unchanged.
    const session = new FakePortalSession({
      requestBinary: () => {
        throw new SessionExpiredError('La sesión expiró. Ejecuta `sii auth login`.');
      },
    });

    await expect(fetchCartaPdf(session, { codCarta: '000483' })).rejects.toBeInstanceOf(SessionExpiredError);
  });
});
