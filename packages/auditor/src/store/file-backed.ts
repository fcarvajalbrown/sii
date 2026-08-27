// The file-backed store root (ADR-043) — config, path resolution, and the two factories.
//
// Layout under the root:
//
//   <root>/artifacts/<aa>/<bb>/<sha256>     raw bytes, immutable          → file-artifacts.ts
//   <root>/manifests/<runId>.jsonl          one FetchManifest per line    → file-artifacts.ts
//   <root>/entities/<kind>.jsonl            one entity per line           → file-normalized.ts
//   <root>/extractions/<runId>.jsonl        ExtractionRecords             → written by stage 2
//
// THE ROOT MUST BE OUTSIDE THE REPOSITORY. It holds raw SII responses — the INSIDE of the
// confidentiality boundary (`confidential.ts`), including the counterparty identity ADR-028
// deliberately removed from the surfaces. `resolveStoreRoot` refuses a path inside the working
// tree rather than trusting the operator to notice.

import { isAbsolute, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { ConfidentialityError } from '../errors.js';

export interface StoreConfig {
  /** Absolute path to the store root. MUST be outside the repository (ADR-043 §I5). */
  readonly root: string;
}

/** Env var naming the store root. */
export const STORE_ROOT_ENV = 'SII_AUDITOR_STORE';

/** Default when the env var is unset: beside the project's other local state (ADR-025 hardens it). */
export const DEFAULT_STORE_ROOT = join(homedir(), '.sii', 'auditor');

/**
 * Resolve and validate the store root.
 *
 * @param fromEnv  Raw env value, or `undefined` to take the default.
 * @param repoRoot Working tree to keep the store out of. Pass `process.cwd()` in production.
 */
export function resolveStoreRoot(fromEnv: string | undefined, repoRoot: string): string {
  const root = resolve(
    fromEnv === undefined || fromEnv.trim() === '' ? DEFAULT_STORE_ROOT : fromEnv,
  );

  if (!isAbsolute(root)) {
    throw new ConfidentialityError(`${STORE_ROOT_ENV} must be an absolute path, got ${root}`);
  }

  const rel = relative(resolve(repoRoot), root);
  const insideRepo = rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  if (insideRepo) {
    throw new ConfidentialityError(
      `refusing a store root inside the working tree (${root}) — it holds raw SII responses ` +
        `including counterparty identity; set ${STORE_ROOT_ENV} to a path outside the repository`,
    );
  }
  return root;
}

export { createFileArtifactStore } from './file-artifacts.js';
export { createFileNormalizedStore, storedKinds } from './file-normalized.js';
export type { FileNormalizedStore } from './file-normalized.js';
