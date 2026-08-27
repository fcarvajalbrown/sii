import { describe, it, expect } from 'vitest';
import {
  FakePortalDriver,
  FixedClock,
  InMemoryKeyValueStore,
  RecordingAuditSink,
} from '../adapters/fake/index.js';
import type { JsonRequest, Runtime } from '../seams/index.js';
import { initOperateState } from '../identity/index.js';
import { writeSession } from '../auth/index.js';
import { dteAcuse } from './acuse.js';

const SELF = '11111111-1';

const sdi = (data: unknown[]): unknown => ({
  respEstado: { codRespuesta: 0, msgeRespuesta: 'ok' },
  data,
});

/** Fila SDI mínima con los alias reales que `rcv.ts` proyecta. */
const fila = (o: {
  folio: number;
  recep: string | null;
  evento: string | null;
  leyenda: string | null;
  total: number;
}): Record<string, unknown> => ({
  detNroDoc: o.folio,
  detRutDoc: 22222222,
  detDvDoc: '2',
  detRznSoc: 'PROVEEDOR SPA',
  detFchDoc: '2026-06-01',
  detFecRecepcion: o.recep,
  detMntTotal: o.total,
  detEventoReceptor: o.evento,
  detEventoReceptorLeyenda: o.leyenda,
});

function makeRuntime(filas: Record<string, unknown>[]): Runtime {
  const requestJson = (url: string, _o?: JsonRequest): unknown => {
    if (url.includes('getResumen')) {
      return sdi([{ rsmnTipoDocInteger: 33, rsmnTotDoc: filas.length, rsmnTotMntTotal: 0 }]);
    }
    return sdi(filas);
  };
  return {
    clock: new FixedClock(new Date('2026-06-20T12:00:00Z')),
    audit: new RecordingAuditSink(),
    store: new InMemoryKeyValueStore(),
    portal: new FakePortalDriver({ restoreSession: { requestJson, cookies: { TOKEN: 't' } } }),
  };
}

async function seed(rt: Runtime): Promise<void> {
  await writeSession(rt.store, { rut: SELF, cookies: ['c'], savedAt: '2026-06-20T12:00:00Z' });
  await initOperateState(rt.store, {
    selfRut: SELF,
    accountType: 'persona',
    operable: [{ rut: SELF, razonSocial: 'Juan Pérez', isSelf: true }],
  });
}

describe('dteAcuse (fakes, no SII)', () => {
  it('agrupa por estado de acuse con conteo y monto, ordenado por frecuencia', async () => {
    const rt = makeRuntime([
      fila({ folio: 1, recep: '2026-06-01 10:00:00', evento: 'A', leyenda: 'No reclamado en plazo', total: 1000 }),
      fila({ folio: 2, recep: '2026-06-02 10:00:00', evento: 'A', leyenda: 'No reclamado en plazo', total: 500 }),
      fila({ folio: 3, recep: '2026-06-03 10:00:00', evento: 'C', leyenda: 'Recibo otorgado por el receptor', total: 300 }),
    ]);
    await seed(rt);

    const res = await dteAcuse(rt, { periodo: '2026-06' });

    expect(res.totalDocumentos).toBe(3);
    expect(res.grupos[0]).toEqual({
      evento: 'A',
      leyenda: 'No reclamado en plazo',
      documentos: 2,
      montoTotal: 1500,
    });
    expect(res.grupos[1]).toMatchObject({ evento: 'C', documentos: 1, montoTotal: 300 });
  });

  it('cuenta los días corridos desde la recepción', async () => {
    const rt = makeRuntime([
      // Sin evento, para que el doc caiga en `sinEvento` y se pueda inspeccionar el cálculo.
      fila({ folio: 1, recep: '2026-06-15 08:00:00', evento: null, leyenda: null, total: 10 }),
    ]);
    await seed(rt);

    const res = await dteAcuse(rt, { periodo: '2026-06' });

    // Reloj fijo en 2026-06-20; recepción 2026-06-15 ⇒ 5 días corridos.
    expect(res.sinEvento[0]?.diasDesdeRecepcion).toBe(5);
  });

  it('aísla los documentos SIN evento informado — la lista accionable', async () => {
    const rt = makeRuntime([
      fila({ folio: 1, recep: '2026-06-18 10:00:00', evento: null, leyenda: null, total: 700 }),
      fila({ folio: 2, recep: '2026-06-01 10:00:00', evento: 'A', leyenda: 'No reclamado en plazo', total: 100 }),
    ]);
    await seed(rt);

    const res = await dteAcuse(rt, { periodo: '2026-06' });

    expect(res.sinEvento).toHaveLength(1);
    expect(res.sinEvento[0]).toMatchObject({
      folio: 1,
      evento: null,
      diasDesdeRecepcion: 2, // 2026-06-18 → 2026-06-20
    });
  });

  it('desglosa `sinEvento` por tipo de documento — la salvaguarda contra el falso positivo', async () => {
    // En vivo, TODOS los documentos sin evento fueron notas de crédito / DIN, nunca facturas:
    // presentar la lista cruda como "pendientes de acuse" sería una falsa alarma (ADR-036).
    const rt = makeRuntime([
      fila({ folio: 1, recep: '2026-06-10 10:00:00', evento: null, leyenda: null, total: 100 }),
      fila({ folio: 2, recep: '2026-06-11 10:00:00', evento: null, leyenda: null, total: 200 }),
    ]);
    await seed(rt);

    const res = await dteAcuse(rt, { periodo: '2026-06' });

    // El fake sirve todo bajo el tipo 33 que reporta el resumen.
    expect(res.sinEventoPorTipo).toEqual({ '33': 2 });
    expect(Object.values(res.sinEventoPorTipo).reduce((a, b) => a + b, 0)).toBe(
      res.sinEvento.length,
    );
  });

  it('`diasDesdeRecepcion` es null cuando SII no entregó fecha interpretable', async () => {
    const rt = makeRuntime([fila({ folio: 1, recep: null, evento: null, leyenda: null, total: 1 })]);
    await seed(rt);

    const res = await dteAcuse(rt, { periodo: '2026-06' });

    expect(res.sinEvento[0]?.diasDesdeRecepcion).toBeNull();
  });

  it('un período sin compras es un resultado vacío, no un error', async () => {
    const rt = makeRuntime([]);
    await seed(rt);

    const res = await dteAcuse(rt, { periodo: '2026-06' });

    expect(res.totalDocumentos).toBe(0);
    expect(res.grupos).toEqual([]);
    expect(res.sinEvento).toEqual([]);
  });

  it('no escribe un recibo de auditoría propio — `rcvListAll` ya registró la lectura', async () => {
    const rt = makeRuntime([
      fila({ folio: 1, recep: '2026-06-01 10:00:00', evento: 'A', leyenda: 'x', total: 1 }),
    ]);
    await seed(rt);

    await dteAcuse(rt, { periodo: '2026-06' });

    const acciones = (rt.audit as RecordingAuditSink).entries.map((e) => e.action);
    expect(acciones).toContain('rcv_detalle_all');
    expect(acciones).not.toContain('dte_acuse');
  });
});
