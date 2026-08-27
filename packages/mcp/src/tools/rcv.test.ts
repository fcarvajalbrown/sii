import { describe, it, expect } from 'vitest';
import { HOSTS, testing, type Runtime } from '@dostertags/sii-core';
import { connect, datos, makeRuntime, toolText } from '../test-helpers.js';

describe('@dostertags/sii-mcp rcv tools (in-memory client, fake runtime, no SII)', () => {
  it('rcv_summary returns the curated resumen as JSON (body-RUT, read-only)', async () => {
    const env = {
      respEstado: { codRespuesta: 0 },
      totDocRes: 2,
      data: [
        {
          rsmnTipoDocInteger: 33,
          dcvNombreTipoDoc: 'Factura',
          rsmnTotDoc: 2,
          rsmnMntTotal: 119000,
        },
      ],
    };
    const runtime: Runtime = {
      clock: new testing.FixedClock(new Date('2026-06-27T12:00:00Z')),
      audit: new testing.RecordingAuditSink(),
      store: new testing.InMemoryKeyValueStore(),
      portal: new testing.FakePortalDriver({
        loginSession: { landingUrl: HOSTS.miSii, evaluate: datos, storageState: { cookies: [] } },
        restoreSession: {
          landingUrl: HOSTS.miSii,
          evaluate: datos,
          requestJson: () => env,
          cookies: { TOKEN: 't' },
        },
      }),
    };
    const client = await connect(runtime);
    await client.callTool({ name: 'auth_login', arguments: {} });

    const res = await client.callTool({ name: 'rcv_summary', arguments: { periodo: '2026-06' } });
    const parsed = JSON.parse(toolText(res)) as {
      side: string;
      periodo: string;
      rows: { codigoTipoDoc: string }[];
    };
    expect(parsed).toMatchObject({ side: 'COMPRA', periodo: '2026-06' });
    expect(parsed.rows[0]?.codigoTipoDoc).toBe('33');
    // rcv_summary is read-only.
    const { tools } = await client.listTools();
    expect(tools.find((t) => t.name === 'rcv_summary')?.annotations?.readOnlyHint).toBe(true);
  });

  // ADR-028 / F-03: the uncurated row must not reach the model unless explicitly asked for.
  it('rcv_list omits the uncurated row by default, and includes it only when raw=true', async () => {
    const env = {
      respEstado: { codRespuesta: 0 },
      data: [
        {
          detNroDoc: 7,
          detRutDoc: 77777777,
          detDvDoc: '7',
          detRznSoc: 'Proveedor SpA',
          detMntTotal: 59500,
          detCampoNoObservado: 'DATO-ANCHO-NO-CURADO',
        },
      ],
    };
    const runtime = (): Runtime => ({
      clock: new testing.FixedClock(new Date('2026-06-27T12:00:00Z')),
      audit: new testing.RecordingAuditSink(),
      store: new testing.InMemoryKeyValueStore(),
      portal: new testing.FakePortalDriver({
        loginSession: { landingUrl: HOSTS.miSii, evaluate: datos, storageState: { cookies: [] } },
        restoreSession: {
          landingUrl: HOSTS.miSii,
          evaluate: datos,
          requestJson: () => env,
          cookies: { TOKEN: 't' },
        },
      }),
    });

    const client = await connect(runtime());
    await client.callTool({ name: 'auth_login', arguments: {} });
    const plain = await client.callTool({
      name: 'rcv_list',
      arguments: { periodo: '2026-06', codigoTipoDoc: '33' },
    });
    // Curated data still reaches the model; the uncurated bulk does not.
    expect(toolText(plain)).toContain('Proveedor SpA');
    expect(toolText(plain)).not.toContain('DATO-ANCHO-NO-CURADO');

    const client2 = await connect(runtime());
    await client2.callTool({ name: 'auth_login', arguments: {} });
    const wide = await client2.callTool({
      name: 'rcv_list',
      arguments: { periodo: '2026-06', codigoTipoDoc: '33', raw: true },
    });
    expect(toolText(wide)).toContain('DATO-ANCHO-NO-CURADO');
  });

  it('declares the third-party-data exposure of raw in the tool descriptions', async () => {
    const client = await connect(makeRuntime());
    const { tools } = await client.listTools();

    for (const name of ['rcv_list', 'rcv_all']) {
      const d = tools.find((t) => t.name === name)?.description ?? '';
      expect(d).toMatch(/sin curar/i);
      expect(d).toMatch(/terceros/i); // the model is told what it is asking for
    }
  });

  it('rcv_all fans out over the resumen types and reports incomplete + rejectedTypes (read-only)', async () => {
    const resumen = {
      respEstado: { codRespuesta: 0 },
      totDocRes: 2,
      data: [
        { rsmnTipoDocInteger: 33, dcvNombreTipoDoc: 'Factura', rsmnTotDoc: 1 },
        { rsmnTipoDocInteger: 34, dcvNombreTipoDoc: 'Exenta', rsmnTotDoc: 1 },
      ],
    };
    // Route the resumen POST vs each detalle POST; type 34 is rejected (RcvError).
    const requestJson = (url: string, options?: unknown): unknown => {
      if (url.includes('getResumen')) return resumen;
      const cod = String(
        (options as { body?: { data?: { codTipoDoc?: unknown } } })?.body?.data?.codTipoDoc ?? '',
      );
      return cod === '33'
        ? { respEstado: { codRespuesta: 0 }, data: [{ detNroDoc: 1, detMntTotal: 100 }] }
        : { respEstado: { codRespuesta: 1, msgeRespuesta: 'Tipo no disponible' } };
    };
    const runtime: Runtime = {
      clock: new testing.FixedClock(new Date('2026-06-27T12:00:00Z')),
      audit: new testing.RecordingAuditSink(),
      store: new testing.InMemoryKeyValueStore(),
      portal: new testing.FakePortalDriver({
        loginSession: { landingUrl: HOSTS.miSii, evaluate: datos, storageState: { cookies: [] } },
        restoreSession: {
          landingUrl: HOSTS.miSii,
          evaluate: datos,
          requestJson,
          cookies: { TOKEN: 't' },
        },
      }),
    };
    const client = await connect(runtime);
    await client.callTool({ name: 'auth_login', arguments: {} });

    const res = await client.callTool({ name: 'rcv_all', arguments: { periodo: '2026-06' } });
    const parsed = JSON.parse(toolText(res)) as {
      incomplete: boolean;
      rejectedTypes: string[];
      docs: { codigoTipoDoc: string }[];
    };
    expect(parsed.incomplete).toBe(true);
    expect(parsed.rejectedTypes).toEqual(['34']);
    expect(parsed.docs).toHaveLength(1);
    expect(parsed.docs[0]?.codigoTipoDoc).toBe('33');

    const { tools } = await client.listTools();
    expect(tools.find((t) => t.name === 'rcv_all')?.annotations?.readOnlyHint).toBe(true);
  });
});
