import { describe, it, expect } from 'vitest';
import { HOSTS, LOGIN_HOST, loginUrl, reachedLoginDestination } from './config.js';

describe('config', () => {
  it('exposes the prod hosts', () => {
    expect(HOSTS.miSii).toContain('misiir.sii.cl');
    expect(LOGIN_HOST).toBe('zeusr.sii.cl');
  });

  it('builds the login URL with an unkeyed destination query', () => {
    expect(loginUrl(HOSTS.miSii)).toBe(
      'https://zeusr.sii.cl/AUT2000/InicioAutenticacion/IngresoRutClave.html?https://misiir.sii.cl/cgi_misii/siihome.cgi',
    );
  });

  it('completes a login only on the destination host, not on the Clave Única detour', () => {
    expect(reachedLoginDestination(new URL(HOSTS.miSii), HOSTS.miSii)).toBe(true);
    expect(
      reachedLoginDestination(new URL('https://misiir.sii.cl/cgi_misii/other.cgi'), HOSTS.miSii),
    ).toBe(true);
    expect(reachedLoginDestination(new URL(HOSTS.claveUnica), HOSTS.miSii)).toBe(false);
    expect(reachedLoginDestination(new URL(`${HOSTS.login}${HOSTS.loginPath}`), HOSTS.miSii)).toBe(
      false,
    );
  });
});
