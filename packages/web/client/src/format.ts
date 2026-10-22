export function money(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : `$${value.toLocaleString('es-CL')}`;
}

export function count(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : value.toLocaleString('es-CL');
}

export function rut(canonical: string | null | undefined): string {
  if (!canonical) return '—';
  const [body = '', dv = ''] = canonical.split('-');
  return `${Number(body).toLocaleString('es-CL')}-${dv}`;
}

const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

export function monthLabel(periodo: string): string {
  const [year = '', month = '1'] = periodo.split('-');
  return `${MONTHS[Number(month) - 1] ?? month} ${year}`;
}
