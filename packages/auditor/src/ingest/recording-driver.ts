// `RecordingPortalDriver` — the decorator that makes provenance structural (ADR-043 §I1).
//
// THE PROBLEM IT SOLVES: `packages/core`'s facades return CURATED projections. The raw response
// body is decoded inside `requestJson`/`requestForm`/`requestText` and discarded. So a figure in a
// report cannot be traced to evidence, because the evidence was never kept. Re-fetching later is
// not the same thing — SII's answer may have changed, which is precisely what an audit needs to
// know.
//
// THE SHAPE OF THE FIX: wrap the `PortalDriver` seam, and have its sessions tee every raw response
// into the artifact store BEFORE handing it to the facade. Installed at the composition root:
//
//     const runtime = createNodeRuntime({ portal: recordingDriver(realDriver, ctx) });
//
// which is exactly the override ADR-016 opened up. Consequences worth stating:
//
//   * ZERO changes to `packages/core`. The 14 facades never learn they are being recorded, so this
//     cannot drift out of sync with them the way a per-facade `provenance` argument would. (The
//     wrappers below are CONTEXTUALLY TYPED off `PortalDriver`/`PortalSession` rather than
//     importing `JsonRequest`/`FormRequest`/… — the core barrel does not export those option
//     types, and widening its public API just to decorate it would break the "zero changes" claim
//     for no benefit.)
//   * ALL six transports covered at once, including ones added later — a new facade is recorded on
//     the day it is written, with no extra work and no way to forget.
//   * `goto` is recorded as a URL-only artifact (empty body). The DOM-reading facades (giros,
//     ADR-034; bte, ADR-020) get their real evidence from `evaluate`, whose RESULT is recorded —
//     the rendered DOM itself is not reconstructible from here, and pretending otherwise would be
//     a false citation. Declared, not hidden.
//
// RISK, stated in ADR-043 §Consequences: raw bodies include what curation removes. An RCV response
// carries `raw` with counterparty identity — the exposure ADR-028 took OFF the surface. The
// artifact store inherits ADR-025's hardening and lives outside the repo, but this is a larger
// on-disk footprint than the project had yesterday.

import type { Clock, PortalDriver, PortalSession } from '@dostertags/sii-core';
import type { ArtifactStore } from '../store/artifacts.js';
import type { FetchManifest, Transport } from './manifest.js';
import { instant } from '../provenance.js';
import { createHash } from 'node:crypto';
import { stableStringify } from '../json.js';

export interface RecordingContext {
  readonly artifacts: ArtifactStore;
  /** Time comes from the seam, never `Date.now()` — determinism (ADR-043 §I5). */
  readonly clock: Clock;
  /** Pseudonymous subject of this ingest pass (`confidential.ts`). */
  readonly taxpayer: string;
  readonly runId: string;
  /** Called after each artifact lands. The ingest stage uses it to build its stage summary. */
  readonly onRecorded?: (manifest: FetchManifest) => void;
  /**
   * Called when RECORDING fails (the read itself still succeeds — see `record`). Defaults to one
   * line on stderr.
   *
   * This exists because the swallow-everything version hid a real misconfiguration during
   * development: a clock that returned `undefined` made every capture fail silently, and the store
   * simply looked empty. `packages/core` learned the same lesson in its own review (F-09) — a
   * degraded path must still SAY it degraded, or a disk problem is indistinguishable from "there
   * was nothing to record".
   */
  readonly onError?: (error: unknown, url: string) => void;
}

/** Wrap a driver so every session it produces records what it fetches. */
export function recordingDriver(inner: PortalDriver, ctx: RecordingContext): PortalDriver {
  const wrap = async (p: Promise<PortalSession>): Promise<PortalSession> =>
    recordingSession(await p, ctx);

  const driver: PortalDriver = {
    interactiveLogin: (options) => wrap(inner.interactiveLogin(options)),
    credentialLogin: (options) => wrap(inner.credentialLogin(options)),
    restore: (storageState) => wrap(inner.restore(storageState)),
    requestPublic: async (url, options) => {
      const started = ctx.clock.now();
      const res = await inner.requestPublic(url, options);
      await record(ctx, {
        url,
        transport: 'requestPublic',
        status: res.status,
        body: Buffer.from(res.body, 'utf8'),
        contentType: null,
        started,
        request: { method: options?.method ?? 'GET', form: options?.form },
      });
      return res;
    },
  };
  return driver;
}

