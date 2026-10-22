import {
  authStatus,
  f22Overview,
  f29Overview,
  honorariosAnual,
  ivaMensual,
  login,
  monitorSweep,
  NotAuthenticatedError,
  situacionTributaria,
} from '@dostertags/sii-core';
import type { IvaMensual, Runtime } from '@dostertags/sii-core';
import type { Session, Source, StepError } from './api.js';
import { buildFindings } from './findings.js';
import { closedMonths } from './periods.js';

const F29_MONTHS = 12;
const F22_YEARS = 3;
const IVA_AUDIT_MONTHS = 3;

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

async function step<T>(
  scope: string,
  errors: StepError[],
  run: () => Promise<T>,
): Promise<T | null> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof NotAuthenticatedError) throw error;
    errors.push({ scope, message: messageOf(error) });
    return null;
  }
}

export function createLiveSource(runtime: Runtime): Source {
  const session = async (): Promise<Session> => {
    const status = await authStatus(runtime);
    return { mode: 'live', synthetic: false, authenticated: status.authenticated, rut: status.rut };
  };

  return {
    mode: 'live',
    session,

    async login() {
      await login(runtime);
      return session();
    },

    async overview() {
      const errors: StepError[] = [];
      const months = closedMonths(runtime.clock.now(), F29_MONTHS);
      const situacion = await step('Situación tributaria', errors, () =>
        situacionTributaria(runtime),
      );
      const f29 = await step('F29', errors, () =>
        f29Overview(runtime, { desde: months[0], hasta: months[months.length - 1] }),
      );
      const f22 = await step('F22', errors, () => f22Overview(runtime, { years: F22_YEARS }));
      const lastMonth = months[months.length - 1] ?? '';
      const iva = await step(`IVA ${lastMonth}`, errors, () =>
        ivaMensual(runtime, { periodo: lastMonth }),
      );
      return { synthetic: false, situacion, f29, f22, iva, errors };
    },

    async audit() {
      const errors: StepError[] = [];
      const now = runtime.clock.now();
      const monitor = await step('Monitor de cumplimiento', errors, () =>
        monitorSweep(runtime, { dryRun: true }),
      );
      const anio = now.getFullYear() - 1;
      const honorarios = await step(`Honorarios ${anio}`, errors, () =>
        honorariosAnual(runtime, { anio }),
      );
      const iva: IvaMensual[] = [];
      for (const periodo of closedMonths(now, IVA_AUDIT_MONTHS)) {
        const month = await step(`IVA ${periodo}`, errors, () => ivaMensual(runtime, { periodo }));
        if (month) iva.push(month);
      }
      for (const e of monitor?.errores ?? []) errors.push({ scope: e.ambito, message: e.mensaje });
      const inputs = { monitor, honorarios, iva };
      return { synthetic: false, ...inputs, findings: buildFindings(inputs), errors };
    },
  };
}
