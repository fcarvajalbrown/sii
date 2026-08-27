#!/usr/bin/env node
// @dostertags/sii-mcp entry point. Wires the Node runtime into the server and serves over
// stdio. STDOUT is the JSON-RPC channel — diagnostics go to STDERR only.
import { createNodeRuntime } from '@dostertags/sii-core/node';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildServer } from './server.js';

/** Write tools are OPT-IN via the MCP client's `env` block — operator-owned configuration, not
 *  model-reachable input (ADR-026). Unset/anything-but-"1" leaves `bte_emit` unregistered. */
const allowWrites = process.env['SII_MCP_ALLOW_WRITES'] === '1';

async function main(): Promise<void> {
  const server = buildServer(createNodeRuntime(), { allowWrites });
  if (allowWrites) {
    process.stderr.write(
      'sii-mcp: SII_MCP_ALLOW_WRITES=1 — la tool bte_emit (EMITE documentos con valor legal) ' +
        'está habilitada. Revisa ADR-026 antes de usarla con un modelo.\n',
    );
  }
  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
