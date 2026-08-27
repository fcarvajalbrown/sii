import { describe, it, expect } from 'vitest';
import { FakePortalSession } from '../../adapters/fake/index.js';
import { Rut } from '../../rut/index.js';
import { Anio } from '../../periodo/index.js';
import { F22Error, RateLimitError, SessionExpiredError } from '../../errors/index.js';
import { fetchF22Declaraciones, pickVigenteFolio } from './index.js';

// Synthetic data only (no real PII, no SII): operating 77.777.777-7, año 2025.
const RUT = Rut.parse('77777777-7');
const ANIO = Anio.parse('2025');

const session = (requestJson: (url: string, options?: unknown) => unknown): FakePortalSession =>
  new FakePortalSession({ requestJson, cookies: { TOKEN: 'conv' } });

const reqBody = (s: FakePortalSession): Record<string, unknown> =>
  (s.lastRequest?.options?.body as { data: Record<string, unknown> }).data;

describe('F22 declaraciones facade (fake session, synthetic envelopes, no SII)', () => {
  it('buscaDeclVgte: parses decls + resolves estado via glosas; sends año + split RUT', async () => {
    const s = session(() => ({
      metaData: { errors: [] },
      data: {
        decls: [
          {
            folio: '12345',
            vgte: 'S',
            codConc: 'C1',
            fecIng: '15/04/2025',
            nombres: 'PII NAME', // identity PII — must NOT surface
            cta: '00012345', // bank PII — must NOT surface
          },
        ],
        glosas: [{ codConclusion: 'C1', descripcion: 'Declaración vigente — aceptada' }],
      },
    }));

    const res = await fetchF22Declaraciones(s, { rut: RUT, anio: ANIO });

    expect(res).toMatchObject({ rut: '77777777-7', anio: '2025', tieneDeclaracion: true });
    expect(res.declaraciones[0]).toEqual({
      folio: '12345',
      vigente: true,
      estado: 'Declaración vigente — aceptada',
      fecha: '15/04/2025',
      tipoImpugnado: null,
    });
    // No `raw` → the decl's identity/bank PII never rides along.
    expect(JSON.stringify(res)).not.toContain('PII NAME');
    expect(JSON.stringify(res)).not.toContain('00012345');
    // Body: periodo = año tributario (YYYY), split RUT.
    expect(reqBody(s)).toMatchObject({ periodo: '2025', rut: '77777777', dv: '7' });
  });

  it('buscaDeclVgte: no decls is a legitimate "sin declaración", not an error', async () => {
    const s = session(() => ({ metaData: {}, data: { decls: null } }));
    const res = await fetchF22Declaraciones(s, { rut: RUT, anio: ANIO });
    expect(res.tieneDeclaracion).toBe(false);
    expect(res.declaraciones).toEqual([]);
  });

  it('metaData.errors (list of {descripcion}) is surfaced verbatim as F22Error', async () => {
    const s = session(() => ({
      metaData: { errors: [{ id: 9, descripcion: 'RUT no autorizado para el año' }] },
      data: null,
    }));
    await expect(fetchF22Declaraciones(s, { rut: RUT, anio: ANIO })).rejects.toThrow(
      'RUT no autorizado para el año',
    );
    await expect(fetchF22Declaraciones(s, { rut: RUT, anio: ANIO })).rejects.toBeInstanceOf(
      F22Error,
    );
  });

  it('pickVigenteFolio prefers the vigente declaración, else the first with a folio', () => {
    expect(
      pickVigenteFolio([
        { folio: '1', vigente: false, estado: null, fecha: null, tipoImpugnado: null },
        { folio: '2', vigente: true, estado: null, fecha: null, tipoImpugnado: null },
      ]),
    ).toBe('2');
    expect(
      pickVigenteFolio([
        { folio: '1', vigente: false, estado: null, fecha: null, tipoImpugnado: null },
      ]),
    ).toBe('1');
    expect(pickVigenteFolio([])).toBeNull();
  });

  it('a space-padded folio is "absent" (null) and never picked to fan out — observed live: an AT2024 decl carried a blank folio and SII\'s own backend threw on it', async () => {
    const s = session(() => ({
      metaData: { errors: [] },
      data: {
        decls: [
          { folio: '               ', vgte: 'S', codConc: 'C1', fecIng: '10/05/2025' },
          { folio: '999', vgte: 'N', codConc: 'C1', fecIng: '11/05/2025' },
        ],
        glosas: [{ codConclusion: 'C1', descripcion: 'Vigente' }],
      },
    }));
    const res = await fetchF22Declaraciones(s, { rut: RUT, anio: ANIO });
    expect(res.declaraciones[0]?.folio).toBeNull();
    // The blank "vigente" folio must not win the pick — the real folio does.
    expect(pickVigenteFolio(res.declaraciones)).toBe('999');
  });

  it('a server-side block (RateLimitError) propagates verbatim — NOT rewrapped as "no es JSON"', async () => {
    const blocked = session(() => {
      throw new RateLimitError('SII bloqueó temporalmente las consultas (HTTP 429). NO reintentes.');
    });
    await expect(fetchF22Declaraciones(blocked, { rut: RUT, anio: ANIO })).rejects.toBeInstanceOf(
      RateLimitError,
    );
  });

  it('an expired session (SessionExpiredError) propagates; a generic non-JSON → F22Error', async () => {
    const expired = session(() => {
      throw new SessionExpiredError('La sesión expiró. Ejecuta `sii auth login`.');
    });
    await expect(fetchF22Declaraciones(expired, { rut: RUT, anio: ANIO })).rejects.toBeInstanceOf(
      SessionExpiredError,
    );
    const broken = session(() => {
      throw new Error('socket hang up');
    });
    await expect(fetchF22Declaraciones(broken, { rut: RUT, anio: ANIO })).rejects.toBeInstanceOf(
      F22Error,
    );
  });
});
