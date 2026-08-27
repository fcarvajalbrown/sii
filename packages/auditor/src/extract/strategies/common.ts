// Plumbing shared by the concrete strategies (ADR-043).
//
// Every strategy builds the same provenance from its context and wraps its output the same way.
// Factoring it here keeps each parser about PARSING, and — more importantly — means a change to how
// provenance is stamped happens in exactly one place rather than drifting between parsers.

import { contentHash, instant } from '../../provenance.js';
import type { ArtifactProvenance } from '../../provenance.js';
import { scoreConfidence } from '../confidence.js';
import type { ConfidenceSignal, ExtractionFailure, ExtractionRecord } from '../record.js';
import type { ExtractionContext } from '../strategy.js';

/** `<id>@<version>` — the ref stamped onto every record and failure. */
export const refOf = (id: string, version: number): string => `${id}@${version}`;

export function artifactProvenance(
  ctx: ExtractionContext,
  strategyRef: string,
  locator: string,
): ArtifactProvenance {
  return {
    kind: 'artifact',
    artifact: contentHash(ctx.manifest.contentHash),
    url: ctx.manifest.url,
    retrievedAt: instant(ctx.manifest.retrievedAt),
    strategy: strategyRef,
    locator,
  };
}

export function recordOf<T>(
  ctx: ExtractionContext,
  strategyRef: string,
  provenance: ArtifactProvenance,
  signals: readonly ConfidenceSignal[],
  value: T,
  suffix: string,
): ExtractionRecord<T> {
  return {
    id: `${ctx.manifest.contentHash}:${suffix}`,
    strategy: strategyRef,
    provenance,
    value,
    confidence: scoreConfidence(signals),
    signals,
    extractedAt: instant(ctx.now),
    taxpayer: ctx.taxpayer,
    runId: ctx.runId,
  };
}

export function failureOf(
  ctx: ExtractionContext,
  strategyRef: string,
  provenance: ArtifactProvenance,
  message: string,
): ExtractionFailure {
  return {
    strategy: strategyRef,
    provenance,
    message,
    failedAt: instant(ctx.now),
    taxpayer: ctx.taxpayer,
    runId: ctx.runId,
  };
}

export const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** Integer only. A fractional peso figure is rejected rather than rounded — see ADR-043 §I3. */
export function asInteger(v: unknown): number | null {
  if (typeof v === 'number') return Number.isInteger(v) ? v : null;
  if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) return Number(v.trim());
  return null;
}

/**
 * A monto in SII's es-CL form: dots are THOUSAND separators (`3.352.068` → `3352068`), never a
 * decimal point. Chilean tax amounts are whole pesos.
 *
 * `undefined`/`null`/empty is a real absence and raises nothing. A present-but-unparseable value
 * raises `unparseable_value` — the difference between "SII sent nothing" and "SII sent something we
 * do not understand" is exactly what the confidence score is for.
 */
export function asMonto(v: unknown, field: string, signals: ConfidenceSignal[]): number | null {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'number') return Number.isInteger(v) ? v : null;
  if (typeof v === 'string') {
    const cleaned = v
      .replace(/\./g, '')
      .replace(/&nbsp;/g, '')
      .trim();
    if (/^-?\d+$/.test(cleaned)) return Number(cleaned);
  }
  signals.push({
    code: 'unparseable_value',
    field,
    detail: `monto no reconocido: ${JSON.stringify(v)}`,
  });
  return null;
}
