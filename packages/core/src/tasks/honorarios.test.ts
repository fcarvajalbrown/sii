import { describe, it, expect } from 'vitest';
import {
  FakePortalDriver,
  FixedClock,
  InMemoryKeyValueStore,
  RecordingAuditSink,
} from '../adapters/fake/index.js';
import type { JsonRequest, Runtime } from '../seams/index.js';
import { NotAuthenticatedError, ValidationError } from '../errors/index.js';
import { initOperateState, setOperatingRut } from '../identity/index.js';
import { writeSession } from '../auth/index.js';
import { honorariosAnual } from './honorarios.js';

// Synthetic data only (no SII, no real PII): persona 20.000.042-0, empresa 77.777.777-7.
const SELF = '20000042-0';
const EMPRESA = '77777777-7';

/** A BHE "recibidas" inline map for one month. `retencion_receptor` is what WE withheld;
 *  `retencion_emisor` is what the contractor withheld for themselves — only the former is ours
 *  to declare in the F29 (ADR-023). */
const bteMap = (opts: { receptor: number; emisor: number; total: number }) => ({
  xml_values: {
    total_boletas: '1',
    suma_honorarios: String(opts.total),
    suma_retencion_emisor: String(opts.emisor),
    suma_retencion_receptor: String(opts.receptor),
    suma_liquido: String(opts.total - opts.receptor - opts.emisor),
  },
  arr_informe_mensual: {
    nroboleta_1: '55',
    fecha_boleta_1: '10/03/2025',
    rutemisor_1: '77777777',
    dvemisor_1: '7',
    nombre_emisor_1: 'CONTRATISTA SPA',
    totalhonorarios_1: String(opts.total),
    retencion_emisor_1: String(opts.emisor),
    retencion_receptor_1: String(opts.receptor),
    estado_1: 'N',
  },
});

const EMPTY_BTE = { xml_values: { total_boletas: '0' }, arr_informe_mensual: {} };

/** A BPST (ADR-029) EMITIDAS report page, HTML — the wire shape is a plain table (form-POST
 *  query → HTML), NOT the loa.sii.cl inline-map pattern. `retenido` is the ONE new source this
 *  ADR adds to the reconciliation (a worker paid via "boleta a nombre de terceros"). */
const EMPTY_BPST =
  `<html><head><title>Boleta de Prestación de Servicios de Terceros Electrónica</title></head>` +
  `<body>INFORME BTE's EMITIDAS\nTotal Boletas : 0\nBoletas Vigentes : 0\nBoletas Anuladas : 0\n` +
  `<table><tr><td colspan="9" bgcolor="#CDCDCD"><b>(*)Totales</b></td>` +
  `<td><font class="reporte">0</font></td><td><font class="reporte">0</font></td>` +
  `<td><font class="reporte">0</font></td></tr></table>` +
  `<input type="button" name="NEXT" disabled></body></html>`;

