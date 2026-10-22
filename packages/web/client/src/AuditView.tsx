import type { AuditReport, Finding } from './api.js';
import { money } from './format.js';
import { StepErrors } from './StepErrors.js';

const SEVERITY_LABELS: Record<Finding['severity'], string> = {
  alta: 'Urgente',
  media: 'Revisar',
  info: 'Para saber',
};

function FindingCard({ finding }: { finding: Finding }) {
  return (
    <li class={`card finding ${finding.severity}`}>
      <div class="finding-head">
        <span class={`chip ${finding.severity}`}>{SEVERITY_LABELS[finding.severity]}</span>
        <span class="finding-scope">{finding.scope}</span>
      </div>
      <h3>{finding.title}</h3>
      <p>{finding.detail}</p>
      {finding.figures.length > 0 && (
        <table class="figures">
          <tbody>
            {finding.figures.map((f) => (
              <tr key={f.label}>
                <th scope="row">{f.label}</th>
                <td>{money(f.value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p class="source">Fuente: {finding.source}</p>
    </li>
  );
}

export function AuditView(props: { report: AuditReport | null; busy: boolean }) {
  const report = props.report;
  if (!report) {
    return (
      <p class="muted">
        {props.busy
          ? 'Revisando tu información en el SII. Con datos reales puede tardar algunos minutos.'
          : ''}
      </p>
    );
  }
  const counts = (['alta', 'media', 'info'] as const).map((s) => ({
    severity: s,
    n: report.findings.filter((f) => f.severity === s).length,
  }));
  return (
    <>
      <section class="card summary">
        <h2>Resultado de la auditoría</h2>
        <ul class="counts">
          {counts.map((c) => (
            <li key={c.severity} class={c.severity}>
              <span class="count">{c.n}</span> {SEVERITY_LABELS[c.severity]}
            </li>
          ))}
        </ul>
        {report.monitor?.baseline && (
          <p class="muted">
            Es la primera revisión de este contribuyente: desde hoy se registran los cambios. Por
            ahora se muestra solo lo que está vigente.
          </p>
        )}
        <p class="muted">
          Las retenciones y el IVA se comparan con la propuesta del F29 que arma el SII, no con el
          formulario presentado.
        </p>
      </section>
      {report.findings.length === 0 ? (
        <p class="card">No se encontraron diferencias en lo revisado.</p>
      ) : (
        <ul class="findings">
          {report.findings.map((f, i) => (
            <FindingCard key={`${f.scope}-${i}`} finding={f} />
          ))}
        </ul>
      )}
      <StepErrors errors={report.errors} />
    </>
  );
}
