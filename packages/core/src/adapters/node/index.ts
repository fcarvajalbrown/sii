// Node default adapters used by createNodeRuntime(). No SII network here — the
// Playwright PortalDriver lands with the auth increment (ADR-008).
import { promises as fsp, appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { hardenDir } from './acl.js';
import type { AuditEntry, AuditSink, Clock, KeyValueStore } from '../../seams/index.js';

export const SII_DIR = join(homedir(), '.sii');

/** `hardenDir` spawns a process on Windows, and the store sits on the hot path of every task —
 *  so harden ONCE per process, on first directory creation, not on every write (ADR-025). */
const hardened = new Set<string>();
function ensureHardened(dir: string): void {
  if (hardened.has(dir)) return;
  hardened.add(dir);
  hardenDir(dir);
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/** fs-backed JSON store: ~/.sii/<key>.json, atomic write.
 *
 *  Permissions: `0o700`/`0o600` are POSIX-only — on **Windows those modes are a no-op** (Node
 *  maps `mode` to the read-only attribute; NTFS ACLs are inherited). There the directory is
 *  restricted explicitly via `hardenDir` (ADR-025). Do not read the mode arguments below as a
 *  cross-platform guarantee — they are not one. */
export class FileKeyValueStore implements KeyValueStore {
  constructor(private readonly baseDir: string = SII_DIR) {}
  private pathFor(key: string): string {
    return join(this.baseDir, `${key}.json`);
  }
  async read<T>(key: string): Promise<T | null> {
    let raw: string;
    try {
      raw = await fsp.readFile(this.pathFor(key), 'utf8');
    } catch (err) {
      // A genuinely absent file is the normal "not authenticated / no baseline" path.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      // Anything else (permissions, I/O, a directory in the way) is a real fault. Still degrade
      // to null so a read never throws, but say so — silently reporting a disk problem as "no
      // session" sends the user to re-login forever and hides the cause (code review F-09).
      process.stderr.write(
        `sii: no se pudo leer ${this.pathFor(key)}: ${(err as Error).message}\n`,
      );
      return null;
    }
    try {
      return JSON.parse(raw) as T;
    } catch {
      // Corrupt/truncated JSON is likewise diagnosable, not just "absent".
      process.stderr.write(
        `sii: ${this.pathFor(key)} está corrupto (JSON inválido); se ignorará. ` +
          'Ejecuta `sii auth login` para regenerarlo.\n',
      );
      return null;
    }
  }
  async write<T>(key: string, value: T): Promise<void> {
    await fsp.mkdir(this.baseDir, { recursive: true, mode: 0o700 });
    ensureHardened(this.baseDir); // no-op off Windows (ADR-025)
    const target = this.pathFor(key);
    const tmp = `${target}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
    await fsp.rename(tmp, target);
  }
  async delete(key: string): Promise<void> {
    try {
      await fsp.unlink(this.pathFor(key));
    } catch {
      // already gone
    }
  }
}

/** Append-only JSONL receipt: ~/.sii/audit.jsonl. Best-effort, never throws.
 *  Same permission caveat as the store: the modes below are POSIX-only; Windows is handled by
 *  `hardenDir` (ADR-025). */
export class FileAuditSink implements AuditSink {
  constructor(private readonly path: string = join(SII_DIR, 'audit.jsonl')) {}
  record(entry: AuditEntry): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      ensureHardened(dirname(this.path)); // no-op off Windows (ADR-025)
      appendFileSync(this.path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    } catch {
      // a receipt is never a gatekeeper — failures degrade silently (ADR-004)
    }
  }
}
