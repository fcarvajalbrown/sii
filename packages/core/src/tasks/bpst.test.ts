import { describe, it, expect } from 'vitest';
import {
  FakePortalDriver,
  FixedClock,
  InMemoryKeyValueStore,
  RecordingAuditSink,
} from '../adapters/fake/index.js';
import type { Runtime } from '../seams/index.js';
import { BpstError, NotAuthenticatedError } from '../errors/index.js';
import { initOperateState, setOperatingRut } from '../identity/index.js';
import { writeSession } from '../auth/index.js';
import { bpstList } from './bpst.js';

// Synthetic data (no SII, no real PII): persona 11.111.111-1, empresa 77.777.777-7.
const SELF = '11111111-1';
const EMPRESA = '77777777-7';

const ROW = `<tr>
<td><div align="center"><a href="/cvc_cgi/bte/bte_indiv_cons3?C1"><img src="html.gif"></a></div></td>
<td><div align="left"><font class="reporte">101\n</font></div></td>
<td><font class="reporte"><a onmouseover="return overlib('Vigente',CAPTION,'Estado',WRAP)">VIG</a></font></td>
<td><div align="left"><font class="reporte">15-05-2026\n</font></div></td>
<td><div align="right"><font class="reporte">SYNTHETIC-OWN\n</font></div></td>
<td><div align="left"><font class="reporte">SYNTHETIC OWN NAME\n</font></div></td>
<td><div align="left"><font class="reporte">15-05-2026\n</font></div></td>
<td><div align="right"><font class="reporte">12345670-K\n</font></div></td>
<td><div align="left"><font class="reporte">Trabajador Uno\n</font></div></td>
<td><div align="right"><font class="reporte">300.000\n</font></div></td>
<td><div align="right"><font class="reporte">43.500\n</font></div></td>
<td><div align="right"><font class="reporte">256.500\n</font></div></td>
</tr>`;

function reportBody(rows: string, totals = '300.000', totalsR = '43.500', totalsP = '256.500'): string {
  return `<html><head><title>Boleta de Prestaci&oacute;n de Servicios de Terceros Electr&oacute;nica</title></head>
<body>
INFORME BTE's EMITIDAS
Total Boletas : ${rows ? '1' : '0'}
Boletas Vigentes : ${rows ? '1' : '0'}
Boletas Anuladas : 0
<table width="920" border=1>
<tr><td bgcolor="#CDCDCD">header</td></tr>
${rows}
<tr><td colspan="9" bgcolor="#CDCDCD"><b>(*)Totales</b></td>
<td><font class="reporte">${totals}</font></td>
<td><font class="reporte">${totalsR}</font></td>
<td><font class="reporte">${totalsP}</font></td></tr>
</table>
<input type="button" name="PREV" disabled>
<input type="button" name="NEXT" disabled>
</body></html>`;
}

function makeRuntime(body: string = reportBody(ROW)): Runtime {
  return {
    clock: new FixedClock(new Date('2026-06-30T12:00:00Z')),
    audit: new RecordingAuditSink(),
    store: new InMemoryKeyValueStore(),
    portal: new FakePortalDriver({ restoreSession: { requestForm: () => body } }),
  };
}

async function seed(runtime: Runtime): Promise<void> {
  await writeSession(runtime.store, { rut: SELF, cookies: ['c'], savedAt: '2026-06-30T12:00:00Z' });
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

describe('bpst tasks (fakes, no SII)', () => {
  it('bpstList reads the session principal, returns parsed boletas + audits ok', async () => {
    const rt = makeRuntime();
    await seed(rt);

    const res = await bpstList(rt, { periodo: '2026-05', side: 'EMITIDAS' });
    expect(res).toMatchObject({ rut: SELF, periodo: '2026-05', side: 'EMITIDAS', totalBoletas: 1 });
    expect(res.boletas[0]).toMatchObject({
      folio: 101,
      contraparteRut: '12345670-K',
      contraparteNombre: 'Trabajador Uno',
      estado: 'VIG',
      estadoLabel: 'Vigente',
    });
    // Own-identity from the "Emisión" group never surfaces.
    expect(JSON.stringify(res)).not.toContain('SYNTHETIC OWN NAME');
    expect(JSON.stringify(res)).not.toContain('SYNTHETIC-OWN');

    const a = entries(rt).at(-1)!;
    expect(a).toMatchObject({
      action: 'bpst_list',
      result: 'ok',
      rut: SELF,
      period: '202605',
      side: 'EMITIDAS',
    });
  });

  it('rejects a representing operate pointer UP FRONT (session-keyed), with no session opened', async () => {
    const rt = makeRuntime();
    await seed(rt);
    await setOperatingRut(rt.store, EMPRESA); // operate as the represented empresa

    await expect(bpstList(rt, { periodo: '2026-05', side: 'EMITIDAS' })).rejects.toBeInstanceOf(
      BpstError,
    );
    expect(rt.portal.restoreCalls).toBe(0); // rejected before any session was opened
    expect(entries(rt)).toHaveLength(0);
  });

  it('an empty month returns a clean 0-boleta result', async () => {
    const rt = makeRuntime(reportBody('', '0', '0', '0'));
    await seed(rt);
    const res = await bpstList(rt, { periodo: '2026-05', side: 'RECIBIDAS' });
    expect(res.boletas).toEqual([]);
    expect(res.totalBoletas).toBe(0);
    expect(entries(rt).at(-1)).toMatchObject({ action: 'bpst_list', result: 'ok' });
  });

  it('a bad período fails fast with no session opened', async () => {
    const rt = makeRuntime();
    await seed(rt);
    await expect(bpstList(rt, { periodo: 'not-a-period', side: 'EMITIDAS' })).rejects.toThrow();
    expect(rt.portal.restoreCalls).toBe(0);
  });

  it('raises NotAuthenticated with no session', async () => {
    const rt = makeRuntime();
    await expect(bpstList(rt, { periodo: '2026-05', side: 'EMITIDAS' })).rejects.toBeInstanceOf(
      NotAuthenticatedError,
    );
  });
});
