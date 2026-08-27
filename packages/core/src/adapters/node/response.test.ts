import { describe, it, expect } from 'vitest';
import { charsetOf, formLoginWallError, nonJsonResponseError } from './response.js';
import { RateLimitError, SessionExpiredError } from '../../errors/index.js';

describe('nonJsonResponseError (SDI non-JSON classification)', () => {
  it('a response bounced to the login host → SessionExpiredError (actionable)', () => {
    const e = nonJsonResponseError('https://zeusr.sii.cl/AUT2000/login.html', 'text/html', 200);
    expect(e).toBeInstanceOf(SessionExpiredError);
    expect(e.message).toContain('sii auth login');
  });

  it('an HTML body on the same SDI host (same-host login wall) → SessionExpiredError', () => {
    const e = nonJsonResponseError(
      'https://www4.sii.cl/consdcvinternetui/x',
      'text/html; charset=UTF-8',
      200,
    );
    expect(e).toBeInstanceOf(SessionExpiredError);
  });

  // `RateLimitError` was defined and mapped to CLI exit code 4, but NOTHING ever threw it, so
  // the documented exit-code contract was unreachable (code review F-06). A throttled request
  // must be distinguishable from any other failure — the rule is "surface it and stop", and a
  // caller scripting against exit codes needs to tell the two apart.
  it('HTTP 429 → RateLimitError, never a generic failure', () => {
    const e = nonJsonResponseError('https://www4.sii.cl/consdcvinternetui/x', 'text/html', 429);
    expect(e).toBeInstanceOf(RateLimitError);
    // Rate limiting wins over the HTML-body heuristic: a 429 is not an expired session.
    expect(e).not.toBeInstanceOf(SessionExpiredError);
  });

  it('HTTP 503 → RateLimitError (SII sheds load under the same never-retry rule)', () => {
    const e = nonJsonResponseError('https://www4.sii.cl/x', 'text/plain', 503);
    expect(e).toBeInstanceOf(RateLimitError);
  });

  it('a 429 bounced to the login host is still a rate limit, not an expiry', () => {
    const e = nonJsonResponseError('https://zeusr.sii.cl/AUT2000/login.html', 'text/html', 429);
    expect(e).toBeInstanceOf(RateLimitError);
  });

  it('a non-HTML unexpected response on an SDI host → generic Error with status + content-type', () => {
    const e = nonJsonResponseError('https://www4.sii.cl/consdcvinternetui/x', 'text/plain', 502);
    expect(e).not.toBeInstanceOf(SessionExpiredError);
    expect(e.message).toContain('502');
    expect(e.message).toContain('text/plain');
  });

  it('an empty content-type still produces a readable generic message', () => {
    const e = nonJsonResponseError('https://www4.sii.cl/x', '', 500);
    expect(e).not.toBeInstanceOf(SessionExpiredError);
    expect(e.message).toContain('sin content-type');
  });
});

describe('formLoginWallError (authenticated form-POST login-wall, ADR-017)', () => {
  it('a form POST bounced to the login host → SessionExpiredError (actionable)', () => {
    const e = formLoginWallError('https://zeusr.sii.cl/AUT2000/login.html');
    expect(e).toBeInstanceOf(SessionExpiredError);
    expect(e?.message).toContain('sii auth login');
  });

  it('an HTML response on the emit host (loa.sii.cl) is NOT a wall (HTML is expected) → null', () => {
    // Unlike requestJson, an HTML body from the TMBECN_* CGIs is the normal case.
    expect(
      formLoginWallError('https://loa.sii.cl/cgi_IMT/TMBECN_BoletaHonorariosElectronica.cgi'),
    ).toBeNull();
  });
});

describe('charsetOf (public-response charset for decoding)', () => {
  it('reads the declared charset (the palena DTE report is ISO-8859-1)', () => {
    expect(charsetOf('text/html; charset=ISO-8859-1')).toBe('ISO-8859-1');
  });

  it('is case/space/quote tolerant', () => {
    expect(charsetOf('text/html;  CHARSET="utf-8"')).toBe('utf-8');
  });

  it('defaults to utf-8 when no charset is declared', () => {
    expect(charsetOf('text/html')).toBe('utf-8');
    expect(charsetOf(null)).toBe('utf-8');
    expect(charsetOf(undefined)).toBe('utf-8');
  });

  it('falls back to utf-8 for a label TextDecoder cannot accept', () => {
    expect(charsetOf('text/html; charset=not-a-real-charset')).toBe('utf-8');
  });
});
