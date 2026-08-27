import { describe, it, expect } from 'vitest';
import { FakePortalSession } from '../adapters/fake/index.js';
import { BancarioError } from '../errors/index.js';
import { fetchInformeBancario } from './bancario.js';

function session(byOpc: Record<string, unknown>): FakePortalSession {
  return new FakePortalSession({
    requestForm: (_url, options) => {
      const opc = options?.form?.['opc'] ?? '';
      if (!(opc in byOpc)) throw new Error(`opc inesperado: ${opc}`);
      const v = byOpc[opc];
      return typeof v === 'string' ? v : JSON.stringify(v);
    },
  });
}

// Observado en vivo 2026-08-05, a real taxpayer account (docs/sii-contract/bancario.md).
const INFORME_REAL = {
  listCarpetaTributaria: [
    {
      rutTitularC2: 77777777,
      dvTitularC2: '7',
      periodoDj: 202502,
      glosaNombreBanco: 'BANCO DEL ESTADO DE CHILE',
      glosaTipoCuenta: 'CUENTA CORRIENTE',
      semestre: 'Primer semestre 2025',
      sumaCantidadAbonos: 1433,
      sumaMontoTotalAbonos: 619837498,
    },
    {
      rutTitularC2: 77777777,
      dvTitularC2: '7',
      periodoDj: 202507,
      glosaNombreBanco: 'BANCO DEL ESTADO DE CHILE',
      glosaTipoCuenta: 'CUENTA CORRIENTE',
      // Misma glosa de semestre que la fila anterior con OTRO periodoDj — observado tal cual.
      semestre: 'Primer semestre 2025',
      sumaCantidadAbonos: 1485,
      sumaMontoTotalAbonos: 656476413,
    },
  ],
};

describe('bancario — informe de abonos por semestre (opc=119)', () => {
  it('cura banco, tipo de cuenta, semestre y montos', async () => {
    const res = await fetchInformeBancario(session({ '119': INFORME_REAL }));

    expect(res).toEqual([
      {
        periodoDj: '202502',
        semestre: 'Primer semestre 2025',
        banco: 'BANCO DEL ESTADO DE CHILE',
        tipoCuenta: 'CUENTA CORRIENTE',
        cantidadAbonos: 1433,
        montoTotalAbonos: 619837498,
      },
      {
        periodoDj: '202507',
        semestre: 'Primer semestre 2025',
        banco: 'BANCO DEL ESTADO DE CHILE',
        tipoCuenta: 'CUENTA CORRIENTE',
        cantidadAbonos: 1485,
        montoTotalAbonos: 656476413,
      },
    ]);
  });

  it('NUNCA expone rutTitularC2/dvTitularC2 — siempre el RUT de la sesión, no aporta dato nuevo', async () => {
    const res = await fetchInformeBancario(session({ '119': INFORME_REAL }));
    const json = JSON.stringify(res);
    expect(json).not.toContain('rutTitularC2');
    expect(json).not.toContain('77777777');
  });

  it('un array vacío es un resultado legítimo (sin informe), no un error', async () => {
    const res = await fetchInformeBancario(session({ '119': { listCarpetaTributaria: [] } }));
    expect(res).toEqual([]);
  });

  it('una respuesta no-JSON es BancarioError, nunca un crash', async () => {
    await expect(
      fetchInformeBancario(session({ '119': '<html>login</html>' })),
    ).rejects.toBeInstanceOf(BancarioError);
  });

  it('una respuesta con forma irreconocible (sin listCarpetaTributaria) es BancarioError', async () => {
    await expect(fetchInformeBancario(session({ '119': { otraCosa: 1 } }))).rejects.toBeInstanceOf(
      BancarioError,
    );
  });
});
