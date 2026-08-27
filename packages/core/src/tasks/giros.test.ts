import { describe, it, expect } from 'vitest';
import {
  FakePortalDriver,
  FixedClock,
  InMemoryKeyValueStore,
  RecordingAuditSink,
} from '../adapters/fake/index.js';
import type { Runtime } from '../seams/index.js';
import { NotAuthenticatedError } from '../errors/index.js';
import { initOperateState, setOperatingRut } from '../identity/index.js';
import { writeSession } from '../auth/index.js';
import { girosList } from './giros.js';

const SELF = '11111111-1';
const EMPRESA = '77777777-7';

const HEADERS = [
  'Período',
  'Folio Giro',
  'Formulario Giro',
  'Formulario Asociado',
  'Fecha de Emisión',
  'Fecha de Vencimiento',
  'Estado',
  'Moneda',
  'Saldo',
  'Ver',
  'Pagar en linea',
  'Imprimir Giro',
];

const rowFor = (anio: string): string[] => [
  `Abril ${anio}`,
  `900${anio}`,
  '21',
  '29',
  `25/06/${anio}`,
  `20/05/${anio}`,
  'Vigente',
  'CLP',
  '$0',
  '',
  '',
  '',
];

/** El `evaluate` del fake reparte según el marcador de la expresión; el año se lee del
 *  script de manejo para devolver la fila correspondiente. */
function makeRuntime(aniosConGiro: readonly string[]): Runtime {
  let lastAnio = '';
  const evaluate = (expr: string): unknown => {
    if (/CONSULTAR_GIROS/.test(expr)) {
      lastAnio = /"(\d{4})"/.exec(expr)?.[1] ?? '';
      return 'ok';
    }
    if (/LEER_GIROS/.test(expr)) {
      const hasRow = aniosConGiro.includes(lastAnio);
      return JSON.stringify({
        tabla: true,
        conteo: hasRow ? '1' : '0',
        rows: hasRow ? [['Consulta Giros'], HEADERS, rowFor(lastAnio)] : [['Consulta Giros'], HEADERS],
      });
    }
    throw new Error('expresión inesperada');
  };
  return {
    clock: new FixedClock(new Date('2026-08-03T12:00:00Z')),
    audit: new RecordingAuditSink(),
    store: new InMemoryKeyValueStore(),
    portal: new FakePortalDriver({ restoreSession: { evaluate, cookies: { TOKEN: 't' } } }),
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

describe('girosList (fakes, no SII)', () => {
  it('lee el año en curso por defecto', async () => {
    const rt = makeRuntime(['2026']);
    await seed(rt);

    const res = await girosList(rt, {});

    expect(res.anios).toEqual(['2026']);
    expect(res.giros).toHaveLength(1);
    expect(res.giros[0]).toMatchObject({ folio: '9002026', anio: '2026', saldo: 0 });
  });

  it('acepta un año explícito', async () => {
    const rt = makeRuntime(['2021']);
    await seed(rt);

    const res = await girosList(rt, { anio: '2021' });

    expect(res.anios).toEqual(['2021']);
    expect(res.giros[0]).toMatchObject({ anio: '2021' });
  });

  it('barre varios años hacia atrás en UNA sola sesión, y etiqueta cada giro con su año', async () => {
    const rt = makeRuntime(['2026', '2024']);
    await seed(rt);

    const res = await girosList(rt, { years: 3 });

    expect(res.anios).toEqual(['2026', '2025', '2024']);
    expect(res.giros.map((g) => g.anio)).toEqual(['2026', '2024']);
    expect(driverOf(rt).restoreCalls).toBe(1);
  });

  it('suma el saldo total adeudado', async () => {
    const rt = makeRuntime(['2026']);
    await seed(rt);

    const res = await girosList(rt, {});

    expect(res.saldoTotal).toBe(0);
  });

  it('rechaza un puntero operate representando a otro RUT ANTES de abrir sesión (ADR-005)', async () => {
    const rt = makeRuntime(['2026']);
    await seed(rt);
    await setOperatingRut(rt.store, EMPRESA);

    await expect(girosList(rt, {})).rejects.toThrow(/session-keyed/i);
    expect(driverOf(rt).restoreCalls).toBe(0);
  });

  it('audita rut, años y conteo — nunca un folio ni un monto', async () => {
    const rt = makeRuntime(['2026']);
    await seed(rt);

    await girosList(rt, {});

    const a = entries(rt).at(-1)!;
    expect(a).toMatchObject({ action: 'giros_list', result: 'ok', rut: SELF });
    expect(JSON.stringify(a)).not.toContain('9002026');
  });

  it('sin sesión lanza NotAuthenticated y audita el fallo', async () => {
    const rt = makeRuntime([]);

    await expect(girosList(rt, {})).rejects.toThrow(NotAuthenticatedError);
    expect(entries(rt).at(-1)).toMatchObject({ action: 'giros_list', result: 'failed' });
  });
});
