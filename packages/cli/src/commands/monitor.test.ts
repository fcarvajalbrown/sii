import { describe, it, expect } from 'vitest';
import { HOSTS, NotAuthenticatedError, testing, type Runtime } from '@dostertags/sii-core';
import { datos, run, runJson } from '../test-helpers.js';

describe('sii monitor command (fake runtime, no SII)', () => {
  const SECRET_GLOSA = 'GLOSA LIBRE CON NOMBRE DE FUNCIONARIO';

  const decls = {
    metaData: { errors: [] },
    data: {
      decls: [{ folio: '900', vgte: 'S', codConc: 'C1', fecIng: '20/04/2026' }],
      glosas: [{ codConclusion: 'C1', descripcion: 'Declaración vigente' }],
    },
  };

  /** `f29` maps `annoMes` → whether a declaración exists (missing ⇒ exists). */
  function makeMonitorRuntime(
    opts: { obs?: string[]; f29?: Record<string, boolean> } = {},
  ): Runtime {
    const requestJson = (url: string, options?: unknown): unknown => {
      if (url.includes('buscaDeclVgte')) return decls;
      if (url.includes('situacionObservacion')) {
        return {
          metaData: { errors: [] },
          data: (opts.obs ?? []).map((c) => ({ codigo: c, descripcion: SECRET_GLOSA, url: null })),
        };
      }
      if (url.includes('buscaEventos')) return { metaData: { errors: [] }, data: [] };
      if (url.includes('getDeclaracionConEstados')) {
        const d = (options as { body?: { data?: Record<string, unknown> } })?.body?.data ?? {};
        const key = `${String(d['anno'] ?? '')}${String(d['mes'] ?? '')}`;
        const tiene = opts.f29?.[key] ?? true;
        return {
          metaData: { errors: [] },
          data: tiene ? [{ estadoDeclaracionId: 1, estado: 'Vigente', folio: 9 }] : [],
        };
      }
      throw new Error(`unexpected url: ${url}`);
    };
    return {
      clock: new testing.FixedClock(new Date('2026-07-25T12:00:00Z')),
      audit: new testing.RecordingAuditSink(),
      store: new testing.InMemoryKeyValueStore(),
      portal: new testing.FakePortalDriver({
        loginSession: { landingUrl: HOSTS.miSii, evaluate: datos, storageState: { cookies: [] } },
        restoreSession: {
          landingUrl: HOSTS.miSii,
          evaluate: datos,
          requestJson,
          requestText: () => '//OK[0,[],0,7]',
          cookies: { TOKEN: 't' },
        },
      }),
    };
  }

  it('announces the baseline on the first run instead of crying wolf', async () => {
    const rt = makeMonitorRuntime({ obs: ['F121'] });
    await run(rt, 'auth', 'login');

    const out = await run(rt, 'monitor', '--anios', '1', '--meses', '1', '--human');

    expect(out).toContain('línea base');
    expect(out).toContain('Sin hallazgos'); // a pre-existing observación is not "change"
  });

  it('still reports a missing F29 month on the first run — state, not change', async () => {
    // Clock 2026-07-25: 2026-07 is open (never flagged), 2026-06 is late.
    const rt = makeMonitorRuntime({ f29: { '202607': false, '202606': false } });
    await run(rt, 'auth', 'login');

    const out = await run(rt, 'monitor', '--anios', '1', '--meses', '2', '--human');

    expect(out).toContain('2026-06');
    expect(out).not.toContain('2026-07');
  });

  it('emits the sweep as JSON by default, with the baseline flag (ADR-012)', async () => {
    const rt = makeMonitorRuntime({ obs: ['F121'] });
    await run(rt, 'auth', 'login');

    const json = (await runJson(rt, 'monitor', '--anios', '1', '--meses', '1')) as {
      baseline: boolean;
      cambios: unknown[];
      resumen: { observaciones: number };
    };

    expect(json.baseline).toBe(true);
    expect(json.cambios).toEqual([]);
    expect(json.resumen.observaciones).toBe(1);
  });

  it('--dry-run says so and leaves the baseline unset', async () => {
    const rt = makeMonitorRuntime({ obs: ['F121'] });
    await run(rt, 'auth', 'login');

    const out = await run(rt, 'monitor', '--anios', '1', '--meses', '1', '--dry-run', '--human');

    expect(out).toContain('dry-run');
    expect(await rt.store.read('monitor')).toBeNull();
  });

  it('requires a session (NotAuthenticated → exit 2)', async () => {
    const rt = makeMonitorRuntime(); // no login
    await expect(run(rt, 'monitor')).rejects.toBeInstanceOf(NotAuthenticatedError);
  });
});
