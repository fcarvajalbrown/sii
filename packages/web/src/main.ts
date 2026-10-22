#!/usr/bin/env node
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createNodeRuntime } from '@dostertags/sii-core/node';
import type { Source } from './api.js';
import { createDemoSource, loadDemoTaxpayer } from './demo.js';
import { createLiveSource } from './live.js';
import { createWebServer } from './server.js';

const HOST = '127.0.0.1';
const DEFAULT_PORT = 5180;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      demo: { type: 'boolean', default: false },
      port: { type: 'string', default: String(DEFAULT_PORT) },
    },
  });
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid --port: ${values.port}`);
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const source: Source = values.demo
    ? createDemoSource(await loadDemoTaxpayer(resolve(here, '../demo/taxpayer.json')))
    : createLiveSource(createNodeRuntime());
  const server = createWebServer({ source, clientDir: resolve(here, 'client') });
  server.listen(port, HOST, () => {
    const mode = values.demo ? 'demo (synthetic data)' : 'live';
    process.stdout.write(`sii-web ${mode} on http://${HOST}:${port}\n`);
  });
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
