import type { AuditReport, Overview, Session } from '../../src/api.js';

export type { AuditReport, Finding, Overview, Session, StepError } from '../../src/api.js';

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function call<T>(method: 'GET' | 'POST', path: string): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: method === 'POST' ? { 'x-sii-web': '1' } : {},
  });
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new ApiError(res.status, body.error ?? `Error ${res.status}`);
  return body as T;
}

export const api = {
  session: () => call<Session>('GET', '/api/session'),
  login: () => call<Session>('POST', '/api/login'),
  overview: () => call<Overview>('GET', '/api/overview'),
  audit: () => call<AuditReport>('POST', '/api/audit'),
};
