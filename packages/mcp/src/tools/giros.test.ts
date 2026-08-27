import { describe, it, expect } from 'vitest';
import { HOSTS, testing, type Runtime } from '@dostertags/sii-core';
import { connect, toolText } from '../test-helpers.js';

const datos = (): unknown => ({
  contribuyente: { rut: 11111111, dv: '1', nombres: 'Juan', apellidoPaterno: 'Pérez' },
});

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

function makeRuntime(): Runtime {
  const evaluate = (expr: string): unknown => {
    if (/CONSULTAR_GIROS/.test(expr)) return 'ok';
    if (/LEER_GIROS/.test(expr)) {
      return JSON.stringify({
        tabla: true,
        conteo: '1',
        rows: [
          ['Consulta Giros'],
          HEADERS,
          ['Abril 2026', '9121778576', '21', '29', '25/06/2026', '20/05/2026', 'Vigente', 'CLP', '$0', '', '', ''],
        ],
      });
    }
    return datos();
  };
  return {
    clock: new testing.FixedClock(new Date('2026-08-03T12:00:00Z')),
    audit: new testing.RecordingAuditSink(),
    store: new testing.InMemoryKeyValueStore(),
    portal: new testing.FakePortalDriver({
      loginSession: { landingUrl: HOSTS.miSii, evaluate: datos, storageState: { cookies: [] } },
      restoreSession: { landingUrl: HOSTS.miSii, evaluate },
    }),
  };
}

describe('@dostertags/sii-mcp giros_list tool (in-memory client, fake runtime, no SII)', () => {
  it('devuelve los giros curados como JSON', async () => {
    const client = await connect(makeRuntime());
    await client.callTool({ name: 'auth_login', arguments: {} });
    const res = await client.callTool({ name: 'giros_list', arguments: {} });
    const parsed = JSON.parse(toolText(res)) as { giros: { folio: string }[]; saldoTotal: number };
    expect(parsed.giros[0]?.folio).toBe('9121778576');
    expect(parsed.saldoTotal).toBe(0);
  });

  it('es de solo lectura', async () => {
    const client = await connect(makeRuntime());
    const { tools } = await client.listTools();
    expect(tools.find((t) => t.name === 'giros_list')?.annotations?.readOnlyHint).toBe(true);
  });

  it('la descripción advierte que "Vigente" no significa impago', async () => {
    const client = await connect(makeRuntime());
    const { tools } = await client.listTools();
    const desc = tools.find((t) => t.name === 'giros_list')?.description ?? '';
    expect(desc).toMatch(/no significa impago/i);
    expect(desc).toMatch(/nunca paga/i);
  });
});
