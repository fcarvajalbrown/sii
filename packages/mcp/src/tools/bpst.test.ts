import { describe, it, expect } from 'vitest';
import { HOSTS, testing, type Runtime } from '@dostertags/sii-core';
import { connect, toolText } from '../test-helpers.js';

const datos = (): unknown => ({
  contribuyente: { rut: 11111111, dv: '1', nombres: 'Juan', apellidoPaterno: 'Pérez' },
});

const ROW = `<tr>
<td><div align="center"><a href="/cvc_cgi/bte/bte_indiv_cons3?C1"><img src="html.gif"></a></div></td>
<td><div align="left"><font class="reporte">101\n</font></div></td>
<td><font class="reporte"><a onmouseover="return overlib('Vigente',CAPTION,'Estado',WRAP)">VIG</a></font></td>
<td><div align="left"><font class="reporte">15-05-2026\n</font></div></td>
<td><div align="right"><font class="reporte">PII-OWN\n</font></div></td>
<td><div align="left"><font class="reporte">PII-OWN-NAME\n</font></div></td>
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

function makeRuntime(): Runtime {
  return {
    clock: new testing.FixedClock(new Date('2026-06-30T12:00:00Z')),
    audit: new testing.RecordingAuditSink(),
    store: new testing.InMemoryKeyValueStore(),
    portal: new testing.FakePortalDriver({
      loginSession: { landingUrl: HOSTS.miSii, evaluate: datos, storageState: { cookies: [] } },
      restoreSession: { landingUrl: HOSTS.miSii, evaluate: datos, requestForm: () => REPORT },
    }),
  };
}

describe('@dostertags/sii-mcp bpst tools (in-memory client, fake runtime, no SII)', () => {
  it('bpst_list returns the curated month as JSON, EMITIDAS by default', async () => {
    const client = await connect(makeRuntime());
    await client.callTool({ name: 'auth_login', arguments: {} });
    const res = await client.callTool({ name: 'bpst_list', arguments: { periodo: '2026-05' } });
    const parsed = JSON.parse(toolText(res)) as {
      side: string;
      boletas: { folio: number; contraparteNombre: string | null }[];
    };
    expect(parsed.side).toBe('EMITIDAS');
    expect(parsed.boletas).toEqual([
      expect.objectContaining({ folio: 101, contraparteNombre: 'Trabajador Uno' }),
    ]);
    expect(JSON.stringify(parsed)).not.toContain('PII-OWN-NAME');
  });

  it('bpst_list is read-only', async () => {
    const client = await connect(makeRuntime());
    const { tools } = await client.listTools();
    expect(tools.find((t) => t.name === 'bpst_list')?.annotations?.readOnlyHint).toBe(true);
  });
});
