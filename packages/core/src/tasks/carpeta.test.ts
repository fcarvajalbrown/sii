import { describe, it, expect } from 'vitest';
import {
  FakePortalDriver,
  FixedClock,
  InMemoryKeyValueStore,
  RecordingAuditSink,
} from '../adapters/fake/index.js';
import type { JsonRequest, Runtime } from '../seams/index.js';
import { NotAuthenticatedError } from '../errors/index.js';
import { initOperateState, setOperatingRut } from '../identity/index.js';
import { writeSession } from '../auth/index.js';
import { carpetaTributariaHistorial } from './carpeta.js';

const SELF = '11111111-1';
const EMPRESA = '77777777-7';

function makeRuntime(byAgno: Record<string, unknown>): Runtime {
  const requestJson = (url: string, _options?: JsonRequest): unknown => {
    const match = /[?&]agno=(\d+)/.exec(url);
    const key = match ? match[1]! : 'ALL';
    if (!(key in byAgno)) throw new Error(`unexpected agno requested: ${key}`);
    return byAgno[key];
  };
  return {
    clock: new FixedClock(new Date('2026-08-03T12:00:00Z')),
    audit: new RecordingAuditSink(),
    store: new InMemoryKeyValueStore(),
    portal: new FakePortalDriver({ restoreSession: { requestJson, cookies: { TOKEN: 't' } } }),
  };
}

async function seed(runtime: Runtime): Promise<void> {
  await writeSession(runtime.store, { rut: SELF, cookies: ['c'], savedAt: '2026-08-03T12:00:00Z' });
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

const ROW = {
  carpetaTributaria: {
    carpCodigoRepositorio: 1,
    carpClaveCarpeta: 'AAA',
    carpFechaGeneracion: '2026-01-20',
    carpNombreReceptor: 'Juan Pérez',
    carpRutReceptor: 11111111,
    carpDvReceptor: '1',
    carpEstado: 1,
    carpTipo: 1,
    enfinCodigo: '000',
    carpParametros: '{}',
  },
  enfinDescripcion: 'OTRA INSTITUCIÓN',
};

describe('carpetaTributariaHistorial (fakes, no SII)', () => {
  it('defaults to every año (no filter)', async () => {
    const rt = makeRuntime({ ALL: [ROW] });
    await seed(rt);

    const res = await carpetaTributariaHistorial(rt, {});

    expect(res.anio).toBeNull();
    expect(res.items).toHaveLength(1);
  });

  it('filters by año when given', async () => {
    const rt = makeRuntime({ '2025': [ROW] });
    await seed(rt);

    const res = await carpetaTributariaHistorial(rt, { anio: '2025' });

    expect(res.anio).toBe('2025');
    expect(res.items).toHaveLength(1);
  });

  it('rejects a representing operate pointer BEFORE opening a session (ADR-005)', async () => {
    const rt = makeRuntime({ ALL: [] });
    await seed(rt);
    await setOperatingRut(rt.store, EMPRESA);

    await expect(carpetaTributariaHistorial(rt, {})).rejects.toThrow(/session-keyed/i);
    expect(driverOf(rt).restoreCalls).toBe(0);
  });

  it('audits rut, anio and count, never a receptor/claveCarpeta value', async () => {
    const rt = makeRuntime({ ALL: [ROW] });
    await seed(rt);

    await carpetaTributariaHistorial(rt, {});

    const a = entries(rt).at(-1)!;
    expect(a).toMatchObject({ action: 'carpeta_tributaria_historial', result: 'ok', rut: SELF });
    expect(JSON.stringify(a)).not.toContain('AAA');
    expect(JSON.stringify(a)).not.toContain('Juan Pérez');
  });

  it('raises NotAuthenticated with no session, and audits the failure', async () => {
    const rt = makeRuntime({});

    await expect(carpetaTributariaHistorial(rt, {})).rejects.toThrow(NotAuthenticatedError);
    expect(entries(rt).at(-1)).toMatchObject({ action: 'carpeta_tributaria_historial', result: 'failed' });
  });
});
