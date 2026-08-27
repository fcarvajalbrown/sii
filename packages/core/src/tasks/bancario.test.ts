import { describe, it, expect } from 'vitest';
import {
  FakePortalDriver,
  FixedClock,
  InMemoryKeyValueStore,
  RecordingAuditSink,
} from '../adapters/fake/index.js';
import type { FormRequest, Runtime } from '../seams/index.js';
import { NotAuthenticatedError } from '../errors/index.js';
import { initOperateState, setOperatingRut } from '../identity/index.js';
import { writeSession } from '../auth/index.js';
import { bancarioInforme } from './bancario.js';

const SELF = '11111111-1';
const EMPRESA = '77777777-7';

const INFORME = {
  listCarpetaTributaria: [
    {
      periodoDj: 202502,
      glosaNombreBanco: 'BANCO DEL ESTADO DE CHILE',
      glosaTipoCuenta: 'CUENTA CORRIENTE',
      semestre: 'Primer semestre 2025',
      sumaCantidadAbonos: 1433,
      sumaMontoTotalAbonos: 619837498,
    },
  ],
};

function makeRuntime(payload: unknown = INFORME): Runtime {
  const requestForm = (_url: string, options?: FormRequest): string => {
    const opc = options?.form?.['opc'] ?? '';
    if (opc !== '119') throw new Error(`opc inesperado: ${opc}`);
    return JSON.stringify(payload);
  };
  return {
    clock: new FixedClock(new Date('2026-08-05T12:00:00Z')),
    audit: new RecordingAuditSink(),
    store: new InMemoryKeyValueStore(),
    portal: new FakePortalDriver({ restoreSession: { requestForm, cookies: { TOKEN: 't' } } }),
  };
}

async function seed(runtime: Runtime): Promise<void> {
  await writeSession(runtime.store, { rut: SELF, cookies: ['c'], savedAt: '2026-08-05T12:00:00Z' });
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

describe('bancarioInforme (fakes, no SII)', () => {
  it('lee el informe bancario del titular de la sesión', async () => {
    const rt = makeRuntime();
    await seed(rt);

    const res = await bancarioInforme(rt);

    expect(res.rut).toBe(SELF);
    expect(res.semestres).toEqual([
      {
        periodoDj: '202502',
        semestre: 'Primer semestre 2025',
        banco: 'BANCO DEL ESTADO DE CHILE',
        tipoCuenta: 'CUENTA CORRIENTE',
        cantidadAbonos: 1433,
        montoTotalAbonos: 619837498,
      },
    ]);
    expect(driverOf(rt).restoreCalls).toBe(1);
  });

  it('rechaza un puntero operate representando a otro RUT ANTES de abrir sesión (ADR-005)', async () => {
    const rt = makeRuntime();
    await seed(rt);
    await setOperatingRut(rt.store, EMPRESA);

    await expect(bancarioInforme(rt)).rejects.toThrow(/session-keyed/i);
    expect(driverOf(rt).restoreCalls).toBe(0);
  });

  it('audita rut y cantidad de semestres — NUNCA un monto (ADR-006/ADR-024)', async () => {
    const rt = makeRuntime();
    await seed(rt);

    await bancarioInforme(rt);

    const a = entries(rt).at(-1)!;
    expect(a).toMatchObject({ action: 'bancario_informe', result: 'ok', rut: SELF, semestres: 1 });
    expect(JSON.stringify(a)).not.toContain('619837498');
  });

  it('sin sesión lanza NotAuthenticated y audita el fallo', async () => {
    const rt = makeRuntime();

    await expect(bancarioInforme(rt)).rejects.toThrow(NotAuthenticatedError);
    expect(entries(rt).at(-1)).toMatchObject({ action: 'bancario_informe', result: 'failed' });
  });
});
