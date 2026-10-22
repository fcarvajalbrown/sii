import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadDemoTaxpayer } from './demo.js';
import { buildFindings } from './findings.js';
import { closedMonths } from './periods.js';

const fixturePath = resolve(dirname(fileURLToPath(import.meta.url)), '../demo/taxpayer.json');

describe('buildFindings', () => {
  it('lists the demo taxpayer findings, alta first', async () => {
    const { audit } = await loadDemoTaxpayer(fixturePath);
    const findings = buildFindings(audit);
    expect(findings.map((f) => [f.severity, f.scope])).toEqual([
      ['alta', 'F29 2026-04'],
      ['alta', 'F22 AT2026'],
      ['alta', 'Giro 7300000451'],
      ['media', 'Honorarios 2025-11'],
      ['media', 'IVA 2026-08'],
    ]);
  });

  it('combines BHE and BPST retentions against F29 código 151', async () => {
    const { audit } = await loadDemoTaxpayer(fixturePath);
    const honorarios = buildFindings({ ...audit, monitor: null, iva: [] });
    expect(honorarios).toHaveLength(1);
    expect(honorarios[0]?.figures).toEqual([
      { label: 'Retenido en boletas de honorarios', value: 203000 },
      { label: 'Propuesta F29, código 151', value: 101500 },
      { label: 'Diferencia', value: 101500 },
    ]);
  });

  it('reports an indeterminable IVA month as info, never as a discrepancy', async () => {
    const { audit } = await loadDemoTaxpayer(fixturePath);
    const month = audit.iva[0];
    if (!month) throw new Error('fixture has no IVA month');
    const indeterminable = {
      ...month,
      reconciliacion: { ...month.reconciliacion, cuadra: null },
    };
    const findings = buildFindings({ monitor: null, honorarios: null, iva: [indeterminable] });
    expect(findings.map((f) => f.severity)).toEqual(['info']);
  });

  it('returns nothing when every source is empty', () => {
    expect(buildFindings({ monitor: null, honorarios: null, iva: [] })).toEqual([]);
  });
});

describe('closedMonths', () => {
  it('returns the closed months before now, oldest first, across a year boundary', () => {
    expect(closedMonths(new Date(2026, 1, 15), 3)).toEqual(['2025-11', '2025-12', '2026-01']);
  });
});