function bpstMap(opts: { retenido: number; brutos: number }): string {
  const row = `<tr>
<td><div align="center"><a href="/cvc_cgi/bte/bte_indiv_cons3?C1"><img src="html.gif"></a></div></td>
<td><div align="left"><font class="reporte">900\n</font></div></td>
<td><font class="reporte"><a onmouseover="return overlib('Vigente',CAPTION,'Estado',WRAP)">VIG</a></font></td>
<td><div align="left"><font class="reporte">10-03-2025\n</font></div></td>
<td><div align="right"><font class="reporte">SYNTHETIC-OWN\n</font></div></td>
<td><div align="left"><font class="reporte">SYNTHETIC OWN NAME\n</font></div></td>
<td><div align="left"><font class="reporte">10-03-2025\n</font></div></td>
<td><div align="right"><font class="reporte">99999999-9\n</font></div></td>
<td><div align="left"><font class="reporte">TRABAJADOR SINTETICO\n</font></div></td>
<td><div align="right"><font class="reporte">${opts.brutos.toLocaleString('es-CL').replace(/,/g, '.')}\n</font></div></td>
<td><div align="right"><font class="reporte">${opts.retenido.toLocaleString('es-CL').replace(/,/g, '.')}\n</font></div></td>
<td><div align="right"><font class="reporte">${(opts.brutos - opts.retenido).toLocaleString('es-CL').replace(/,/g, '.')}\n</font></div></td>
</tr>`;
  return (
    `<html><head><title>Boleta de Prestación de Servicios de Terceros Electrónica</title></head>` +
    `<body>INFORME BTE's EMITIDAS\nTotal Boletas : 1\nBoletas Vigentes : 1\nBoletas Anuladas : 0\n` +
    `<table><tr><td bgcolor="#CDCDCD">header</td></tr>${row}` +
    `<tr><td colspan="9" bgcolor="#CDCDCD"><b>(*)Totales</b></td>` +
    `<td><font class="reporte">${opts.brutos.toLocaleString('es-CL').replace(/,/g, '.')}</font></td>` +
    `<td><font class="reporte">${opts.retenido.toLocaleString('es-CL').replace(/,/g, '.')}</font></td>` +
    `<td><font class="reporte">${(opts.brutos - opts.retenido).toLocaleString('es-CL').replace(/,/g, '.')}</font></td></tr>` +
    `</table><input type="button" name="NEXT" disabled></body></html>`
  );
}

/** F29 propuesta carrying código 151 (retención honorarios Art. 74 Nº2) and 153 (Art. 48 —
 *  directors' fees, deliberately NOT part of the reconciliation). */
const f29Env = (cod151: number | null, cod153 = 99999) => ({
  metaData: { errors: null },
  data: {
    tipopropuesta: 40,
    estado: 0,
    listCodPropuestos: [
      ...(cod151 === null ? [] : [{ codigo: '151', valor: String(cod151) }]),
      { codigo: '153', valor: String(cod153) },
    ],
  },
});

const NO_PROPUESTA = { metaData: { errors: null }, data: null };

const DECLS_ENV = {
  metaData: { errors: [] },
  data: {
    decls: [{ folio: '77001', vgte: 'S', codConc: 'C1', fecIng: '20/04/2026' }],
    glosas: [{ codConclusion: 'C1', descripcion: 'Declaración vigente' }],
  },
};

// F22 grid: mapped honorarios códigos + the UNMAPPED 1412 that B92 names + noise.
const GRID_ENV = {
  metaData: { errors: [] },
  data: [
    { codigo: '1', valor: 'PII APELLIDO', glosa: 'Apellido paterno' },
    { codigo: '467', valor: '12.000.000', glosa: 'Total Honorarios' },
    { codigo: '492', valor: '1.200.000', glosa: 'Impuesto Retenido de Honorarios' },
    { codigo: '1412', valor: '9.500.000', glosa: 'Honorarios régimen 14D Nº3' },
    { codigo: '999', valor: '1', glosa: 'Ruido no relacionado' },
  ],
};

