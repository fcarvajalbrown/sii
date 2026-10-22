import { readFile } from 'node:fs/promises';
import type { AuditInputs, Overview, Session, Source } from './api.js';
import { buildFindings } from './findings.js';

export interface DemoTaxpayer {
  readonly synthetic: true;
  readonly overview: Omit<Overview, 'synthetic' | 'errors'>;
  readonly audit: AuditInputs;
}

export async function loadDemoTaxpayer(path: string): Promise<DemoTaxpayer> {
  const parsed = JSON.parse(await readFile(path, 'utf8')) as DemoTaxpayer;
  if (parsed.synthetic !== true) {
    throw new Error(`Demo fixture ${path} is not marked synthetic; refusing to serve it.`);
  }
  return parsed;
}

export function createDemoSource(taxpayer: DemoTaxpayer): Source {
  let authenticated = false;
  const session = async (): Promise<Session> => ({
    mode: 'demo',
    synthetic: true,
    authenticated,
    rut: authenticated ? (taxpayer.overview.situacion?.rut ?? null) : null,
  });

  return {
    mode: 'demo',
    session,

    async login() {
      authenticated = true;
      return session();
    },

    async overview() {
      return { synthetic: true, ...taxpayer.overview, errors: [] };
    },

    async audit() {
      return {
        synthetic: true,
        ...taxpayer.audit,
        findings: buildFindings(taxpayer.audit),
        errors: [],
      };
    },
  };
}
