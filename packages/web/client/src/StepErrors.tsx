import type { StepError } from './api.js';

export function StepErrors({ errors }: { errors: readonly StepError[] }) {
  if (errors.length === 0) return null;
  return (
    <section class="card step-errors">
      <h2>Lo que no se pudo leer</h2>
      <p class="muted">Respuestas del SII tal como llegaron.</p>
      <ul>
        {errors.map((e) => (
          <li key={`${e.scope}|${e.message}`}>
            <strong>{e.scope}:</strong> {e.message}
          </li>
        ))}
      </ul>
    </section>
  );
}
