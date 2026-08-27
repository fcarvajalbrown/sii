// Composition subpath `@dostertags/sii-core/node` (ADR-016): the Node default
// adapters plus the composition root. Kept OFF the main barrel so importing the
// library's tasks/primitives never evaluates node:* or playwright — a consumer
// that injects its own seams (ADR-003) stays free of them entirely.
import { FileAuditSink, FileKeyValueStore, SystemClock } from './adapters/node/index.js';
import { PlaywrightPortalDriver } from './adapters/node/portal.js';
import type { Runtime } from './seams/index.js';

export { FileAuditSink, FileKeyValueStore, SII_DIR, SystemClock } from './adapters/node/index.js';
export { PlaywrightPortalDriver } from './adapters/node/portal.js';
// ADR-025's Windows hardening, exported for internal tooling that creates its OWN local-state
// directory outside `~/.sii` (the auditor's artifact store, ADR-043 — which holds RAW SII
// responses, so strictly more sensitive than the session jar this was written for). Re-exported
// rather than reimplemented: one tested ACL builder, not two that can drift.
export { hardenDir, hardenDirCommand } from './adapters/node/acl.js';

// `withSession`/`readSession` are deliberately OFF the main barrel (ADR-003: surfaces call TASKS
// only, never the raw session primitive — CLI/MCP never reach past the task layer). Kept on THIS
// composition subpath instead, for internal tooling that is explicitly not a CLI/MCP surface
// (e.g. `tools/crawler`, ADR-040) and legitimately needs a live `PortalSession` without a
// bespoke restore. Pure logic (no node:*/playwright import), so re-exporting it here costs
// nothing extra for a consumer that never touches this subpath.
export { withSession, readSession, writeSession } from './auth/index.js';
export type { SessionContext, StoredSession } from './auth/index.js';

/** Composition root: the Node default adapters, any seam replaceable (ADR-016).
 *  e.g. `createNodeRuntime({ audit: myAuditSink })` keeps the other three defaults.
 *  The default portal is the Playwright driver — its `playwright` OPTIONAL peer is
 *  loaded lazily on first use, so composing (or overriding `portal`) never needs it. */
export function createNodeRuntime(overrides: Partial<Runtime> = {}): Runtime {
  return {
    clock: new SystemClock(),
    audit: new FileAuditSink(),
    store: new FileKeyValueStore(),
    portal: new PlaywrightPortalDriver(),
    ...overrides,
  };
}