/** Wrap one live session. Every primitive tees; `cookie`/`storageState`/`close` pass through. */
export function recordingSession(inner: PortalSession, ctx: RecordingContext): PortalSession {
  const session: PortalSession = {
    goto: async (url) => {
      const started = ctx.clock.now();
      const landed = await inner.goto(url);
      // Body-less on purpose: the rendered DOM is not captured here (see the header note).
      await record(ctx, {
        url: landed,
        transport: 'goto',
        status: 200,
        body: Buffer.alloc(0),
        contentType: null,
        started,
      });
      return landed;
    },

    // Explicitly generic: contextual typing cannot carry `<T>` through an object-literal member,
    // and erasing it to `unknown` would force every DOM-reading facade to re-assert its own type.
    evaluate: async <T>(expression: string): Promise<T> => {
      const started = ctx.clock.now();
      const result = await inner.evaluate<T>(expression);
      // The EXPRESSION is the locator and the RESULT is the evidence — that is the honest citation
      // for a DOM / inline-JS-map facade (ADR-034 giros, ADR-020 bte).
      await record(ctx, {
        url: `evaluate:${fingerprint(expression)}`,
        transport: 'goto',
        status: 200,
        body: Buffer.from(stableStringify(result ?? null), 'utf8'),
        contentType: 'application/json',
        started,
        request: { expression },
      });
      return result;
    },

    requestJson: async (url, options) => {
      const started = ctx.clock.now();
      const parsed = await inner.requestJson(url, options);
      // The seam hands back PARSED JSON, so re-serialising is the only body available. Stable-key
      // serialisation keeps the content hash deterministic across runs (ADR-043 §I5).
      await record(ctx, {
        url,
        transport: 'requestJson',
        status: 200,
        body: Buffer.from(stableStringify(parsed), 'utf8'),
        contentType: 'application/json',
        started,
        // `metaData.conversationId`/`transactionId` are per-session noise — including them would
        // make every fingerprint unique and attribute nothing. Only `data` identifies the call.
        request: { method: options?.method ?? 'POST', body: sdiDataOf(options?.body) },
      });
      return parsed;
    },

    requestForm: async (url, options) => {
      const started = ctx.clock.now();
      const res = await inner.requestForm(url, options);
      await record(ctx, {
        url,
        transport: 'requestForm',
        status: res.status,
        body: Buffer.from(res.body, 'utf8'),
        contentType: null,
        started,
        request: { method: options?.method ?? 'POST', form: options?.form },
      });
      return res;
    },

    requestText: async (url, options) => {
      const started = ctx.clock.now();
      const res = await inner.requestText(url, options);
      await record(ctx, {
        url,
        transport: 'requestText',
        status: res.status,
        body: Buffer.from(res.body, 'utf8'),
        contentType: null,
        started,
        request: { method: options?.method ?? 'POST', body: options?.body },
      });
      return res;
    },

    requestBinary: async (url, options) => {
      const started = ctx.clock.now();
      const res = await inner.requestBinary(url, options);
      await record(ctx, {
        url,
        transport: 'requestBinary',
        status: res.status,
        body: res.body,
        contentType: res.contentType,
        started,
        request: { method: options?.method ?? 'GET' },
      });
      return res;
    },

    cookie: (url, name) => inner.cookie(url, name),
    storageState: () => inner.storageState(),
    close: () => inner.close(),
  };
  return session;
}

interface Recordable {
  readonly url: string;
  readonly transport: Transport;
  readonly status: number;
  readonly body: Buffer;
  readonly contentType: string | null;
  readonly started: Date;
  /** The REQUEST that produced this response — method + body/form. Hashed, never stored raw. */
  readonly request?: unknown;
}

/**
 * SHA-256 over the request, key-order-stable. Attributes an artifact to the call that made it
 * WITHOUT storing the RUT the body carries (see `FetchManifest.requestFingerprint`).
 */
function fingerprintRequest(request: unknown): string | null {
  if (request === undefined) return null;
  return createHash('sha256').update(stableStringify(request), 'utf8').digest('hex');
}

/**
 * Persist one artifact + manifest.
 *
 * NEVER throws into the caller. A recording failure must not break a read that otherwise
 * succeeded — same posture as `core`'s audit sink ("the log is a receipt, never a gatekeeper",
 * ADR-004). The loss IS surfaced downstream rather than hidden: the artifact is simply absent, so
 * anything derived from that response has no provenance and is rejected instead of silently
 * trusted.
 */
async function record(ctx: RecordingContext, r: Recordable): Promise<void> {
  try {
    const now = ctx.clock.now();
    const hash = await ctx.artifacts.put(r.body);
    const manifest: FetchManifest = {
      contentHash: hash,
      url: r.url,
      transport: r.transport,
      httpStatus: r.status,
      retrievedAt: instant(r.started.toISOString()),
      contentType: r.contentType,
      byteLength: r.body.byteLength,
      durationMs: now.getTime() - r.started.getTime(),
      requestFingerprint: fingerprintRequest(r.request),
      taxpayer: ctx.taxpayer,
      runId: ctx.runId,
    };
    await ctx.artifacts.putManifest(manifest);
    ctx.onRecorded?.(manifest);
  } catch (err) {
    // Never rethrown — see the docstring. Do NOT add a retry: ADR-004 forbids retrying against
    // SII, and this failure is local anyway. But it IS reported: a silent swallow makes a broken
    // recorder look like an idle one.
    const report =
      ctx.onError ??
      ((error: unknown, url: string): void => {
        process.stderr.write(
          `sii-auditor: no se pudo registrar el artefacto de ${url}: ${String(error)}\n`,
        );
      });
    try {
      report(err, r.url);
    } catch {
      // A reporter that itself throws must not take down the read either.
    }
  }
}

/**
 * The SDI `data` block of a JSON request, dropping the per-session `metaData`. Anything else is
 * passed through unchanged.
 */
function sdiDataOf(body: unknown): unknown {
  if (body !== null && typeof body === 'object' && 'data' in body) {
    return (body as { data: unknown }).data;
  }
  return body;
}

/** Short, stable tag for an `evaluate` expression so the pseudo-URL stays readable in a manifest. */
function fingerprint(expression: string): string {
  let h = 0;
  for (let i = 0; i < expression.length; i += 1) {
    h = (Math.imul(31, h) + expression.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
