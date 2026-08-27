import { describe, it, expect } from 'vitest';
import { FakePortalSession } from '../adapters/fake/index.js';
import { Rut } from '../rut/index.js';
import { Periodo } from '../periodo/index.js';
import { BpstError, SessionExpiredError } from '../errors/index.js';
import { fetchBpstMensual } from './bpst.js';

// Synthetic data only (no SII, no real PII): principal 11.111.111-1, worker 22.222.222-2.
const RUT = Rut.parse('11111111-1');
const PERIODO = Periodo.parse('2023-09');
const noPace = (): Promise<void> => Promise.resolve();

/** One EMITIDAS data row, 12 cells in observed order (docs/sii-contract/bpst.md): Ver, N°,
 *  Estado, Fecha, [Emisión Rut, Nombre — own identity], Fecha(2nd), [Receptor Rut, Nombre —
 *  the worker], Brutos, Retenidos, Pagado. */
function emitidasRow(opts: {
  folio: number;
  estado: string;
  estadoLabel: string;
  workerRut: string;
  workerNombre: string;
  brutos: string;
  retenidos: string;
  pagado: string;
}): string {
  return `<tr>
<td><div align="center"><a href="/cvc_cgi/bte/bte_indiv_cons3?C${opts.folio}"><img src="html.gif"></a></div></td>
<td><div align="left"><font class="reporte">${opts.folio}\n</font></div></td>
<td><font class="reporte"><a href="javascript:void(0);" onmouseover="return overlib('${opts.estadoLabel}',CAPTION,'Estado',WRAP)" onmouseout="return nd();">${opts.estado}</a></font></td>
<td><div align="left"><font class="reporte">04-09-2023\n</font></div></td>
<td><div align="right"><font class="reporte">SYNTHETIC OWN RUT-1\n</font></div></td>
<td><div align="left"><font class="reporte">SYNTHETIC OWN EMISOR NAME\n</font></div></td>
<td><div align="left"><font class="reporte">04-09-2023\n</font></div></td>
<td><div align="right"><font class="reporte">${opts.workerRut}\n</font></div></td>
<td><div align="left"><font class="reporte">${opts.workerNombre}\n</font></div></td>
<td><div align="right"><font class="reporte">${opts.brutos}\n</font></div></td>
<td><div align="right"><font class="reporte">${opts.retenidos}\n</font></div></td>
<td><div align="right"><font class="reporte">${opts.pagado}\n</font></div></td>
</tr>`;
}

function totalesRow(brutos: string, retenidos: string, pagado: string): string {
  return `<tr>
<td colspan="9" bgcolor="#CDCDCD"><div align="left"><font class="reporte"><b>(*)Totales</b></font></div></td>
<td><div align="right"><font class="reporte">${brutos}\n</font></div></td>
<td><div align="right"><font class="reporte">${retenidos}\n</font></div></td>
<td><div align="right"><font class="reporte">${pagado}\n</font></div></td>
</tr>`;
}

function page(opts: { summary: string; rows: string; totales: string; next: 'enabled' | 'disabled' | 'absent' }): string {
  const nextBtn =
    opts.next === 'absent'
      ? ''
      : `<input type="button" name="NEXT" value="Ver P&aacute;gina Siguiente" ${
          opts.next === 'disabled' ? 'disabled' : 'onClick="cambiapag(document.form1,2);"'
        }>`;
  return `<html><head><title>Boleta de Prestaci&oacute;n de Servicios de Terceros Electr&oacute;nica</title></head>
<body>
INFORME BTE's EMITIDAS
${opts.summary}
<table width="920" border=1>
<tr><td bgcolor="#CDCDCD">header</td></tr>
${opts.rows}
${opts.totales}
</table>
<input type="button" name="PREV" value="Ver P&aacute;gina Anterior" disabled>
${nextBtn}
</body></html>`;
}

const SUMMARY_2 = 'Total Boletas : 2\nBoletas Vigentes : 2\nBoletas Anuladas : 0\nP&aacute;gina 1 de 1';

