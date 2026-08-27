// The recording composition root (ADR-043 §I1).
//
// This is the function that turns any existing `@dostertags/sii-core` task into an
// evidence-backed one. It needs nothing else from this package — no golden set, no rules, no
// normativa, no loop. That is deliberate: provenance is the layer that pays off first, and it pays
// off alone.
//
//     const { runtime, artifacts } = createRecordingRuntime({ storeRoot, taxpayer, runId });
//     const f22 = await f22Formulario(runtime, { anio });
//     // …every raw SII response behind that call is now in `artifacts`, with a manifest.
//
// WHY A DECORATOR AND NOT A CHANGE TO THE FACADES: `packages/core`'s 14 facades return curated
// projections and discard the raw body inside `requestJson`/`requestForm`/`requestText`. Wrapping
// the `PortalDriver` seam captures all six transports at once, needs no change to any facade, and
// cannot drift out of sync with them the way a per-facade `provenance` argument would.

import { createNodeRuntime } from '@dostertags/sii-core/node';
import type { Clock, Runtime } from '@dostertags/sii-core';
import type { ArtifactStore } from '../store/artifacts.js';
import { createFileArtifactStore } from '../store/file-artifacts.js';
import { recordingDriver } from './recording-driver.js';
import type { FetchManifest } from './manifest.js';

export interface RecordingRuntimeOptions {
  /**
   * Absolute store root, OUTSIDE the repository. Validate with `resolveStoreRoot` first.
   * Optional only when `artifacts` is supplied — the store it would have built is then unused.
   */
  readonly storeRoot?: string;
  /** Pseudonymous subject (`confidential.ts`). NEVER a RUT — the manifest may travel. */
  readonly taxpayer: string;
  /** Correlates every artifact of one pass. Defaults to a clock-derived id. */
  readonly runId?: string;
  /**
   * Runtime to decorate. Defaults to `createNodeRuntime()` — the real Playwright driver, real
   * keyring-free file stores, real clock. Pass a fake here in tests.
   */
  readonly base?: Runtime;
  /** Override the artifact store (tests pass `memoryArtifactStore()`). */
  readonly artifacts?: ArtifactStore;
  /** Called as each artifact lands — the ingest stage uses it to build its stage summary. */
  readonly onRecorded?: (manifest: FetchManifest) => void;
}

export interface RecordingRuntime {
  /** Hand this to any `@dostertags/sii-core` task. */
  readonly runtime: Runtime;
  /** The store the raw responses landed in. */
  readonly artifacts: ArtifactStore;
  readonly runId: string;
}

/** Timestamped, sortable, filename-safe. Shared with the loop so ids look alike everywhere. */
export function deriveRunId(clock: Clock): string {
  return `run-${clock.now().toISOString().replace(/[:.]/g, '-')}`;
}

export function createRecordingRuntime(options: RecordingRuntimeOptions): RecordingRuntime {
  const base = options.base ?? createNodeRuntime();
  if (options.artifacts === undefined && options.storeRoot === undefined) {
    throw new TypeError(
      'createRecordingRuntime needs a storeRoot or an artifacts store — without one there is ' +
        'nowhere to record, and a recorder that silently keeps nothing is worse than none',
    );
  }
  const artifacts =
    options.artifacts ?? createFileArtifactStore({ root: options.storeRoot as string });
  const runId = options.runId ?? deriveRunId(base.clock);

  const runtime: Runtime = {
    ...base,
    portal: recordingDriver(base.portal, {
      artifacts,
      clock: base.clock,
      taxpayer: options.taxpayer,
      runId,
      ...(options.onRecorded ? { onRecorded: options.onRecorded } : {}),
    }),
  };

  return { runtime, artifacts, runId };
}
