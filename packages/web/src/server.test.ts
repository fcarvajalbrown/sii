import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { request } from 'node:http';
import type { Server } from 'node:http';
import { NotAuthenticatedError } from '@dostertags/sii-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Source } from './api.js';
import { createDemoSource, loadDemoTaxpayer } from './demo.js';
import { CSRF_HEADER, createWebServer } from './server.js';

const fixturePath = resolve(dirname(fileURLToPath(import.meta.url)), '../demo/taxpayer.json');

async function listen(source: Source, clientDir: string): Promise<{ server: Server; base: string }> {
  const server = createWebServer({ source, clientDir });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  return { server, base: `http://127.0.0.1:${port}` };
}

const post = (url: string): Promise<Response> =>
  fetch(url, { method: 'POST', headers: { [CSRF_HEADER]: '1' } });

describe('web server in demo mode', () => {
  let server: Server;
  let base: string;
  let clientDir: string;

  beforeAll(async () => {
    clientDir = await mkdtemp(join(tmpdir(), 'sii-web-'));
    await writeFile(join(clientDir, 'index.html'), '<!doctype html><title>t</title>');
    ({ server, base } = await listen(createDemoSource(await loadDemoTaxpayer(fixturePath)), clientDir));
  });

  afterAll(async () => {
    await new Promise((done) => server.close(done));
    await rm(clientDir, { recursive: true, force: true });
  });

  it('starts logged out and marks the session synthetic', async () => {
    const body = await (await fetch(`${base}/api/session`)).json();
    expect(body).toEqual({ mode: 'demo', synthetic: true, authenticated: false, rut: null });
  });

  it('logs in without opening anything and exposes the synthetic RUT', async () => {
    const body = await (await post(`${base}/api/login`)).json();
    expect(body).toMatchObject({ authenticated: true, rut: '11111111-1', synthetic: true });
  });

  it('serves the overview and the audit marked synthetic', async () => {
    const overview = await (await fetch(`${base}/api/overview`)).json();
    expect(overview.synthetic).toBe(true);
    expect(overview.f29.meses).toHaveLength(12);
    const audit = await (await post(`${base}/api/audit`)).json();
    expect(audit.synthetic).toBe(true);
    expect(audit.findings).toHaveLength(5);
  });

  it('rejects a POST without the same-origin header', async () => {
    const res = await fetch(`${base}/api/audit`, { method: 'POST' });
    expect(res.status).toBe(403);
  });

  it('rejects a foreign Host header', async () => {
    const status = await new Promise<number | undefined>((done, fail) => {
      request(`${base}/api/session`, { headers: { host: 'evil.example' } }, (res) => {
        res.resume();
        done(res.statusCode);
      })
        .on('error', fail)
        .end();
    });
    expect(status).toBe(421);
  });

  it('serves index.html and refuses to leave the client directory', async () => {
    expect((await fetch(`${base}/`)).status).toBe(200);
    expect((await fetch(`${base}/..%2f..%2fpackage.json`)).status).toBe(404);
  });
});

describe('web server errors', () => {
  it('maps NotAuthenticatedError to 401 with the message verbatim', async () => {
    const failing: Source = {
      mode: 'live',
      session: () => Promise.reject(new NotAuthenticatedError('No hay sesión activa.')),
      login: () => Promise.reject(new Error('unused')),
      overview: () => Promise.reject(new NotAuthenticatedError('No hay sesión activa.')),
      audit: () => Promise.reject(new Error('unused')),
    };
    const { server, base } = await listen(failing, tmpdir());
    try {
      const res = await fetch(`${base}/api/overview`);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'No hay sesión activa.' });
    } finally {
      await new Promise((done) => server.close(done));
    }
  });
});