describe('BPST facade (fake session, synthetic HTML, no SII)', () => {
  it('parses curated boletas (estado code + tooltip label), exposes no raw / own identity', async () => {
    const rows =
      emitidasRow({
        folio: 344,
        estado: 'VIG',
        estadoLabel: 'Vigente',
        workerRut: '22222222-2',
        workerNombre: 'TRABAJADOR UNO',
        brutos: '804.598',
        retenidos: '104.598',
        pagado: '700.000',
      }) +
      emitidasRow({
        folio: 345,
        estado: 'VIG',
        estadoLabel: 'Vigente',
        workerRut: '17003509-7',
        workerNombre: 'TRABAJADOR DOS',
        brutos: '459.770',
        retenidos: '59.770',
        pagado: '400.000',
      });
    const body = page({
      summary: SUMMARY_2,
      rows,
      totales: totalesRow('1.264.368', '164.368', '1.100.000'),
      next: 'disabled',
    });
    const session = new FakePortalSession({ requestForm: () => body });

    const res = await fetchBpstMensual(session, { rut: RUT, periodo: PERIODO, side: 'EMITIDAS' }, noPace);

    expect(res).toMatchObject({
      rut: '11111111-1',
      periodo: '2023-09',
      side: 'EMITIDAS',
      totalBoletas: 2,
      boletasVigentes: 2,
      boletasAnuladas: 0,
    });
    expect(res.totales).toEqual({ brutos: 1264368, retenidos: 164368, pagado: 1100000 });
    expect(res.boletas).toHaveLength(2);
    expect(res.boletas[0]).toMatchObject({
      folio: 344,
      estado: 'VIG',
      estadoLabel: 'Vigente',
      fecha: '04-09-2023',
      contraparteRut: '22222222-2',
      contraparteNombre: 'TRABAJADOR UNO',
      brutos: 804598,
      retenidos: 104598,
      pagado: 700000,
    });
    // No raw, no own-identity leak (the taxpayer's own "Emisión" rut/nombre never surface).
    expect(res.boletas[0]).not.toHaveProperty('raw');
    expect(JSON.stringify(res)).not.toContain('SYNTHETIC OWN EMISOR NAME');
    expect(JSON.stringify(res)).not.toContain('SYNTHETIC OWN RUT-1');
    // Bootstrap GET hit the emitidas CNTR=1 bootstrap.
    expect(session.gotos[0]).toContain('bte_indiv_cons?1');
    // Query POST carried the right form fields.
    expect(session.lastFormRequest?.options?.form).toMatchObject({
      TIPO: 'mensual',
      CNTR: '1',
      AUTEN: 'RUTCLAVE',
      MESM: '09',
      ANOM: '2023',
    });
  });

  it('SUMS per-page (*)Totales across every page — the load-bearing pagination trap', async () => {
    const page1Body = page({
      summary: 'Total Boletas : 3\nBoletas Vigentes : 3\nBoletas Anuladas : 0\nP&aacute;gina 1 de 2',
      rows: emitidasRow({
        folio: 1,
        estado: 'VIG',
        estadoLabel: 'Vigente',
        workerRut: '22222222-2',
        workerNombre: 'T1',
        brutos: '6.631.725',
        retenidos: '862.125',
        pagado: '5.769.600',
      }),
      totales: totalesRow('6.631.725', '862.125', '5.769.600'),
      next: 'enabled',
    });
    const page2Body = page({
      summary: '',
      rows: emitidasRow({
        folio: 2,
        estado: 'VIG',
        estadoLabel: 'Vigente',
        workerRut: '33333333-3',
        workerNombre: 'T2',
        brutos: '5.323.580',
        retenidos: '692.066',
        pagado: '4.631.514',
      }),
      totales: totalesRow('5.323.580', '692.066', '4.631.514'),
      next: 'disabled',
    });
    let call = 0;
    const session = new FakePortalSession({
      requestForm: () => {
        call++;
        return call === 1 ? page1Body : page2Body;
      },
    });

    const res = await fetchBpstMensual(session, { rut: RUT, periodo: PERIODO, side: 'EMITIDAS' }, noPace);

    // Exact real-world numbers from the 2023-03 live spike (ADR-029): page totals must be SUMMED,
    // never read from page 1 alone (which would under-count by 692.066, a 44.5% error).
    expect(res.totales).toEqual({ brutos: 11955305, retenidos: 1554191, pagado: 10401114 });
    expect(res.boletas).toHaveLength(2);
    expect(call).toBe(2); // walked both pages
  });

  it('an empty month is a clean 0-boleta result, not an error', async () => {
    const body = page({
      summary: 'Total Boletas : 0\nBoletas Vigentes : 0\nBoletas Anuladas : 0\nP&aacute;gina 1 de 1',
      rows: '',
      totales: totalesRow('0', '0', '0'),
      next: 'disabled',
    });
    const session = new FakePortalSession({ requestForm: () => body });

    const res = await fetchBpstMensual(session, { rut: RUT, periodo: PERIODO, side: 'EMITIDAS' }, noPace);

    expect(res.boletas).toEqual([]);
    expect(res.totalBoletas).toBe(0);
    expect(res.totales).toEqual({ brutos: 0, retenidos: 0, pagado: 0 });
  });

  it('a dead session (goto lands on the login host) raises SessionExpiredError', async () => {
    const session = new FakePortalSession({ landingUrl: 'https://zeusr.sii.cl/AUT2000/x.html' });
    await expect(
      fetchBpstMensual(session, { rut: RUT, periodo: PERIODO, side: 'EMITIDAS' }, noPace),
    ).rejects.toBeInstanceOf(SessionExpiredError);
  });

  it('a non-report page 1 (no BTE report markers) is a BpstError', async () => {
    const session = new FakePortalSession({ requestForm: () => '<html>not a report</html>' });
    await expect(
      fetchBpstMensual(session, { rut: RUT, periodo: PERIODO, side: 'EMITIDAS' }, noPace),
    ).rejects.toBeInstanceOf(BpstError);
  });

  it('RECIBIDAS uses the emitidas CNTR=2 bootstrap and 10-column row shape', async () => {
    const row = `<tr>
<td><div align="center"><a href="/cvc_cgi/bte/bte_indiv_cons3?C1"><img src="html.gif"></a></div></td>
<td><div align="left"><font class="reporte">7\n</font></div></td>
<td><font class="reporte"><a onmouseover="return overlib('Vigente',CAPTION,'Estado',WRAP)">VIG</a></font></td>
<td><div align="left"><font class="reporte">10-05-2026\n</font></div></td>
<td><div align="right"><font class="reporte">20000042-0\n</font></div></td>
<td><div align="left"><font class="reporte">Proveedor Servicios EIRL\n</font></div></td>
<td><div align="left"><font class="reporte">10-05-2026\n</font></div></td>
<td><div align="right"><font class="reporte">120.000\n</font></div></td>
<td><div align="right"><font class="reporte">17.400\n</font></div></td>
<td><div align="right"><font class="reporte">102.600\n</font></div></td>
</tr>`;
    const body = page({
      summary: 'Total Boletas : 1\nBoletas Vigentes : 1\nBoletas Anuladas : 0\nP&aacute;gina 1 de 1',
      rows: row,
      totales: totalesRow('120.000', '17.400', '102.600'),
      next: 'disabled',
    });
    const session = new FakePortalSession({ requestForm: () => body });

    const res = await fetchBpstMensual(session, { rut: RUT, periodo: PERIODO, side: 'RECIBIDAS' }, noPace);

    expect(res.side).toBe('RECIBIDAS');
    expect(session.gotos[0]).toContain('bte_indiv_cons?2');
    expect(res.boletas[0]).toMatchObject({
      folio: 7,
      contraparteRut: '20000042-0',
      contraparteNombre: 'Proveedor Servicios EIRL',
      brutos: 120000,
      retenidos: 17400,
      pagado: 102600,
    });
  });
});
