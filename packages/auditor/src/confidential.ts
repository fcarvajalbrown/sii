// The confidentiality boundary (ADR-043 §I5) — a function, not a convention.
//
// THE RULE: client tax data is confidential. No client identifier reaches logs, prompts sent to
// external APIs, or the shared knowledge base.
//
// THE SHAPE OF THE BOUNDARY, stated once so it is not re-derived per module:
//
//   INSIDE (may hold a real RUT / razón social)   OUTSIDE (TaxpayerKey only)
//   ─────────────────────────────────────────    ──────────────────────────────────────
//   store/artifacts   — raw SII responses         kb/*            — normativa + behavior map
//   store/normalized  — the entity model          eval/results    — metrics per run
//   ~/.sii/*          — session, cache, monitor    loop/manifest  — the nightly run record
//                                                  any external prompt / API payload
//
// Inside is the user's own machine holding the user's own (and their represented empresas') data:
// that is the tool's purpose and ADR-004's ToS posture. Outside is anything shared, published,
// diffed across engagements, or sent to a third party — and it is keyed pseudonymously.
//
// WHY A SALT AND NOT A PLAIN HASH: the RUT space is small and enumerable (a Chilean RUT is ~8
// digits plus a Mod-11 check digit that `core`'s `rut` module can verify). An unsalted SHA-256 of
// a RUT is reversible by brute force in seconds, so it is not a pseudonym — it is the RUT wearing
// a hat. The salt is generated once per installation, lives beside the other local state, and is
// NEVER committed.

import { createHash } from 'node:crypto';
import { ConfidentialityError } from './errors.js';

/**
 * A stable pseudonymous handle for one taxpayer. Same RUT + same installation salt ⇒ same key
 * (so engagements accumulate and trends are queryable), but the key does not identify anyone
 * without the salt.
 */
export type TaxpayerKey = string & { readonly __brand: 'TaxpayerKey' };

/** `KeyValueStore` key holding the installation salt. Distinct from every `core` key (ADR-007). */
export const SALT_STORE_KEY = 'auditor-salt';

/** Bytes of entropy in the installation salt. 32 is the width of the digest it feeds. */
export const SALT_BYTES = 32;

/**
 * Derive the pseudonymous key for a RUT.
 *
 * @param rutCanonical Canonical RUT WITHOUT formatting, e.g. `11111111-1`. Canonicalise with
 *                     `core`'s `Rut` first — two spellings of one RUT must not yield two keys.
 * @param salt         Hex installation salt, from `loadSalt`.
 */
export function taxpayerKey(rutCanonical: string, salt: string): TaxpayerKey {
  if (salt.length < SALT_BYTES * 2) {
    throw new ConfidentialityError(
      `installation salt is too short (${salt.length} hex chars, need ${SALT_BYTES * 2}) — ` +
        'refusing to derive a brute-forceable pseudonym',
    );
  }
  const digest = createHash('sha256').update(`${salt}:${rutCanonical}`, 'utf8').digest('hex');
  return digest.slice(0, 32) as TaxpayerKey;
}

/**
 * Patterns that must never appear in anything crossing to the OUTSIDE column above.
 *
 * This is a BACKSTOP, not the mechanism. The mechanism is that outside-bound types carry a
 * `TaxpayerKey` and have no field to put a RUT in. This catches the case the type system cannot:
 * an identifier smuggled inside a free-text string (an SII glosa, an error message, a rule note).
 * ADR-024 hit exactly this — it kept observación glosas out of the snapshot because they embed
 * functionary names and taxpayer detail.
 */
const IDENTIFIER_PATTERNS: readonly { readonly name: string; readonly re: RegExp }[] = [
  // RUT with or without separators (synthetic examples): 11111111-1 / 11.111.111-1 / 11111111K
  { name: 'rut', re: /\b\d{1,2}\.?\d{3}\.?\d{3}\s*-\s*[\dkK]\b/ },
  // Chilean corporate suffixes are a reliable razón-social tell in otherwise anonymous text.
  { name: 'razon-social', re: /\b(?:SPA|S\.A\.|S\.p\.A\.|LTDA|LIMITADA|E\.I\.R\.L\.)\b/i },
  { name: 'email', re: /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/ },
];

export interface Leak {
  readonly pattern: string;
  readonly at: string;
  readonly excerpt: string;
}

/**
 * Scan a JSON-serialisable value for identifiers. Returns every hit — the caller decides whether
 * to throw (outbound payload) or record a finding (an ingested artifact, where a RUT is expected).
 *
 * Deterministic: keys are walked in sorted order so two runs report leaks in the same order.
 */
export function scanForIdentifiers(value: unknown, path = '$'): readonly Leak[] {
  if (typeof value === 'string') {
    return IDENTIFIER_PATTERNS.flatMap(({ name, re }) => {
      const m = re.exec(value);
      return m ? [{ pattern: name, at: path, excerpt: redact(m[0]) }] : [];
    });
  }
  if (Array.isArray(value)) {
    return value.flatMap((v, i) => scanForIdentifiers(v, `${path}[${i}]`));
  }
  if (value !== null && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .flatMap((k) => scanForIdentifiers((value as Record<string, unknown>)[k], `${path}.${k}`));
  }
  return [];
}

/**
 * Throw if `value` carries an identifier. Call this at every outbound edge — writing to `kb/`,
 * persisting an `EvalResult` or a `RunManifest`, building an external prompt.
 *
 * The error message carries the PATH and a REDACTED excerpt, never the identifier itself: an
 * exception that prints the leak into a log defeats the check that raised it.
 */
export function assertNoIdentifiers(value: unknown, context: string): void {
  const leaks = scanForIdentifiers(value);
  if (leaks.length === 0) return;
  const where = leaks.map((l) => `${l.at} (${l.pattern}: ${l.excerpt})`).join(', ');
  throw new ConfidentialityError(
    `${context}: refusing to emit — ${leaks.length} client identifier(s) found at ${where}`,
  );
}

/** First and last character kept; the middle replaced. Enough to debug, not enough to identify. */
function redact(s: string): string {
  return s.length <= 2
    ? '••'
    : `${s[0] ?? ''}${'•'.repeat(Math.min(s.length - 2, 8))}${s.at(-1) ?? ''}`;
}
