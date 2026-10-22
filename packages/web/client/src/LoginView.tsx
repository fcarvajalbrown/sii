export function LoginView(props: { synthetic: boolean; busy: boolean; onLogin: () => void }) {
  return (
    <section class="card login">
      <h2>Mira tu SII y revisa el trabajo de tu contador</h2>
      <p>
        Entra con tu Clave Única en la página del SII. La clave la escribes tú, en el sitio del
        SII; esta aplicación nunca la ve ni la guarda.
      </p>
      <button class="primary" onClick={props.onLogin} disabled={props.busy}>
        {props.busy ? 'Esperando el ingreso…' : 'Iniciar sesión'}
      </button>
      {props.busy && !props.synthetic && (
        <p class="muted">
          Se abrió una ventana del SII en este computador. Termina el ingreso allí y vuelve a esta
          pestaña.
        </p>
      )}
    </section>
  );
}
