// Subject configuration — which taxpayers a sweep covers (W5's blocker).
//
// ── WHY THE RUTs LIVE IN A FILE AND NOT IN ARGV ───────────────────────────────────────────────
//
// A RUT is INSIDE the confidentiality boundary (`confidential.ts`). A `--taxpayer 11111111-1` flag
// puts it in the process list, where any other user on the machine can read it with `ps` — and it
// lands in shell history too. The same reasoning ADR-006 applies to the Clave applies here in
// weaker form: a value that must not travel should not be passed where the OS publishes it.
//
// So subjects come from `<store>/subjects.json`, which sits in the directory that ALREADY holds
// raw SII responses including counterparty identity, and inherits ADR-025's ACL hardening. Nothing
// new is exposed; the RUT is stored where its neighbours already are.
//
// ── WHY THE SALT IS WRITE-ONCE ────────────────────────────────────────────────────────────────
//
// `taxpayerKey` = H(salt : rut). Regenerating the salt re-keys every subject, so the golden set
// stops matching live sweeps, artifacts orphan from the taxpayer they belong to, and NOTHING
// ERRORS — the store simply looks like a different installation's. `loadSalt` therefore creates
// only when absent and never overwrites, and refuses a stored salt too short or malformed to be a
// safe pseudonym rather than deriving brute-forceable keys from it.

import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { Rut } from '@dostertags/sii-core';
import type { KeyValueStore } from '@dostertags/sii-core';
import { ConfidentialityError } from './errors.js';
import { SALT_BYTES, SALT_STORE_KEY, taxpayerKey } from './confidential.js';
import type { TaxpayerKey } from './confidential.js';
import { readFileOrNull } from './store/fs-util.js';

/** Filename under the store root. Never in the repository. */
export const SUBJECTS_FILE = 'subjects.json';

/**
 * The installation salt: read it, or mint it once.
 *
 * WRITE-ONCE BY CONSTRUCTION. There is deliberately no rotate/regenerate path here — rotating
 * would be a data migration (re-key every artifact, every entity, the golden set), not a config
 * change, and offering it as a one-liner would invite the silent orphaning described above.
 */
export async function loadSalt(store: KeyValueStore): Promise<string> {
  const existing = await store.read<string>(SALT_STORE_KEY);

  if (existing !== null) {
    assertUsableSalt(existing);
    return existing;
  }

  const minted = randomBytes(SALT_BYTES).toString('hex');
  await store.write(SALT_STORE_KEY, minted);
  return minted;
}

function assertUsableSalt(salt: string): void {
  if (!/^[0-9a-f]+$/i.test(salt)) {
    throw new ConfidentialityError(
      `the stored installation salt is not hex — refusing to derive taxpayer keys from it. ` +
        'If it was hand-edited, restore the original: a different salt re-keys every subject and ' +
        'nothing will error, it will just stop matching.',
    );
  }
  if (salt.length < SALT_BYTES * 2) {
    throw new ConfidentialityError(
      `the stored installation salt is too short (${String(salt.length)} hex chars, need ` +
        `${String(SALT_BYTES * 2)}) — a truncated salt makes the pseudonym brute-forceable, since ` +
        'the RUT space is small enough to enumerate',
    );
  }
}

/** One configured subject. `alias` is for the operator's eyes only and never leaves this module. */
interface SubjectEntry {
  readonly rut: string;
  readonly alias?: string;
}

/**
 * Read `<root>/subjects.json` and return the pseudonymous keys to sweep.
 *
 * RETURNS KEYS ONLY. The RUT and any alias stay inside this function — everything downstream (the
 * loop config, the manifest, the artifact store) is keyed by `TaxpayerKey`, so a RUT has no path
 * out of here.
 *
 * The RUT is CANONICALISED before hashing: `11.111.111-1` and `11111111-1` are one taxpayer, and
 * two keys would split one subject's artifacts across two identities and silently halve every
 * history built from them. Mod-11 is validated here too, before anything reaches SII (CONVENTIONS).
 */
export async function loadSubjects(root: string, salt: string): Promise<readonly TaxpayerKey[]> {
  const raw = await readFileOrNull(join(root, SUBJECTS_FILE));
  // A fresh install has no subjects. That is a real "nobody configured yet" — the sweep reports
  // idle rather than failing, which is the honest reading.
  if (raw === null) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch (err) {
    throw new ConfidentialityError(
      `${SUBJECTS_FILE} is not valid JSON (${(err as Error).message}) — refusing to guess which ` +
        'subjects were meant',
    );
  }

  const entries = (parsed as { subjects?: unknown } | null)?.subjects;
  if (!Array.isArray(entries)) {
    throw new ConfidentialityError(
      `${SUBJECTS_FILE} must be {"subjects": [{"rut": "11111111-1"}, …]} — got a shape this ` +
        'cannot read, and sweeping the wrong set is worse than sweeping none',
    );
  }

  const keys = new Set<TaxpayerKey>();
  for (const entry of entries as readonly SubjectEntry[]) {
    // `Rut.parse` validates Mod-11 and throws a ValidationError naming the bad value. Let it
    // propagate: a malformed RUT means the operator meant a subject nobody can identify, and
    // skipping it would sweep a set quietly smaller than the one they configured.
    keys.add(taxpayerKey(Rut.parse(entry.rut).canonical, salt));
  }

  // Sorted so the sweep order is deterministic (stage 1 sorts too, but a caller may not).
  return [...keys].sort();
}
