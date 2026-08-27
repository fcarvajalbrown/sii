// Filesystem primitives shared by the two file-backed stores (ADR-043).
//
// THREE DECISIONS ENCODED HERE, each with a failure mode behind it:
//
//  1. JSONL, not one big JSON blob. An append costs O(added) instead of O(total), and a crash
//     mid-write loses the tail line rather than the file. `readJsonl` distinguishes the two cases:
//     an unparseable FINAL line in a file with no trailing newline is a torn append and is dropped;
//     an unparseable line anywhere else is real corruption and THROWS. Silently skipping bad lines
//     would turn a corrupt store into a store that quietly reports fewer rows — the exact class of
//     failure this package exists to prevent.
//
//  2. Atomic replace via temp+rename for whole-file rewrites. `rename` is atomic on both NTFS and
//     POSIX, so a reader never observes a half-written file.
//
//  3. Windows ACL hardening on directory creation, reusing `core`'s tested builder (ADR-025).
//     POSIX `mode` bits are a NO-OP on Windows, and this store holds RAW SII responses — including
//     the counterparty identity that ADR-028 deliberately took off the surfaces. Do not read the
//     `mode` arguments below as a cross-platform guarantee; they are not one.
//
// CONCURRENCY: single-writer. The nightly loop is one process and ADR-005 keeps one live session at
// a time, so no locking is implemented. Two concurrent writers would interleave appends; that is a
// documented limit, not an oversight.

import { promises as fsp } from 'node:fs';
import { dirname, join } from 'node:path';
import { hardenDir } from '@dostertags/sii-core/node';
import { stableStringify } from '../json.js';
import { IntegrityError } from '../errors.js';

/** `hardenDir` spawns a process on Windows, so harden ONCE per directory per process (ADR-025). */
const hardened = new Set<string>();

export async function ensureDir(dir: string): Promise<void> {
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  if (!hardened.has(dir)) {
    hardened.add(dir);
    hardenDir(dir); // no-op off Windows
  }
}

/** Write-and-replace. The temp file sits beside the target so the rename never crosses devices. */
export async function atomicWrite(target: string, data: string | Buffer): Promise<void> {
  await ensureDir(dirname(target));
  const tmp = `${target}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, data, { mode: 0o600 });
  await fsp.rename(tmp, target);
}

/** Read a whole file, or `null` when absent. Any other error propagates — an I/O fault is not
 *  "no data", and conflating them is how a disk problem gets reported as a clean sweep. */
export async function readFileOrNull(path: string): Promise<Buffer | null> {
  try {
    return await fsp.readFile(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** Append rows as ONE write, so a single upsert call lands together or (torn) not at all. */
export async function appendJsonl(path: string, rows: readonly unknown[]): Promise<void> {
  if (rows.length === 0) return;
  await ensureDir(dirname(path));
  const payload = rows.map((r) => `${stableStringify(r)}\n`).join('');
  await fsp.appendFile(path, payload, { mode: 0o600 });
}

/**
 * Parse a JSONL file. Missing file ⇒ `[]` (a legitimate empty collection).
 *
 * A torn trailing line — no trailing newline AND unparseable — is dropped as a recoverable partial
 * append. Anything else that fails to parse raises `IntegrityError` naming the line number.
 */
export async function readJsonl<T>(path: string): Promise<readonly T[]> {
  const buf = await readFileOrNull(path);
  if (buf === null) return [];

  const raw = buf.toString('utf8');
  if (raw.length === 0) return [];
  const endsClean = raw.endsWith('\n');
  const lines = raw.split('\n');
  // A trailing newline yields a final empty element; drop it so `lastIndex` means what it says.
  if (endsClean) lines.pop();

  const out: T[] = [];
  const lastIndex = lines.length - 1;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined || line.trim() === '') continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      if (i === lastIndex && !endsClean) break; // torn append — recoverable, drop it
      throw new IntegrityError(
        `${path}: line ${i + 1} is not valid JSON, and it is not a torn final append — ` +
          'the file is corrupt and is NOT being silently truncated',
      );
    }
  }
  return out;
}

/** Rewrite a JSONL file atomically. Used by compaction and retraction, never by an append. */
export async function writeJsonl(path: string, rows: readonly unknown[]): Promise<void> {
  await atomicWrite(path, rows.map((r) => `${stableStringify(r)}\n`).join(''));
}

/** Entries of `dir`, or `[]` when it does not exist. Sorted, for deterministic traversal. */
export async function listDir(dir: string): Promise<readonly string[]> {
  try {
    return (await fsp.readdir(dir)).sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

/** Two-level fan-out path for a content hash: `<root>/ab/cd/<full hash>`. Keeps NTFS directories
 *  small enough to stay fast when an engagement accumulates tens of thousands of artifacts. */
export function shardedPath(root: string, hash: string): string {
  return join(root, hash.slice(0, 2), hash.slice(2, 4), hash);
}