function makeRuntime(
  opts: {
    /** Per-`YYYY-MM` BHE inline maps; a missing month falls back to an empty month. */
    bte?: Record<string, unknown>;
    /** Per-`YYYYMM` F29 propuesta envelopes. */
    f29?: Record<string, unknown>;
    decls?: unknown;
    grid?: unknown;
    /** Per-`YYYY-MM` BPST (ADR-029) EMITIDAS report HTML; a missing month falls back to a clean
     *  0-boleta report — EVERY test that doesn't mention `bpst` is unaffected by ADR-029. */
    bpst?: Record<string, unknown>;
  } = {},
): Runtime {
  const requestJson = (url: string, options?: JsonRequest): unknown => {
    if (url.includes('getDeclaracionConCondicionesYTipoPropuesta')) {
      const d = (options?.body as { data?: Record<string, unknown> } | undefined)?.data ?? {};
      const key = `${String(d['anno'] ?? '')}${String(d['mes'] ?? '')}`;
      return opts.f29?.[key] ?? f29Env(0);
    }
    if (url.includes('buscaDeclVgte')) return opts.decls ?? DECLS_ENV;
    if (url.includes('f22Compacto')) return opts.grid ?? GRID_ENV;
    throw new Error(`unexpected JSON url: ${url}`);
  };
  // The BHE facade navigates + reads inline JS maps; key the fake by the URL's año/mes.
  let lastMap: Record<string, unknown> = EMPTY_BTE;
  const restoreSession = {
    requestJson,
    cookies: { TOKEN: 't' },
    landingUrl: undefined as unknown as string,
    evaluate: (expr: string): unknown => {
      if (expr.includes('xml_values')) return (lastMap as { xml_values?: unknown }).xml_values;
      if (expr.includes('arr_informe_mensual'))
        return (lastMap as { arr_informe_mensual?: unknown }).arr_informe_mensual;
      return null;
    },
    // BPST (ADR-029) — a form-POST query, keyed by the ANOM/MESM fields sent. Defaults to a
    // clean 0-boleta report so every EXISTING test (which knows nothing about BPST) is
    // unaffected; `opts.bpst['YYYY-MM']` overrides it for tests that need real BPST data.
    requestForm: (_url: string, formOpts?: { form?: Record<string, string> }): string => {
      const form = formOpts?.form ?? {};
      const key = `${form['ANOM'] ?? ''}-${form['MESM'] ?? ''}`;
      return (opts.bpst?.[key] as string | undefined) ?? EMPTY_BPST;
    },
  };
  const gotoUrls: string[] = [];
  const driver = new FakePortalDriver({ restoreSession });
  // Intercept goto so each month's URL selects that month's map.
  const origRestore = driver.restore.bind(driver);
  driver.restore = async (state: unknown) => {
    const session = await origRestore(state);
    const origGoto = session.goto.bind(session);
    session.goto = async (url: string) => {
      gotoUrls.push(url);
      const m = /cbanoinformemensual=(\d{4})&cbmesinformemensual=(\d{2})/.exec(url);
      const key = m ? `${m[1]}-${m[2]}` : '';
      const page = /pagina_solicitada=(\d+)/.exec(url)?.[1] ?? '0';
      // Only page 0 carries data; later pages end pagination.
      lastMap = page === '0' ? ((opts.bte?.[key] as Record<string, unknown>) ?? EMPTY_BTE) : {};
      return origGoto(url);
    };
    return session;
  };
  return {
    clock: new FixedClock(new Date('2026-07-25T12:00:00Z')),
    audit: new RecordingAuditSink(),
    store: new InMemoryKeyValueStore(),
    portal: driver,
    // Test-only escape hatch — read via `gotoUrlsOf(rt)` below.
    _gotoUrls: gotoUrls,
  } as Runtime & { _gotoUrls: string[] };
}

/** Every BHE CGI URL `honorariosAnual` navigated to, in order — the guardrail below asserts this
 *  is ALWAYS the RECIBIDAS report, never EMITIDAS. */
const gotoUrlsOf = (rt: Runtime): string[] => (rt as Runtime & { _gotoUrls: string[] })._gotoUrls;

