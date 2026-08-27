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
import { ivaMensual } from './iva.js';

// Synthetic data only (no SII, no real PII): persona 20.000.042-0, empresa 77.777.777-7.
const SELF = '20000042-0';
const EMPRESA = '77777777-7';

/** RCV resumen VENTA — IVA débito 19.000 + 1.000 = 20.000 across two DTE types. */
const VENTA_ENV = {
  respEstado: { codRespuesta: 0 },
  totDocRes: 3,
  data: [
    {
      rsmnTipoDocInteger: 33,
      dcvNombreTipoDoc: 'Factura electrónica',
      rsmnTotDoc: 2,
      rsmnMntNeto: 100000,
      rsmnMntExe: 0,
      rsmnMntIVA: 19000,
      rsmnMntTotal: 119000,
    },
    {
      rsmnTipoDocInteger: 39,
      dcvNombreTipoDoc: 'Boleta electrónica',
      rsmnTotDoc: 1,
      rsmnMntNeto: 5263,
      rsmnMntExe: 0,
      rsmnMntIVA: 1000,
      rsmnMntTotal: 6263,
    },
  ],
};

/** RCV resumen COMPRA — IVA crédito 15.000. */
const COMPRA_ENV = {
  respEstado: { codRespuesta: 0 },
  totDocRes: 1,
  data: [
    {
      rsmnTipoDocInteger: 33,
      dcvNombreTipoDoc: 'Factura electrónica',
      rsmnTotDoc: 1,
      rsmnMntNeto: 78947,
      rsmnMntExe: 0,
      rsmnMntIVA: 15000,
      rsmnMntTotal: 93947,
    },
  ],
};

/** F29 propuesta. 538 = TOTAL DÉBITOS, 537 = TOTAL CRÉDITOS (observed, f29-codigos.ts). */
const f29Env = (debito: number, credito: number) => ({
  metaData: { errors: null },
  data: {
    tipopropuesta: 40,
    estado: 0,
    listCodPropuestos: [
      { codigo: '538', valor: String(debito) },
      { codigo: '537', valor: String(credito) },
      { codigo: '020', valor: '19' },
    ],
    listCodAdministrativos: [{ codigo: '9114', valor: '1097' }],
    // Identity PII lives in a separate array — must never surface through the composite.
    listCodBase: [{ codigo: '05', valor: 'PII NAME' }],
  },
});

/** One fake session routed across the three facades the composite calls: the two RCV resumen
 *  POSTs are distinguished by the body's `operacion`, the F29 propuesta by its URL. An
 *  unexpected URL throws, so a composite that reached for a facade it shouldn't fails loudly. */
function makeRuntime(opts: { compra?: unknown; venta?: unknown; f29?: unknown }): Runtime {
  const requestJson = (url: string, options?: JsonRequest): unknown => {
    if (url.includes('getResumen')) {
      const body = options?.body as { data?: { operacion?: string } } | undefined;
      return body?.data?.operacion === 'VENTA' ? (opts.venta ?? null) : (opts.compra ?? null);
    }
    if (url.includes('getDeclaracionConCondicionesYTipoPropuesta')) return opts.f29 ?? null;
    throw new Error(`unexpected URL in iva composite: ${url}`);
  };
  return {
    clock: new FixedClock(new Date('2026-06-27T12:00:00Z')),
    audit: new RecordingAuditSink(),
    store: new InMemoryKeyValueStore(),
    portal: new FakePortalDriver({ restoreSession: { requestJson, cookies: { TOKEN: 't' } } }),
  };
}

