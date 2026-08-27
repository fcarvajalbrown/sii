// End-to-end proof of the provenance chain (ADR-043 §I1): a `core` task runs unmodified against a
// FAKE portal driver, and every raw response it consumed lands in a real file-backed artifact
// store, citable and hash-verifiable afterwards.
//
// This is the test that matters most for the ingest layer. The unit tests below it check pieces;
// this one checks the claim.

import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { testing } from '@dostertags/sii-core';
import type { PortalDriver, Runtime } from '@dostertags/sii-core';
import { createFileArtifactStore } from '../store/file-artifacts.js';
import { memoryArtifactStore } from '../store/memory.js';
import { createRecordingRuntime, deriveRunId } from './runtime.js';
import { recordingDriver } from './recording-driver.js';
import { stableStringify } from '../json.js';
import type { FetchManifest } from './manifest.js';

let root: string;

beforeEach(async () => {
  root = await fsp.mkdtemp(join(tmpdir(), 'sii-auditor-ingest-'));
});

afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

/** An SDI-shaped envelope, the commonest wire shape in this project (ADR-011). */
const SDI_PAYLOAD = {
  respEstado: { codRespuesta: 0, glosaRespuesta: 'OK' },
  data: [{ folio: '123', montoNeto: 1000, montoTotal: 1190 }],
};

const CLOCK_AT = new Date('2026-08-06T03:00:00.000Z');

function fakeRuntime(driver: PortalDriver, clock = new testing.FixedClock(CLOCK_AT)): Runtime {
  return {
    clock,
    audit: new testing.RecordingAuditSink(),
    store: new testing.InMemoryKeyValueStore(),
    portal: driver,
  };
}

