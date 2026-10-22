import type {
  F22Overview,
  F29Overview,
  HonorariosAnual,
  IvaMensual,
  MonitorResult,
  SituacionResult,
} from '@dostertags/sii-core';

export type Mode = 'live' | 'demo';

export type Severity = 'alta' | 'media' | 'info';

export interface StepError {
  readonly scope: string;
  readonly message: string;
}

export interface Session {
  readonly mode: Mode;
  readonly synthetic: boolean;
  readonly authenticated: boolean;
  readonly rut: string | null;
}

export interface Overview {
  readonly synthetic: boolean;
  readonly situacion: SituacionResult | null;
  readonly f29: F29Overview | null;
  readonly f22: F22Overview | null;
  readonly iva: IvaMensual | null;
  readonly errors: readonly StepError[];
}

export interface Figure {
  readonly label: string;
  readonly value: number | null;
}

export interface Finding {
  readonly severity: Severity;
  readonly title: string;
  readonly scope: string;
  readonly detail: string;
  readonly source: string;
  readonly figures: readonly Figure[];
}

export interface AuditInputs {
  readonly monitor: MonitorResult | null;
  readonly honorarios: HonorariosAnual | null;
  readonly iva: readonly IvaMensual[];
}

export interface AuditReport extends AuditInputs {
  readonly synthetic: boolean;
  readonly findings: readonly Finding[];
  readonly errors: readonly StepError[];
}

export interface Source {
  readonly mode: Mode;
  session(): Promise<Session>;
  login(): Promise<Session>;
  overview(): Promise<Overview>;
  audit(): Promise<AuditReport>;
}
