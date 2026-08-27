// `registerCoreStrategies` — the production strategy set.
//
// Until this landed, `buildContext` composed an EMPTY registry: the nightly `evaluate` ran with
// zero strategies, so the production run reported extraction accuracy as unmeasured while the test
// suite said 1.0. Registering the shipped parsers is what makes the production number real.

import { describe, expect, it } from 'vitest';
import { instant } from '../provenance.js';
import type { FetchManifest } from '../ingest/manifest.js';
import { StrategyRegistry, registerCoreStrategies, strategyRef } from './strategy.js';

const manifest = (
  url: string,
  transport: FetchManifest['transport'] = 'requestJson',
): FetchManifest => ({
  contentHash: 'a'.repeat(64),
  url,
  transport,
  httpStatus: 200,
  retrievedAt: instant('2026-08-10T03:00:00.000Z'),
  contentType: 'application/json',
  byteLength: 0,
  durationMs: 5,
  taxpayer: 'tk-aaa',
  runId: 'run-1',
  requestFingerprint: null,
});

describe('registerCoreStrategies', () => {
  it('registers the three shipped strategies, every one of them active', () => {
    const registry = new StrategyRegistry();
    registerCoreStrategies(registry);

    expect(registry.all().map(strategyRef)).toEqual([
      'bpst-pagina@1',
      'bte-resumen@1',
      'f29-propuesta@3',
      'rcv-resumen@1',
    ]);
    // No inert versions: each id's sole registered version is the active one.
    expect(registry.candidates()).toEqual([]);
  });

  it('routes an F29 propuesta artifact to f29-propuesta', () => {
    const registry = new StrategyRegistry();
    registerCoreStrategies(registry);

    const m = manifest(
      'https://www4.sii.cl/propuestaf29ui/services/data/facadeAdapterService/getDeclaracionConCondicionesYTipoPropuesta',
    );
    expect(registry.match(m).map((s) => s.id)).toEqual(['f29-propuesta']);
  });

  it('routes BHE xml_values and BPST page artifacts to their strategies', () => {
    const registry = new StrategyRegistry();
    registerCoreStrategies(registry);

    expect(registry.match(manifest('evaluate:403d6e6c', 'goto')).map((s) => s.id)).toEqual([
      'bte-resumen',
    ]);
    expect(
      registry
        .match(manifest('https://zeus.sii.cl/cvc_cgi/bte/bte_indiv_cons2', 'requestForm'))
        .map((s) => s.id),
    ).toEqual(['bpst-pagina']);
  });

  it('parses TWO swept surfaces — F29 propuesta and RCV resumen; the rest remain a pinned gap', () => {
    // These pairings are what make a fetch+learn produce records at all. The remaining swept
    // surfaces (situación / F29 estados / F22 status) still have NO parser: extract leaves them
    // `unmatched` (pending, ADR-046) every night. When a wrapper for one of them lands, its line
    // below fails and forces this claim to shrink again.
    const registry = new StrategyRegistry();
    registerCoreStrategies(registry);

    expect(
      registry
        .match(
          manifest(
            'https://www4.sii.cl/propuestaf29ui/services/data/facadeAdapterService/getDeclaracionConCondicionesYTipoPropuesta',
          ),
        )
        .map((s) => s.id),
    ).toEqual(['f29-propuesta']);
    expect(
      registry
        .match(manifest('https://www4.sii.cl/consdcvinternetui/services/data/facadeService/getResumen'))
        .map((s) => s.id),
    ).toEqual(['rcv-resumen']);

    const sweptButUnparsed = [
      manifest('https://misiir.sii.cl/cgi_misii/CViewCarta.cgi', 'requestForm'),
      manifest(
        'https://www4.sii.cl/propuestaf29ui/services/data/facadeAdapterService/getDeclaracionConEstados',
      ),
      manifest('https://www4.sii.cl/consultaestadof22ui/services/data/facadeService/buscaDeclVgte'),
      manifest('https://www4.sii.cl/consultaestadof22ui/services/data/facadeService/f22Compacto'),
    ];
    for (const m of sweptButUnparsed) {
      expect(registry.match(m)).toEqual([]);
    }
  });
});
