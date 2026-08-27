import { describe, it, expect } from 'vitest';
import {
  FakePortalDriver,
  FixedClock,
  InMemoryKeyValueStore,
  RecordingAuditSink,
} from '../adapters/fake/index.js';
import type { BinaryRequest, Runtime } from '../seams/index.js';
import { NotAuthenticatedError } from '../errors/index.js';
import { initOperateState, setOperatingRut } from '../identity/index.js';
import { writeSession } from '../auth/index.js';
import { descargarCartaPdf } from './documentos.js';

const SELF = '11111111-1';
const EMPRESA = '77777777-7';
const PDF_BYTES = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x01, 0x02]);

function makeRuntime(): Runtime {
  const requestBinary = (_url: string, _options?: BinaryRequest) => ({
    status: 200,
    body: PDF_BYTES,
    contentType: 'application/pdf',
  });
  return {
    clock: new FixedClock(new Date('2026-08-06T12:00:00Z')),
    audit: new RecordingAuditSink(),
    store: new InMemoryKeyValueStore(),
    portal: new FakePortalDriver({ restoreSession: { requestBinary, cookies: { TOKEN: 't' } } }),
  };
}

async function seed(runtime: Runtime): Promise<void> {
  await writeSession(runtime.store, { rut: SELF, cookies: ['c'], savedAt: '2026-08-06T12:00:00Z' });
  await initOperateState(runtime.store, {
    selfRut: SELF,
    accountType: 'persona',
    operable: [
      { rut: SELF, razonSocial: 'Juan Pérez', isSelf: true },
      { rut: EMPRESA, razonSocial: 'Mi Empresa SpA', isSelf: false },
    ],
  });
}

const entries = (rt: Runtime) => (rt.audit as RecordingAuditSink).entries;
const driverOf = (rt: Runtime) => rt.portal as FakePortalDriver;

describe('descargarCartaPdf (fakes, no SII)', () => {
  it('downloads the PDF and returns its bytes + size', async () => {
    const rt = makeRuntime();
    await seed(rt);

    const res = await descargarCartaPdf(rt, { codCarta: '000483' });

    expect(res.codCarta).toBe('000483');
    expect(Buffer.compare(res.bytes, PDF_BYTES)).toBe(0);
  });

  it('rejects a representing operate pointer BEFORE opening a session (ADR-005)', async () => {
    const rt = makeRuntime();
    await seed(rt);
    await setOperatingRut(rt.store, EMPRESA);

    await expect(descargarCartaPdf(rt, { codCarta: '000483' })).rejects.toThrow(/session-keyed/i);
    expect(driverOf(rt).restoreCalls).toBe(0);
  });

  it('audits codCarta + byte size, never the PDF content', async () => {
    const rt = makeRuntime();
    await seed(rt);

    await descargarCartaPdf(rt, { codCarta: '000483' });

    const a = entries(rt).at(-1)!;
    expect(a).toMatchObject({
      action: 'descargar_carta_pdf',
      result: 'ok',
      rut: SELF,
      codCarta: '000483',
      bytes: PDF_BYTES.length,
    });
    expect(JSON.stringify(a)).not.toContain(PDF_BYTES.toString('base64'));
  });

  it('raises NotAuthenticated with no session, and audits the failure', async () => {
    const rt: Runtime = {
      clock: new FixedClock(new Date('2026-08-06T12:00:00Z')),
      audit: new RecordingAuditSink(),
      store: new InMemoryKeyValueStore(),
      portal: new FakePortalDriver({}),
    };

    await expect(descargarCartaPdf(rt, { codCarta: '000483' })).rejects.toThrow(NotAuthenticatedError);
    expect(entries(rt).at(-1)).toMatchObject({ action: 'descargar_carta_pdf', result: 'failed' });
  });
});
