import type { Overview } from './api.js';
import { count, money, monthLabel, rut } from './format.js';
import { StepErrors } from './StepErrors.js';

function Taxpayer({ overview }: { overview: Overview }) {
  const s = overview.situacion;
  if (!s) return null;
  return (
    <section class="card">
      <h2>{s.perfil.razonSocial ?? 'Contribuyente'}</h2>
      <dl class="facts">
        <dt>RUT</dt>
        <dd>{rut(s.rut)}</dd>
        <dt>Régimen</dt>
        <dd>{s.regimenes.map((r) => r.descripcion ?? r.codigo).join(', ') || '—'}</dd>
        <dt>Actividad</dt>
        <dd>{s.perfil.glosaActividad ?? s.perfil.actividades[0]?.descripcion ?? '—'}</dd>
        <dt>Ley COT</dt>
        <dd>
          {s.cumplimiento.estado ?? '—'}
          {s.requisitosIncumplidos.length > 0 &&
            ` (${s.requisitosIncumplidos.length} requisitos sin cumplir)`}
        </dd>
      </dl>
    </section>
  );
}

function F29Grid({ overview }: { overview: Overview }) {
  const f29 = overview.f29;
  if (!f29) return null;
  return (
    <section class="card">
      <h2>Declaraciones mensuales (F29)</h2>
      <ul class="months">
        {f29.meses.map((m) => (
          <li key={m.periodo} class={m.tieneDeclaracion ? 'month ok' : 'month missing'}>
            <span class="month-name">{monthLabel(m.periodo)}</span>
            <span class="month-state">
              {m.tieneDeclaracion ? (m.estado ?? 'Presentada') : 'Sin declarar'}
            </span>
            <span class="month-total">{m.tieneDeclaracion ? money(m.total) : ''}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function F22List({ overview }: { overview: Overview }) {
  const f22 = overview.f22;
  if (!f22) return null;
  return (
    <section class="card">
      <h2>Declaración de renta (F22)</h2>
      <table>
        <thead>
          <tr>
            <th>Año tributario</th>
            <th>Estado</th>
            <th>Presentada</th>
          </tr>
        </thead>
        <tbody>
          {f22.anios.map((a) => {
            const vigente = a.declaraciones.find((d) => d.vigente) ?? a.declaraciones[0];
            return (
              <tr key={a.anio}>
                <td>{a.anio}</td>
                <td>{a.tieneDeclaracion ? (vigente?.estado ?? '—') : 'Sin declaración'}</td>
                <td>{vigente?.fecha ?? '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

function Rcv({ overview }: { overview: Overview }) {
  const iva = overview.iva;
  if (!iva) return null;
  const rows = [
    { label: 'Compras', side: iva.compras },
    { label: 'Ventas', side: iva.ventas },
  ];
  return (
    <section class="card">
      <h2>Compras y ventas de {monthLabel(iva.periodo)}</h2>
      <div class="table-wrap">
        <table class="numeric">
          <thead>
            <tr>
              <th></th>
              <th>Documentos</th>
              <th>Neto</th>
              <th>IVA</th>
              <th>Total</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ label, side }) => (
              <tr key={label}>
                <th scope="row">{label}</th>
                <td>{count(side.documentos)}</td>
                <td>{money(side.neto)}</td>
                <td>{money(side.iva)}</td>
                <td>{money(side.total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function OverviewView(props: {
  overview: Overview | null;
  busy: boolean;
  onAudit: () => void;
}) {
  if (!props.overview) {
    return (
      <p class="muted">
        {props.busy ? 'Leyendo tu información en el SII. Puede tardar un minuto.' : ''}
      </p>
    );
  }
  return (
    <>
      <div class="grid">
        <Taxpayer overview={props.overview} />
        <F22List overview={props.overview} />
        <F29Grid overview={props.overview} />
        <Rcv overview={props.overview} />
      </div>
      <StepErrors errors={props.overview.errors} />
      <div class="actions">
        <button class="primary big" onClick={props.onAudit} disabled={props.busy}>
          Auditar a mi contador
        </button>
        <p class="muted">
          Revisa meses sin F29, observaciones y giros del SII, retenciones de honorarios y el IVA de
          los últimos tres meses.
        </p>
      </div>
    </>
  );
}