async function seed(runtime: Runtime): Promise<void> {
  await writeSession(runtime.store, { rut: SELF, cookies: ['c'], savedAt: '2026-07-25T12:00:00Z' });
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

describe('honorariosAnual composite (fakes, no SII)', () => {
  it('a cache hit reports cached:true — the result must not claim a fresh SII read (ADR-027)', async () => {
    const rt = makeRuntime();
    await seed(rt);

    // Comercial 2024 → AT2025, CLOSED at the fixed clock (2026-07-25) ⇒ cacheable.
    const first = await honorariosAnual(rt, { anio: '2024' });
    expect(first.cached).toBe(false);
    expect(driverOf(rt).restoreCalls).toBe(1);

    const second = await honorariosAnual(rt, { anio: '2024' });
    expect(second.cached).toBe(true); // was silently `false` before the fix
    expect(driverOf(rt).restoreCalls).toBe(1); // served from disk — no second session
  });

  // GUARDRAIL (live claim 2026-07-29, Empresa A's accountant): a suspected bug where
  // STANDARD BHE RECIBIDAS (loa.sii.cl — what WE withheld, ours to declare) might get summed
  // with STANDARD BHE EMITIDAS (boletas WE issued as a sociedad de profesionales — someone
  // else's withholding on OUR income, a completely different flow). Code audit found no such
  // summation in `honorarios.ts` — it calls `fetchBteMensual` exactly once per month, always
  // `side: 'RECIBIDAS'`, against the loa.sii.cl CGI family. This test pins that down at the wire
  // level. SEPARATELY, and INTENTIONALLY since ADR-029, `honorarios.ts` ALSO reads BPST
  // (zeus.sii.cl — a different SII product, see the module header trap 3) with `side:
  // 'EMITIDAS'` — that is the fix, not a violation of this guardrail, so the two CGI families are
  // asserted independently.
  it('NEVER reads the standard EMITIDAS BHE report (loa.sii.cl) — only RECIBIDAS there; BPST (zeus.sii.cl) is EMITIDAS by design (ADR-029)', async () => {
    const rt = makeRuntime({
      bte: { '2025-03': bteMap({ receptor: 100000, emisor: 777777, total: 1000000 }) },
      f29: { '202503': f29Env(100000) },
    });
    await seed(rt);

    await honorariosAnual(rt, { anio: '2025' });

    const urls = gotoUrlsOf(rt);
    const bheUrls = urls.filter((u) => u.includes('loa.sii.cl'));
    const bpstUrls = urls.filter((u) => u.includes('zeus.sii.cl'));
    expect(bheUrls.length).toBeGreaterThan(0);
    expect(bpstUrls.length).toBeGreaterThan(0);
    for (const url of bheUrls) {
      expect(url).toContain('TMBCOC_InformeMensualBheRec.cgi'); // RECIBIDAS CGI, every call
      expect(url).not.toContain('TMBCOC_InformeMensualBhe.cgi?'); // EMITIDAS CGI, never
    }
    for (const url of bpstUrls) {
      expect(url).toContain('bte_indiv_cons?1'); // EMITIDAS bootstrap (CNTR=1), by design
      expect(url).not.toContain('bte_indiv_cons?2'); // never RECIBIDAS — not wired in (ADR-029)
    }
  });

  it('reconciles ONLY retencionReceptor against F29 código 151 — never the emisor side', async () => {
    // We withheld 100.000; the contractor withheld 777.777 for themselves. Only ours counts.
    const rt = makeRuntime({
      bte: { '2025-03': bteMap({ receptor: 100000, emisor: 777777, total: 1000000 }) },
      f29: { '202503': f29Env(100000) },
    });
    await seed(rt);

    const res = await honorariosAnual(rt, { anio: '2025' });

    expect(res.reconciliacion.retencionBhe).toBe(100000); // emisor side excluded
    expect(res.reconciliacion.retencionF29).toBe(100000);
    expect(res.reconciliacion.delta).toBe(0);
    expect(res.reconciliacion.cuadra).toBe(true);
    // The emisor side is still reported — just not reconciled.
    expect(res.totales.retencionEmisor).toBe(777777);
  });

  // ADR-029, live finding 2026-07-29 (a real taxpayer account): a persistent gap between BHE
  // recibidas and F29 código 151 was traced to boletas the company EMITS on behalf of low-skilled
  // workers (BPST) — a real, additional retención source `honorariosAnual` never read before.
  it('adds BPST EMITIDAS retenido to the reconciled total against F29 código 151 (ADR-029)', async () => {
    const rt = makeRuntime({
      bte: { '2025-03': bteMap({ receptor: 162457, emisor: 0, total: 1500000 }) },
      bpst: { '2025-03': bpstMap({ retenido: 164368, brutos: 1264368 }) },
      // Exact live precedent (2023-09): BHE 162.457 + BPST 164.368 = 326.825.
      f29: { '202503': f29Env(326825) },
    });
    await seed(rt);

    const res = await honorariosAnual(rt, { anio: '2025' });

    expect(res.meses[2]).toMatchObject({
      periodo: '2025-03',
      retencionReceptor: 162457,
      bpstRetenido: 164368,
      f29Retencion: 326825,
      delta: 0,
    });
    expect(res.reconciliacion.cuadra).toBe(true); // would be false (-164.368) without BPST
    expect(res.totales.bpstRetenido).toBe(164368);
  });

  it('a month with NO BPST activity (the overwhelming majority of taxpayers) is numerically identical to pre-ADR-029 behaviour', async () => {
    const rt = makeRuntime({
      bte: { '2025-03': bteMap({ receptor: 100000, emisor: 0, total: 1000000 }) },
      f29: { '202503': f29Env(100000) },
      // No `bpst` override → every month gets the default 0-boleta BPST report.
    });
    await seed(rt);

    const res = await honorariosAnual(rt, { anio: '2025' });

    expect(res.meses[2]).toMatchObject({ bpstRetenido: 0, delta: 0 });
    expect(res.reconciliacion.cuadra).toBe(true);
  });

  it('a BpstError for one month is captured in mesesConError — the rest of the year still returns', async () => {
    const rt = makeRuntime({
      bte: { '2025-03': bteMap({ receptor: 100000, emisor: 0, total: 1000000 }) },
      bpst: { '2025-03': '<html>not a BPST report</html>' }, // triggers BpstError for this month
      f29: { '202503': f29Env(100000) },
    });
    await seed(rt);

    const res = await honorariosAnual(rt, { anio: '2025' });

    expect(res.mesesConError.map((e) => e.periodo)).toEqual(['2025-03']);
    expect(res.meses).toHaveLength(12); // the year still returns in full
    expect(res.meses[2]).toMatchObject({ periodo: '2025-03', retencionReceptor: null });
  });

  it('ignores código 153 (Art. 48 directors fees) when totalling the declared retención', async () => {
    const rt = makeRuntime({
      bte: { '2025-03': bteMap({ receptor: 50000, emisor: 0, total: 500000 }) },
      // 151 = 50.000 matches; 153 = 900.000 must NOT be added in.
      f29: { '202503': f29Env(50000, 900000) },
    });
    await seed(rt);

    const res = await honorariosAnual(rt, { anio: '2025' });

    expect(res.reconciliacion.retencionF29).toBe(50000);
    expect(res.reconciliacion.cuadra).toBe(true);
  });

  it('pairs commercial year N with the F22 of año tributario N+1', async () => {
    const rt = makeRuntime();
    await seed(rt);

    const res = await honorariosAnual(rt, { anio: '2025' });

    expect(res.anioComercial).toBe('2025');
    expect(res.anioTributario).toBe('2026');
    expect(res.meses).toHaveLength(12);
    expect(res.meses[0]?.periodo).toBe('2025-01');
    expect(res.meses[11]?.periodo).toBe('2025-12');
  });

  it('surfaces the F22 honorarios códigos INCLUDING the unmapped 1412, and computes no delta for them', async () => {
    const rt = makeRuntime();
    await seed(rt);

    const res = await honorariosAnual(rt, { anio: '2025' });

    const codigos = res.f22.codigos.map((c) => c.codigo);
    expect(codigos).toContain('467');
    expect(codigos).toContain('492');
    expect(codigos).toContain('1412'); // named by B92 though absent from our taxonomy
    expect(codigos).not.toContain('999'); // unrelated noise stays out
    const c1412 = res.f22.codigos.find((c) => c.codigo === '1412')!;
    expect(c1412.enTaxonomia).toBe(false); // flagged as unmapped, surfaced verbatim
    expect(c1412.valor).toBe(9500000);
    expect(c1412.glosa).toBe('Honorarios régimen 14D Nº3');
    // We do NOT adjudicate 1412 — the reconciliation is BHE vs F29 only.
    expect(res.reconciliacion).not.toHaveProperty('deltaF22');
  });

  it('never leaks F22 identity PII through the composite', async () => {
    const rt = makeRuntime();
    await seed(rt);

    const res = await honorariosAnual(rt, { anio: '2025' });

    expect(JSON.stringify(res)).not.toContain('PII APELLIDO');
  });

  it('reports the signed per-month delta and names the months that diverge', async () => {
    const rt = makeRuntime({
      bte: {
        '2025-03': bteMap({ receptor: 100000, emisor: 0, total: 1000000 }),
        '2025-07': bteMap({ receptor: 80000, emisor: 0, total: 800000 }),
      },
      // March under-declared by 10.000; July matches.
      f29: { '202503': f29Env(90000), '202507': f29Env(80000) },
    });
    await seed(rt);

    const res = await honorariosAnual(rt, { anio: '2025' });

    expect(res.meses[2]).toMatchObject({ periodo: '2025-03', delta: 10000 });
    expect(res.meses[6]).toMatchObject({ periodo: '2025-07', delta: 0 });
    expect(res.reconciliacion.cuadra).toBe(false);
    expect(res.reconciliacion.mesesDescuadrados).toEqual(['2025-03']);
  });

  it('treats a month with no propuesta as null, never 0', async () => {
    const rt = makeRuntime({
      bte: { '2025-03': bteMap({ receptor: 100000, emisor: 0, total: 1000000 }) },
      f29: { '202503': NO_PROPUESTA },
    });
    await seed(rt);

    const res = await honorariosAnual(rt, { anio: '2025' });

    expect(res.meses[2]?.f29Retencion).toBeNull();
    expect(res.meses[2]?.delta).toBeNull(); // null propagates, never coerced to 0
    expect(res.reconciliacion.cuadra).toBe(false);
  });

  it('opens exactly ONE session for the whole year', async () => {
    const rt = makeRuntime();
    await seed(rt);

    await honorariosAnual(rt, { anio: '2025' });

    expect(driverOf(rt).restoreCalls).toBe(1);
  });

  it('rejects a representing operate pointer BEFORE opening a session (ADR-005)', async () => {
    const rt = makeRuntime();
    await seed(rt);
    await setOperatingRut(rt.store, EMPRESA);

    await expect(honorariosAnual(rt, { anio: '2025' })).rejects.toThrow(/session-keyed/i);
    expect(driverOf(rt).restoreCalls).toBe(0);
  });

  it('writes one audit receipt with the year and balance flag — and no montos', async () => {
    const rt = makeRuntime({
      bte: { '2025-03': bteMap({ receptor: 100000, emisor: 0, total: 1000000 }) },
      f29: { '202503': f29Env(100000) },
    });
    await seed(rt);

    await honorariosAnual(rt, { anio: '2025' });

    const a = entries(rt).at(-1)!;
    expect(a).toMatchObject({
      action: 'honorarios_anual',
      result: 'ok',
      rut: SELF,
      period: '2025',
    });
    expect(a['cuadra']).toBe(true);
    expect(JSON.stringify(a)).not.toContain('100000');
  });

  it('validates the año locally before opening a session', async () => {
    const rt = makeRuntime();
    await seed(rt);

    await expect(honorariosAnual(rt, { anio: 'nope' })).rejects.toThrow(ValidationError);
    expect(driverOf(rt).restoreCalls).toBe(0);
  });

  it('raises NotAuthenticated with no session, and audits the failure', async () => {
    const rt = makeRuntime();

    await expect(honorariosAnual(rt, { anio: '2025' })).rejects.toThrow(NotAuthenticatedError);
    expect(entries(rt).at(-1)).toMatchObject({ action: 'honorarios_anual', result: 'failed' });
  });
});