async function seed(runtime: Runtime): Promise<void> {
  await writeSession(runtime.store, { rut: SELF, cookies: ['c'], savedAt: '2026-06-27T12:00:00Z' });
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
const driver = (rt: Runtime) => rt.portal as FakePortalDriver;
const clock = (rt: Runtime) => rt.clock as FixedClock;

describe('ivaMensual composite (fakes, no SII)', () => {
  it('reconciles RCV IVA against F29 códigos 538/537 and balances when they agree', async () => {
    const rt = makeRuntime({ compra: COMPRA_ENV, venta: VENTA_ENV, f29: f29Env(20000, 15000) });
    await seed(rt);

    const res = await ivaMensual(rt, { periodo: '2026-06' });

    expect(res).toMatchObject({ rut: SELF, periodo: '2026-06', fuente: 'propuesta' });
    // Débito = IVA on VENTAS (19.000 + 1.000); crédito = IVA on COMPRAS (15.000).
    expect(res.reconciliacion).toEqual({
      debitoRcv: 20000,
      debitoF29: 20000,
      debitoCodigo: '538',
      deltaDebito: 0,
      creditoRcv: 15000,
      creditoF29: 15000,
      creditoCodigo: '537',
      deltaCredito: 0,
      cuadraDebito: true,
      cuadraCredito: true,
      cuadra: true,
    });
    expect(res.ventas.iva).toBe(20000);
    expect(res.ventas.documentos).toBe(3);
    expect(res.compras.iva).toBe(15000);
    expect(res.f29).toMatchObject({ tienePropuesta: true, debito: 20000, credito: 15000 });
  });

  it('keeps the per-DTE-type breakdown on both sides so a mismatch can be located', async () => {
    const rt = makeRuntime({ compra: COMPRA_ENV, venta: VENTA_ENV, f29: f29Env(20000, 15000) });
    await seed(rt);

    const res = await ivaMensual(rt, { periodo: '2026-06' });

    expect(res.ventas.porTipo).toHaveLength(2);
    expect(res.ventas.porTipo[0]).toMatchObject({
      codigoTipoDoc: '33',
      descripcion: 'Factura electrónica',
      montoIva: 19000,
    });
    expect(res.compras.porTipo).toHaveLength(1);
  });

  it('reports the signed delta and cuadra:false when the ledger disagrees with the propuesta', async () => {
    // F29 claims 1.000 MORE débito and 500 LESS crédito than the ledger shows.
    const rt = makeRuntime({ compra: COMPRA_ENV, venta: VENTA_ENV, f29: f29Env(21000, 14500) });
    await seed(rt);

    const res = await ivaMensual(rt, { periodo: '2026-06' });

    expect(res.reconciliacion.deltaDebito).toBe(-1000); // RCV - F29
    expect(res.reconciliacion.deltaCredito).toBe(500);
    expect(res.reconciliacion.cuadra).toBe(false);
  });

  it('opens exactly ONE session for all three POSTs (the whole point of the composite)', async () => {
    const rt = makeRuntime({ compra: COMPRA_ENV, venta: VENTA_ENV, f29: f29Env(20000, 15000) });
    await seed(rt);

    await ivaMensual(rt, { periodo: '2026-06' });

    expect(driver(rt).restoreCalls).toBe(1);
  });

  it('paces every POST after the first through the Clock seam (ADR-004)', async () => {
    const rt = makeRuntime({ compra: COMPRA_ENV, venta: VENTA_ENV, f29: f29Env(20000, 15000) });
    await seed(rt);

    await ivaMensual(rt, { periodo: '2026-06' });

    // 3 POSTs → 2 paced gaps, at 1000/rateLimitRps = 1000 ms.
    expect(clock(rt).slept).toEqual([1000, 1000]);
  });

  it('rejects a representing operate pointer BEFORE opening a session (ADR-005)', async () => {
    const rt = makeRuntime({ compra: COMPRA_ENV, venta: VENTA_ENV, f29: f29Env(20000, 15000) });
    await seed(rt);
    await setOperatingRut(rt.store, EMPRESA);

    await expect(ivaMensual(rt, { periodo: '2026-06' })).rejects.toThrow(/session-keyed/i);
    expect(driver(rt).restoreCalls).toBe(0); // no session was ever opened
  });

  it('treats a month with no propuesta as INDETERMINABLE, not a mismatch', async () => {
    // `data:null` with no errors ⇒ SII has no propuesta for the período (clean negative).
    const rt = makeRuntime({
      compra: COMPRA_ENV,
      venta: VENTA_ENV,
      f29: { metaData: { errors: null }, data: null },
    });
    await seed(rt);

    const res = await ivaMensual(rt, { periodo: '2026-06' });

    expect(res.f29.tienePropuesta).toBe(false);
    expect(res.reconciliacion.debitoF29).toBeNull();
    expect(res.reconciliacion.deltaDebito).toBeNull(); // never coerce null to 0
    // The ledger shows movement on both sides but SII gave nothing to compare against, so the
    // verdict is UNKNOWN. Reporting `false` here would accuse the books of a mismatch that has
    // not been shown (live-validation finding, 2026-07-26).
    expect(res.reconciliacion.cuadra).toBeNull();
    expect(res.ventas.iva).toBe(20000); // the ledger half still returns
  });

  it('treats an empty RCV month (SII code 3, sin movimientos) as zero rows, not an error', async () => {
    const empty = { respEstado: { codRespuesta: 3, msgeRespuesta: null }, data: [] };
    const rt = makeRuntime({ compra: empty, venta: empty, f29: f29Env(0, 0) });
    await seed(rt);

    const res = await ivaMensual(rt, { periodo: '2026-06' });

    expect(res.ventas.porTipo).toEqual([]);
    expect(res.ventas.iva).toBe(0);
    expect(res.reconciliacion.cuadra).toBe(true); // 0 vs 0 balances
  });

  it('never leaks the propuesta identity PII (listCodBase) into the result', async () => {
    const rt = makeRuntime({ compra: COMPRA_ENV, venta: VENTA_ENV, f29: f29Env(20000, 15000) });
    await seed(rt);

    const res = await ivaMensual(rt, { periodo: '2026-06' });

    expect(JSON.stringify(res)).not.toContain('PII NAME');
  });

  it('writes one audit receipt with the period and whether it balanced — and no montos', async () => {
    const rt = makeRuntime({ compra: COMPRA_ENV, venta: VENTA_ENV, f29: f29Env(21000, 15000) });
    await seed(rt);

    await ivaMensual(rt, { periodo: '2026-06' });

    const a = entries(rt).at(-1)!;
    expect(a).toMatchObject({ action: 'iva_mensual', result: 'ok', rut: SELF, period: '202606' });
    expect(a['cuadra']).toBe(false);
    // The receipt is a receipt: no amount from either side rides along (ADR-006).
    const dump = JSON.stringify(a);
    expect(dump).not.toContain('21000');
    expect(dump).not.toContain('15000');
  });

  // --- Live-validation findings, 2026-07-26 (ADR-022 revision) ----------------------------
  // Observed against a real propuesta: SII's propuesta carries COMPONENT códigos, not the
  // computed totals — `totales` came back EMPTY, so 538/537 were absent while 511 held the
  // IVA-crédito figure exactly matching the RCV. The old code reported `cuadra:false` for that,
  // which reads as "your books disagree" when the truth is "SII gave no such number".

  it('falls back to código 511 for crédito when the propuesta has no 537', async () => {
    // A propuesta with COMPONENT códigos only — the observed real shape.
    const componentes = {
      metaData: { errors: null },
      data: {
        tipopropuesta: 40,
        estado: 0,
        listCodPropuestos: [
          { codigo: '511', valor: '15000' }, // IVA por documentos electrónicos recibidos
          { codigo: '562', valor: '227702' },
        ],
      },
    };
    const rt = makeRuntime({ compra: COMPRA_ENV, venta: VENTA_ENV, f29: componentes });
    await seed(rt);

    const res = await ivaMensual(rt, { periodo: '2026-06' });

    expect(res.reconciliacion.creditoF29).toBe(15000);
    expect(res.reconciliacion.creditoCodigo).toBe('511');
    expect(res.reconciliacion.deltaCredito).toBe(0); // RCV crédito is 15.000 → matches
  });

  it('prefers the TOTAL código when the propuesta does carry it', async () => {
    const rt = makeRuntime({ compra: COMPRA_ENV, venta: VENTA_ENV, f29: f29Env(20000, 15000) });
    await seed(rt);

    const res = await ivaMensual(rt, { periodo: '2026-06' });

    expect(res.reconciliacion.creditoCodigo).toBe('537');
    expect(res.reconciliacion.debitoCodigo).toBe('538');
  });

  it('reports cuadra=null (indeterminable), NOT false, when SII gave no comparable figure', async () => {
    // No 538 and no observed débito component → the débito side cannot be compared, and the
    // ledger DOES show débito (20.000), so we must not claim a mismatch we cannot substantiate.
    const sinDebito = {
      metaData: { errors: null },
      data: {
        tipopropuesta: 40,
        estado: 0,
        listCodPropuestos: [{ codigo: '511', valor: '15000' }],
      },
    };
    const rt = makeRuntime({ compra: COMPRA_ENV, venta: VENTA_ENV, f29: sinDebito });
    await seed(rt);

    const res = await ivaMensual(rt, { periodo: '2026-06' });

    expect(res.reconciliacion.debitoF29).toBeNull();
    expect(res.reconciliacion.debitoCodigo).toBeNull();
    expect(res.reconciliacion.cuadraDebito).toBeNull(); // indeterminable, not a discrepancy
    expect(res.reconciliacion.cuadra).toBeNull();
  });

  // P3 (2026-08-05, live investigation against six real months with ventas, a real taxpayer account): a
  // débito componente (código 502) WAS found — it matches código-33 ventas IVA exactly — but it
  // is RAW, not netted for Notas de Crédito emitidas, and no reliable NC-IVA componente was
  // identified to net it with. Wiring it in naively would reproduce, on the débito side, the
  // exact raw-vs-netted bug `TIPOS_REVERSA` fixed on crédito (ADR-022 revision). This pins that
  // `502` staying OUT of `COD_DEBITO_FALLBACK` is deliberate, not an oversight — a future edit
  // must not "helpfully" wire it back in without solving the netting problem first.
  it('does NOT fall back to código 502 for débito — it is unnetted, wiring it would misreport', async () => {
    const conCandidatoNoSeguro = {
      metaData: { errors: null },
      data: {
        tipopropuesta: 40,
        estado: 0,
        listCodPropuestos: [
          { codigo: '511', valor: '15000' },
          { codigo: '502', valor: '20000' }, // el candidato rechazado — ver comentario en iva.ts
        ],
      },
    };
    const rt = makeRuntime({ compra: COMPRA_ENV, venta: VENTA_ENV, f29: conCandidatoNoSeguro });
    await seed(rt);

    const res = await ivaMensual(rt, { periodo: '2026-06' });

    expect(res.reconciliacion.debitoF29).toBeNull();
    expect(res.reconciliacion.debitoCodigo).toBeNull();
    expect(res.reconciliacion.cuadraDebito).toBeNull(); // sigue indeterminable, no un match espurio
  });

  it('treats absent-vs-zero as balancing — nothing against nothing is not a discrepancy', async () => {
    // The real observed case: no ventas at all, and no débito código in the propuesta.
    const empty = { respEstado: { codRespuesta: 3, msgeRespuesta: null }, data: [] };
    const soloCredito = {
      metaData: { errors: null },
      data: {
        tipopropuesta: 40,
        estado: 0,
        listCodPropuestos: [{ codigo: '511', valor: '15000' }],
      },
    };
    const rt = makeRuntime({ compra: COMPRA_ENV, venta: empty, f29: soloCredito });
    await seed(rt);

    const res = await ivaMensual(rt, { periodo: '2026-06' });

    expect(res.ventas.iva).toBe(0);
    expect(res.reconciliacion.cuadraDebito).toBe(true); // 0 vs absent ⇒ agree
    expect(res.reconciliacion.cuadraCredito).toBe(true);
    expect(res.reconciliacion.cuadra).toBe(true);
  });

  it('still reports a genuine mismatch as false, not null', async () => {
    const rt = makeRuntime({ compra: COMPRA_ENV, venta: VENTA_ENV, f29: f29Env(21000, 15000) });
    await seed(rt);

    const res = await ivaMensual(rt, { periodo: '2026-06' });

    expect(res.reconciliacion.cuadraDebito).toBe(false);
    expect(res.reconciliacion.deltaDebito).toBe(-1000);
    expect(res.reconciliacion.cuadra).toBe(false); // a real discrepancy outranks indeterminable
  });

  // --- ADR-027 read-through cache ---------------------------------------------------------
  // The fixed clock is 2026-06-27, so '2026-06' is the CURRENT month and '2026-03' is closed.

  it('caches a CLOSED period — the second read opens no browser at all', async () => {
    const rt = makeRuntime({ compra: COMPRA_ENV, venta: VENTA_ENV, f29: f29Env(20000, 15000) });
    await seed(rt);

    const first = await ivaMensual(rt, { periodo: '2026-03' });
    expect(first.cached).toBe(false);
    expect(driver(rt).restoreCalls).toBe(1);

    const second = await ivaMensual(rt, { periodo: '2026-03' });
    expect(second.cached).toBe(true);
    expect(second.reconciliacion).toEqual(first.reconciliacion);
    // The whole point: no second session, so no second Chromium.
    expect(driver(rt).restoreCalls).toBe(1);
  });

  it('NEVER caches the current, still-open month', async () => {
    const rt = makeRuntime({ compra: COMPRA_ENV, venta: VENTA_ENV, f29: f29Env(20000, 15000) });
    await seed(rt);

    const a = await ivaMensual(rt, { periodo: '2026-06' }); // the open period
    const b = await ivaMensual(rt, { periodo: '2026-06' });

    expect(a.cached).toBe(false);
    expect(b.cached).toBe(false);
    expect(driver(rt).restoreCalls).toBe(2); // read live both times
  });

  it('refresh re-reads a closed period from SII', async () => {
    const rt = makeRuntime({ compra: COMPRA_ENV, venta: VENTA_ENV, f29: f29Env(20000, 15000) });
    await seed(rt);

    await ivaMensual(rt, { periodo: '2026-03' });
    const forced = await ivaMensual(rt, { periodo: '2026-03', refresh: true });

    expect(forced.cached).toBe(false);
    expect(driver(rt).restoreCalls).toBe(2);
  });

  it('records on the receipt whether SII was actually consulted', async () => {
    const rt = makeRuntime({ compra: COMPRA_ENV, venta: VENTA_ENV, f29: f29Env(20000, 15000) });
    await seed(rt);

    await ivaMensual(rt, { periodo: '2026-03' });
    expect(entries(rt).at(-1)).toMatchObject({ action: 'iva_mensual', cached: false });

    await ivaMensual(rt, { periodo: '2026-03' });
    // A receipt must never imply a portal read that did not happen (ADR-027).
    expect(entries(rt).at(-1)).toMatchObject({ action: 'iva_mensual', cached: true });
  });

  it('validates the período locally before opening a session', async () => {
    const rt = makeRuntime({});
    await seed(rt);

    await expect(ivaMensual(rt, { periodo: 'no-es-periodo' })).rejects.toThrow(ValidationError);
    expect(driver(rt).restoreCalls).toBe(0);
  });

  it('raises NotAuthenticated when there is no session, and audits the failure', async () => {
    const rt = makeRuntime({});
    // no seed → no stored session

    await expect(ivaMensual(rt, { periodo: '2026-06' })).rejects.toThrow(NotAuthenticatedError);
    expect(entries(rt).at(-1)).toMatchObject({ action: 'iva_mensual', result: 'failed' });
  });

  // --- Notas de Crédito netting (live-validation finding, 2026-07-28) ---------------------
  // A real audit against a second real taxpayer account found `cuadraCredito:false` in 15 of
  // 16 real months (2025-03 to 2026-06), ALWAYS by exactly 2x that month's Nota de Crédito
  // Electrónica (tipo 61) IVA received in compras — including the one month with zero NC,
  // where the delta was exactly zero. `ladoFrom` was summing EVERY row's montoIva, including
  // reversal documents (NC) that SII's own 511 nets out. See `docs/BACKLOG.md` §3.5 and
  // ADR-022's revision note. The débito/ventas-side netting below is inferred from the same
  // accounting fact, NOT independently confirmed against a real 538 (that código was never
  // observed for this taxpayer — see the caveat on `TIPOS_REVERSA` in `tasks/iva.ts`).

  /** COMPRA with a factura (33, IVA 15.000) AND a Nota de Crédito Electrónica received
   *  (61, IVA 5.000) — the observed real shape. A NC recibida reverses part of a prior
   *  purchase, so it must SUBTRACT from the side's crédito, not add to it. */
  const COMPRA_CON_NC_ENV = {
    respEstado: { codRespuesta: 0 },
    totDocRes: 2,
    data: [
      {
        rsmnTipoDocInteger: 33,
        dcvNombreTipoDoc: 'Factura Electrónica',
        rsmnTotDoc: 1,
        rsmnMntNeto: 78947,
        rsmnMntExe: 0,
        rsmnMntIVA: 15000,
        rsmnMntTotal: 93947,
      },
      {
        rsmnTipoDocInteger: 61,
        dcvNombreTipoDoc: 'Nota de Crédito Electrónica',
        rsmnTotDoc: 1,
        rsmnMntNeto: 26315,
        rsmnMntExe: 0,
        rsmnMntIVA: 5000,
        rsmnMntTotal: 31315,
      },
    ],
  };

  /** VENTA mirrors the same shape: a factura (33, IVA 20.000) and a Nota de Crédito
   *  Electrónica ISSUED (61, IVA 3.000) reversing part of a prior sale. */
  const VENTA_CON_NC_ENV = {
    respEstado: { codRespuesta: 0 },
    totDocRes: 2,
    data: [
      {
        rsmnTipoDocInteger: 33,
        dcvNombreTipoDoc: 'Factura Electrónica',
        rsmnTotDoc: 1,
        rsmnMntNeto: 105263,
        rsmnMntExe: 0,
        rsmnMntIVA: 20000,
        rsmnMntTotal: 125263,
      },
      {
        rsmnTipoDocInteger: 61,
        dcvNombreTipoDoc: 'Nota de Crédito Electrónica',
        rsmnTotDoc: 1,
        rsmnMntNeto: 15789,
        rsmnMntExe: 0,
        rsmnMntIVA: 3000,
        rsmnMntTotal: 18789,
      },
    ],
  };

  it('nets a Nota de Crédito recibida OUT of compras.iva instead of adding it', async () => {
    const rt = makeRuntime({
      compra: COMPRA_CON_NC_ENV,
      venta: VENTA_ENV,
      f29: f29Env(20000, 10000), // SII's own 537 already nets the NC: 15.000 - 5.000
    });
    await seed(rt);

    const res = await ivaMensual(rt, { periodo: '2026-06' });

    // 15.000 (factura) - 5.000 (NC) = 10.000, matching SII's own crédito total exactly.
    expect(res.compras.iva).toBe(10000);
    expect(res.compras.neto).toBe(78947 - 26315);
    expect(res.compras.total).toBe(93947 - 31315);
    expect(res.reconciliacion.creditoRcv).toBe(10000);
    expect(res.reconciliacion.cuadraCredito).toBe(true);
    expect(res.reconciliacion.deltaCredito).toBe(0);
  });

  it('nets a Nota de Crédito emitida OUT of ventas.iva the same way', async () => {
    const rt = makeRuntime({
      compra: COMPRA_ENV,
      venta: VENTA_CON_NC_ENV,
      f29: f29Env(17000, 15000), // 20.000 - 3.000 = 17.000
    });
    await seed(rt);

    const res = await ivaMensual(rt, { periodo: '2026-06' });

    expect(res.ventas.iva).toBe(17000);
    expect(res.reconciliacion.debitoRcv).toBe(17000);
    expect(res.reconciliacion.cuadraDebito).toBe(true);
  });

  it('keeps the per-DTE-type breakdown at its RAW (un-netted) magnitude for both types', async () => {
    // porTipo exists so a contador can SEE where a mismatch is — netting it away would hide
    // the very row that explains the total.
    const rt = makeRuntime({ compra: COMPRA_CON_NC_ENV, venta: VENTA_ENV, f29: f29Env(20000, 10000) });
    await seed(rt);

    const res = await ivaMensual(rt, { periodo: '2026-06' });

    const nc = res.compras.porTipo.find((t) => t.codigoTipoDoc === '61');
    expect(nc).toMatchObject({ montoIva: 5000, montoNeto: 26315 }); // raw, not negated
    const factura = res.compras.porTipo.find((t) => t.codigoTipoDoc === '33');
    expect(factura).toMatchObject({ montoIva: 15000 });
  });

  it('does NOT net the Nota de Crédito document COUNT — it is still one real document', async () => {
    const rt = makeRuntime({ compra: COMPRA_CON_NC_ENV, venta: VENTA_ENV, f29: f29Env(20000, 10000) });
    await seed(rt);

    const res = await ivaMensual(rt, { periodo: '2026-06' });

    // This envelope carries `totDocRes`, so `documentos` is the passthrough of SII's own
    // count, not `sumCount`'s row-sum fallback — see the next test for that path.
    expect(res.compras.documentos).toBe(2); // 1 factura + 1 NC, both counted
  });

  it('falls back to summing row counts (unaffected by netting) when SII sends no totDocRes', async () => {
    // No `totDocRes` on the envelope ⇒ `resumen.totalDocumentos` is null ⇒ `ladoFrom` must
    // fall back to `sumCount`, which — unlike `sumMonto` — must NOT subtract the NC row's count.
    const sinTotDocRes = {
      respEstado: { codRespuesta: 0 },
      data: COMPRA_CON_NC_ENV.data, // same 1 factura + 1 NC rows, no envelope-level count
    };
    const rt = makeRuntime({ compra: sinTotDocRes, venta: VENTA_ENV, f29: f29Env(20000, 10000) });
    await seed(rt);

    const res = await ivaMensual(rt, { periodo: '2026-06' });

    expect(res.compras.documentos).toBe(2); // sumCount(1 factura + 1 NC) = 2, not netted to 0
    expect(res.compras.iva).toBe(10000); // the monetary side still nets correctly
  });

  it('reproduces the exact real-world case: NC-only delta vanishes once netted', async () => {
    // The audited month (2025-03 shape, scaled down): a factura and a NC, where the OLD
    // (buggy) sum would report a 2x-the-NC delta against a propuesta that already nets it.
    const rt = makeRuntime({
      compra: COMPRA_CON_NC_ENV,
      venta: { respEstado: { codRespuesta: 3, msgeRespuesta: null }, data: [] },
      f29: {
        metaData: { errors: null },
        data: {
          tipopropuesta: 40,
          estado: 0,
          listCodPropuestos: [{ codigo: '511', valor: '10000' }], // SII's own net figure
        },
      },
    });
    await seed(rt);

    const res = await ivaMensual(rt, { periodo: '2026-06' });

    expect(res.reconciliacion.creditoCodigo).toBe('511');
    expect(res.reconciliacion.deltaCredito).toBe(0); // NOT 10.000 (2x the 5.000 NC), as the bug produced
    expect(res.reconciliacion.cuadraCredito).toBe(true);
  });
});