describe('the provenance chain, end to end', () => {
  it('captures a raw response into a real artifact store, hash-verifiable afterwards', async () => {
    const recorded: FetchManifest[] = [];
    const driver = new testing.FakePortalDriver({
      restoreSession: { requestJson: () => SDI_PAYLOAD },
    });

    const { runtime, artifacts, runId } = createRecordingRuntime({
      storeRoot: root,
      taxpayer: 'tk-aaa',
      base: fakeRuntime(driver),
      artifacts: createFileArtifactStore({ root }),
      onRecorded: (m) => recorded.push(m),
    });

    // Drive the seam the way a facade does — no facade is needed to prove the capture.
    const session = await runtime.portal.restore({});
    const body = await session.requestJson('https://www4.sii.cl/rcvInternet/getResumen', {
      method: 'POST',
      body: { periodo: '202403' },
    });
    await session.close();

    // 1. The task still got its data, unchanged. The decorator is transparent.
    expect(body).toEqual(SDI_PAYLOAD);

    // 2. Exactly one artifact was recorded, with a full manifest.
    expect(recorded).toHaveLength(1);
    const manifest = recorded[0] as FetchManifest;
    expect(manifest.url).toBe('https://www4.sii.cl/rcvInternet/getResumen');
    expect(manifest.transport).toBe('requestJson');
    expect(manifest.taxpayer).toBe('tk-aaa');
    expect(manifest.runId).toBe(runId);
    expect(manifest.retrievedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // 3. The bytes are retrievable and are the response.
    const bytes = await artifacts.get(manifest.contentHash);
    expect(bytes).not.toBeNull();
    expect(JSON.parse((bytes as Buffer).toString('utf8'))).toEqual(SDI_PAYLOAD);

    // 4. The citation is checkable: re-hash the bytes, compare to the key. This is what makes a
    //    figure in a report defensible a year later.
    expect(await artifacts.verify([manifest.contentHash])).toEqual([]);

    // 5. The manifest is queryable by the dimensions a report needs.
    const found = await artifacts.findManifests({ taxpayer: 'tk-aaa', urlContains: 'getResumen' });
    expect(found).toHaveLength(1);
    expect(found[0]?.contentHash).toBe(manifest.contentHash);
  });

  it('de-duplicates an unchanged response while recording BOTH fetches', async () => {
    // This is the "nothing changed" signal: one artifact, two manifests.
    const driver = new testing.FakePortalDriver({
      restoreSession: { requestJson: () => SDI_PAYLOAD },
    });
    const { runtime, artifacts } = createRecordingRuntime({
      storeRoot: root,
      taxpayer: 'tk-aaa',
      base: fakeRuntime(driver),
      artifacts: createFileArtifactStore({ root }),
    });

    for (let i = 0; i < 2; i += 1) {
      const s = await runtime.portal.restore({});
      await s.requestJson('https://www4.sii.cl/x', { body: {} });
      await s.close();
    }

    const manifests = await artifacts.findManifests({});
    expect(manifests).toHaveLength(2);
    expect(new Set(manifests.map((m) => m.contentHash)).size).toBe(1);
  });

  it('gives semantically equal payloads the same hash regardless of key order', async () => {
    // Without stable serialisation, SII reordering its JSON keys would read as "the data changed".
    const store = memoryArtifactStore();
    const a = await store.put(Buffer.from(stableStringify({ b: 2, a: 1 })));
    const b = await store.put(Buffer.from(stableStringify({ a: 1, b: 2 })));
    expect(a).toBe(b);
    expect(store.size).toBe(1);
  });
});

describe('recordingDriver transports', () => {
  const ctx = (artifacts = memoryArtifactStore()) => ({
    artifacts,
    clock: new testing.FixedClock(CLOCK_AT),
    taxpayer: 'tk-aaa',
    runId: 'run-1',
  });

  it('records requestForm (legacy HTML CGIs, ADR-017/032)', async () => {
    const artifacts = memoryArtifactStore();
    const inner = new testing.FakePortalDriver({
      restoreSession: { requestForm: () => '<html>boleta</html>' },
    });
    const session = await recordingDriver(inner, ctx(artifacts)).restore({});
    await session.requestForm('https://misiir.sii.cl/cgi_misii/CViewCarta.cgi', {
      form: { opc: '41' },
    });

    const [m] = await artifacts.findManifests({});
    expect(m?.transport).toBe('requestForm');
    expect((await artifacts.get(m!.contentHash))?.toString('utf8')).toBe('<html>boleta</html>');
  });

  it('records requestText (GWT-RPC, ADR-020)', async () => {
    const artifacts = memoryArtifactStore();
    const inner = new testing.FakePortalDriver({
      restoreSession: { requestText: () => '//OK[1,2,3]' },
    });
    const session = await recordingDriver(inner, ctx(artifacts)).restore({});
    await session.requestText('https://www3.sii.cl/sispadinternet/peticion', { body: '5|0|7|' });

    const [m] = await artifacts.findManifests({});
    expect(m?.transport).toBe('requestText');
  });

  it('records requestBinary WITHOUT text-decoding it (ADR-042)', async () => {
    const artifacts = memoryArtifactStore();
    const pdf = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x00, 0xff]);
    const inner = new testing.FakePortalDriver({
      restoreSession: { requestBinary: () => pdf },
    });
    const session = await recordingDriver(inner, ctx(artifacts)).restore({});
    await session.requestBinary('https://www3.sii.cl/Coreca1Internet/MuestraPdf?codCarta=1');

    const [m] = await artifacts.findManifests({});
    // A TextDecoder over these bytes corrupts them silently — the whole point of ADR-042.
    expect(await artifacts.get(m!.contentHash)).toEqual(pdf);
  });

  it('records requestPublic (login-free consultas, ADR-014)', async () => {
    const artifacts = memoryArtifactStore();
    const inner = new testing.FakePortalDriver({ requestPublic: () => 'AUTORIZADO' });
    await recordingDriver(inner, ctx(artifacts)).requestPublic(
      'https://palena.sii.cl/cvc_cgi/dte/ee_empresa_rut',
    );

    const [m] = await artifacts.findManifests({});
    expect(m?.transport).toBe('requestPublic');
  });

  it('records an evaluate RESULT — the honest citation for a DOM-reading facade (ADR-034)', async () => {
    const artifacts = memoryArtifactStore();
    const inner = new testing.FakePortalDriver({
      restoreSession: { evaluate: () => ({ filas: [{ Folio: '1', Saldo: '0' }] }) },
    });
    const session = await recordingDriver(inner, ctx(artifacts)).restore({});
    await session.evaluate('document.querySelectorAll("table")');

    const manifests = await artifacts.findManifests({});
    // `goto` is not called here, so the only artifact is the evaluate result.
    expect(manifests).toHaveLength(1);
    expect(manifests[0]?.url).toMatch(/^evaluate:[0-9a-f]{8}$/);
    expect(JSON.parse((await artifacts.get(manifests[0]!.contentHash))!.toString('utf8'))).toEqual({
      filas: [{ Folio: '1', Saldo: '0' }],
    });
  });

  it('passes cookie/storageState/close straight through', async () => {
    const inner = new testing.FakePortalDriver({
      restoreSession: { cookies: { TOKEN: 'abc' }, storageState: { cookies: [] } },
    });
    const session = await recordingDriver(inner, ctx()).restore({});

    expect(await session.cookie('https://www4.sii.cl', 'TOKEN')).toBe('abc');
    expect(await session.storageState()).toEqual({ cookies: [] });
    await expect(session.close()).resolves.toBeUndefined();
  });

  it('never breaks a read when recording itself fails, but REPORTS the failure', async () => {
    // The artifact store is a receipt, not a gatekeeper (ADR-004's posture for the audit sink).
    // But a swallowed failure is not acceptable either: during development a clock returning
    // `undefined` made every capture fail silently and the store just looked idle.
    const errors: { error: unknown; url: string }[] = [];
    const failing = {
      ...memoryArtifactStore(),
      put: async () => {
        throw new Error('disk full');
      },
    };
    const inner = new testing.FakePortalDriver({
      restoreSession: { requestJson: () => SDI_PAYLOAD },
    });
    const session = await recordingDriver(inner, {
      ...ctx(failing as never),
      onError: (error, url) => errors.push({ error, url }),
    }).restore({});

    await expect(session.requestJson('https://www4.sii.cl/x')).resolves.toEqual(SDI_PAYLOAD);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.url).toBe('https://www4.sii.cl/x');
    expect(String(errors[0]?.error)).toContain('disk full');
  });

  it('survives a reporter that itself throws', async () => {
    const failing = {
      ...memoryArtifactStore(),
      put: async () => {
        throw new Error('disk full');
      },
    };
    const inner = new testing.FakePortalDriver({
      restoreSession: { requestJson: () => SDI_PAYLOAD },
    });
    const session = await recordingDriver(inner, {
      ...ctx(failing as never),
      onError: () => {
        throw new Error('reporter exploded');
      },
    }).restore({});

    await expect(session.requestJson('https://www4.sii.cl/x')).resolves.toEqual(SDI_PAYLOAD);
  });
});

describe('deriveRunId', () => {
  it('is filename-safe and sortable', () => {
    const id = deriveRunId(new testing.FixedClock(new Date('2026-08-06T03:04:05.678Z')));
    expect(id).toBe('run-2026-08-06T03-04-05-678Z');
    expect(id).toMatch(/^[A-Za-z0-9._-]+$/);
  });
});
