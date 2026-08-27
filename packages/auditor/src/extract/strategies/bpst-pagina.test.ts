import { describe, expect, it } from 'vitest';
import { instant } from '../../provenance.js';
import type { FetchManifest } from '../../ingest/manifest.js';
import { inScope } from '../strategy.js';
import type { ExtractionContext } from '../strategy.js';
import { bpstPaginaStrategy } from './bpst-pagina.js';

const manifest = (over: Partial<FetchManifest> = {}): FetchManifest => ({
  contentHash: 'b'.repeat(64),
  url: 'https://zeus.sii.cl/cvc_cgi/bte/bte_indiv_cons2',
  transport: 'requestForm',
  httpStatus: 200,
  retrievedAt: instant('2026-08-06T03:00:00.000Z'),
  contentType: null,
  byteLength: 0,
  durationMs: 5,
  taxpayer: 'tk-aaa',
  runId: 'run-1',
  requestFingerprint: null,
  ...over,
});

const run = (html: string) => {
  const ctx: ExtractionContext = {
    manifest: manifest(),
    bytes: Buffer.from(html, 'utf8'),
    runId: 'run-1',
    taxpayer: 'tk-aaa',
    now: '2026-08-06T03:00:00.000Z',
  };
  return bpstPaginaStrategy.extract(ctx);
};

/** Shaped after the real observed page (same markup, invented figures). */
const page = (
  opts: { anom?: string; mesm?: string; pagina?: string; cells?: string[]; totals?: boolean } = {},
): string => {
  const cells = opts.cells ?? ['3.352.068', '435.769', '2.916.299'];
  const label = opts.totals === false ? 'Subtotales' : '(*)Totales';
  return `<html><body>
<input name="ANOM" type="hidden" value="${opts.anom ?? '2023'}">
<input name="MESM" type="hidden" value="${opts.mesm ?? '01'}">
<input name="PAGINA" type="hidden" value="${opts.pagina ?? '1'}">
<table><tr>
<td><div align="left"><font class="reporte"><b>${label}</b></font></div></td>
${cells.map((c) => `<td><div align="right"><font class="reporte">${c} </font></div></td>`).join('')}
</tr></table>
<font class="texto"> (*) Los valores totales no consideran los montos de las boletas anuladas. </font>
</body></html>`;
};

describe('scope', () => {
  it('matches the BPST query CGI over requestForm', () => {
    expect(inScope(bpstPaginaStrategy.scope, manifest())).toBe(true);
  });

  it('ignores the bootstrap GET to the sibling URL', () => {
    // `bte_indiv_cons` (no trailing 2) is the bootstrap page, not a result page.
    expect(
      inScope(
        bpstPaginaStrategy.scope,
        manifest({ url: 'https://zeus.sii.cl/cvc_cgi/bte/bte_indiv_cons', transport: 'goto' }),
      ),
    ).toBe(false);
  });
});

describe('parsing', () => {
  it('reads the (*)Totales row and the page cursor', async () => {
    const v = (await run(page())).records[0]?.value;
    expect(v?.periodo).toBe('2023-01');
    expect(v?.pagina).toBe(1);
    expect(v?.brutos).toBe(3352068);
    expect(v?.retenidos).toBe(435769);
    expect(v?.pagado).toBe(2916299);
  });

  it('parses es-CL dots as THOUSAND separators, never decimals', async () => {
    const v = (await run(page({ cells: ['1.159.041', '150.674', '1.008.367'] }))).records[0]?.value;
    expect(v?.retenidos).toBe(150674);
  });

  it('reports page 2 as page 2 — the month total is the SUM, not this page (ADR-029)', async () => {
    const v = (await run(page({ pagina: '2', cells: ['5.323.580', '692.066', '4.631.514'] })))
      .records[0]?.value;
    expect(v?.pagina).toBe(2);
    expect(v?.retenidos).toBe(692066);
  });

  it('fails LOUDLY when the (*)Totales row is gone — scraper roto, not a zero', async () => {
    // Returning 0 here would silently under-report retención, the exact failure ADR-034 rejects.
    const out = await run(page({ totals: false }));
    expect(out.records).toHaveLength(0);
    expect(out.failures[0]?.message).toMatch(/scraper roto/);
  });

  it('fails on an empty response', async () => {
    const out = await run('   ');
    expect(out.failures).toHaveLength(1);
  });

  it('flags a changed column count instead of guessing which cell is which', async () => {
    const out = await run(page({ cells: ['1.000', '2.000', '3.000', '4.000'] }));
    expect(out.records[0]?.signals.some((s) => s.code === 'structural_drift')).toBe(true);
  });

  it('flags a missing período', async () => {
    const out = await run(page({ anom: '', mesm: '' }));
    expect(out.records[0]?.value.periodo).toBeNull();
    expect(out.records[0]?.signals.some((s) => s.code === 'missing_field')).toBe(true);
  });
});

describe('column mapping is anchored on the LABEL, not a position', () => {
  it('survives an extra column inserted BEFORE the totals row', async () => {
    // Header-name/label anchoring is what makes an inserted column harmless (ADR-034's corollary).
    const html = page().replace(
      '<table><tr>',
      '<table><tr><td><font class="reporte">Nueva Columna</font></td></tr><tr>',
    );
    const v = (await run(html)).records[0]?.value;
    expect(v?.retenidos).toBe(435769);
  });
});

describe('PII', () => {
  it('emits only aggregates — no worker rows (ADR-029 inherits BTE no-raw)', async () => {
    const html = page().replace(
      '<table>',
      '<table><tr><td><font class="reporte">JUAN PEREZ</font></td><td><font class="reporte">11.111.111-1</font></td></tr>',
    );
    const serialised = JSON.stringify((await run(html)).records[0]?.value);
    expect(serialised).not.toContain('JUAN');
    expect(serialised).not.toContain('11.111.111');
  });
});
