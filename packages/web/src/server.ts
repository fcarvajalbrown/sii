import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { NotAuthenticatedError } from '@dostertags/sii-core';
import type { Source } from './api.js';

export const CSRF_HEADER = 'x-sii-web';

const ALLOWED_HOSTNAMES = new Set(['127.0.0.1', 'localhost']);

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

type Route = (source: Source) => Promise<unknown>;

const ROUTES: Record<string, Route> = {
  'GET /api/session': (s) => s.session(),
  'POST /api/login': (s) => s.login(),
  'GET /api/overview': (s) => s.overview(),
  'POST /api/audit': (s) => s.audit(),
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

function hostAllowed(req: IncomingMessage): boolean {
  const host = req.headers.host ?? '';
  const hostname = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0];
  return ALLOWED_HOSTNAMES.has(hostname ?? '');
}

async function serveStatic(clientDir: string, pathname: string, res: ServerResponse): Promise<void> {
  const root = resolve(clientDir);
  const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).slice(1);
  const target = resolve(join(root, normalize(relative)));
  if (target !== root && !target.startsWith(root + sep)) {
    res.writeHead(404).end();
    return;
  }
  try {
    const body = await readFile(target);
    res.writeHead(200, {
      'content-type': CONTENT_TYPES[extname(target)] ?? 'application/octet-stream',
    });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
}

export function createWebServer(options: { source: Source; clientDir: string }): Server {
  return createServer((req, res) => {
    void handle(options, req, res);
  });
}

async function handle(
  { source, clientDir }: { source: Source; clientDir: string },
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!hostAllowed(req)) {
    res.writeHead(421).end();
    return;
  }
  const method = req.method ?? 'GET';
  const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
  if (!pathname.startsWith('/api/')) {
    if (method !== 'GET') {
      res.writeHead(405).end();
      return;
    }
    await serveStatic(clientDir, pathname, res);
    return;
  }
  const route = ROUTES[`${method} ${pathname}`];
  if (!route) {
    sendJson(res, 404, { error: 'Ruta no encontrada.' });
    return;
  }
  if (method === 'POST' && req.headers[CSRF_HEADER] !== '1') {
    sendJson(res, 403, { error: 'Solicitud rechazada.' });
    return;
  }
  try {
    sendJson(res, 200, await route(source));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendJson(res, error instanceof NotAuthenticatedError ? 401 : 500, { error: message });
  }
}
