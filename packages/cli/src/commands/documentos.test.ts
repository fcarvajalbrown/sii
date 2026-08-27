import { describe, it, expect, afterEach } from 'vitest';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HOSTS, NotAuthenticatedError, testing, type Runtime } from '@dostertags/sii-core';
import { datos, run, runJson } from '../test-helpers.js';

describe('sii carta pdf command (fake runtime, no SII)', () => {
  const PDF_BYTES = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x01, 0x02, 0x03]);
  const outPath = join(tmpdir(), `sii-carta-test-${Date.now()}.pdf`);

  afterEach(async () => {
    await rm(outPath, { force: true });
  });

  const makeRuntime = (): Runtime => ({
    clock: new testing.FixedClock(new Date('2026-08-06T12:00:00Z')),
    audit: new testing.RecordingAuditSink(),
    store: new testing.InMemoryKeyValueStore(),
    portal: new testing.FakePortalDriver({
      loginSession: { landingUrl: HOSTS.miSii, evaluate: datos, storageState: { cookies: [] } },
      restoreSession: {
        landingUrl: HOSTS.miSii,
        evaluate: datos,
        requestBinary: () => ({ status: 200, body: PDF_BYTES, contentType: 'application/pdf' }),
      },
    }),
  });

  it('carta pdf writes the bytes to --out and confirms in human mode', async () => {
    const rt = makeRuntime();
    await run(rt, 'auth', 'login');
    const out = await run(rt, 'carta', 'pdf', '000483', '--out', outPath);
    expect(out).toContain('000483');
    expect(out).toContain(outPath);
    const written = await readFile(outPath);
    expect(Buffer.compare(written, PDF_BYTES)).toBe(0);
  });

  it('JSON default: reports codCarta, bytes and ruta — never the PDF content', async () => {
    const rt = makeRuntime();
    await run(rt, 'auth', 'login');
    const json = (await runJson(rt, 'carta', 'pdf', '000483', '--out', outPath)) as {
      codCarta: string;
      bytes: number;
      ruta: string;
    };
    expect(json).toMatchObject({ codCarta: '000483', bytes: PDF_BYTES.length, ruta: outPath });
  });

  it('carta pdf requires a session (NotAuthenticated)', async () => {
    await expect(run(makeRuntime(), 'carta', 'pdf', '000483', '--out', outPath)).rejects.toBeInstanceOf(
      NotAuthenticatedError,
    );
  });
});
