import { describe, it, expect } from 'vitest';
import { HOSTS, NotAuthenticatedError, testing, type Runtime } from '@dostertags/sii-core';
import { datos, run, runJson } from '../test-helpers.js';

describe('sii bpst command (fake runtime, no SII)', () => {
  const ROW = `<tr>
<td><div align="center"><a href="/cvc_cgi/bte/bte_indiv_cons3?C1"><img src="html.gif"></a></div></td>
<td><div align="left"><font class="reporte">101\n</font></div></td>
<td><font class="reporte"><a onmouseover="return overlib('Vigente',CAPTION,'Estado',WRAP)">VIG</a></font></td>
<td><div align="left"><font class="reporte">15-05-2026\n</font></div></td>
<td><div align="right"><font class="reporte">PII-OWN-RUT\n</font></div></td>
<td><div align="left"><font class="reporte">PII-OWN-XYZ\n</font></div></td>
<td><div align="left"><font class="reporte">15-05-2026\n</font></div></td>
<td><div align="right"><font class="reporte">12345670-K\n</font></div></td>
<td><div align="left"><font class="reporte">Trabajador Uno\n</font></div></td>
<td><div align="right"><font class="reporte">300.000\n</font></div></td>
<td><div align="right"><font class="reporte">43.500\n</font></div></td>
<td><div align="right"><font class="reporte">256.500\n</font></div></td>
</tr>`;
  const REPORT = `<html><head><title>Boleta de Prestaci&oacute;n de Servicios de Terceros Electr&oacute;nica</title></head>
<body>INFORME BTE's EMITIDAS
Total Boletas : 1
Boletas Vigentes : 1
Boletas Anuladas : 0
<table width="920" border=1>
<tr><td bgcolor="#CDCDCD">header</td></tr>
${ROW}
<tr><td colspan="9" bgcolor="#CDCDCD"><b>(*)Totales</b></td>
<td><font class="reporte">300.000</font></td>
<td><font class="reporte">43.500</font></td>
<td><font class="reporte">256.500</font></td></tr>
</table>
<input type="button" name="PREV" disabled>
<input type="button" name="NEXT" disabled>
</body></html>`;

  const makeBpstRuntime = (): Runtime => ({
    clock: new testing.FixedClock(new Date('2026-06-30T12:00:00Z')),
    audit: new testing.RecordingAuditSink(),
    store: new testing.InMemoryKeyValueStore(),
    portal: new testing.FakePortalDriver({
      loginSession: { landingUrl: HOSTS.miSii, evaluate: datos, storageState: { cookies: [] } },
      restoreSession: { landingUrl: HOSTS.miSii, evaluate: datos, requestForm: () => REPORT },
    }),
  });

  it('bpst list <periodo> prints the month boletas (EMITIDAS by default)', async () => {
    const rt = makeBpstRuntime();
    await run(rt, 'auth', 'login');
    const out = await run(rt, 'bpst', 'list', '2026-05');
    expect(out).toContain('BPST EMITIDAS 2026-05');
    expect(out).toContain('folio=101');
    expect(out).toContain('1 boleta(s)');
    expect(out).not.toContain('PII-OWN-XYZ'); // own-identity "Emisión" group never prints
  });

  it('JSON default: bpst list passes --recibidas through as the side', async () => {
    const rt = makeBpstRuntime();
    await run(rt, 'auth', 'login');
    // Fixture's row is EMITIDAS-shaped (portal/bpst.test.ts covers the RECIBIDAS row mapping
    // itself); this only asserts CLI wiring — the side flag reaches the task/facade.
    const json = (await runJson(rt, 'bpst', 'list', '2026-05', '--recibidas')) as { side: string };
    expect(json.side).toBe('RECIBIDAS');
  });

  it('bpst list requires a session (NotAuthenticated → exit 2)', async () => {
    await expect(run(makeBpstRuntime(), 'bpst', 'list', '2026-05')).rejects.toBeInstanceOf(
      NotAuthenticatedError,
    );
  });
});
