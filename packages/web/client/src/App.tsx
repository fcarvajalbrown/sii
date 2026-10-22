import { useEffect, useState } from 'preact/hooks';
import { api, ApiError } from './api.js';
import type { AuditReport, Overview, Session } from './api.js';
import { AuditView } from './AuditView.js';
import { LoginView } from './LoginView.js';
import { OverviewView } from './OverviewView.js';

type Screen = 'loading' | 'login' | 'overview' | 'audit';

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export function App() {
  const [screen, setScreen] = useState<Screen>('loading');
  const [session, setSession] = useState<Session | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [audit, setAudit] = useState<AuditReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (task: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await task();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        setOverview(null);
        setAudit(null);
        setScreen('login');
      }
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };

  const loadOverview = () =>
    run(async () => {
      setScreen('overview');
      setOverview(await api.overview());
    });

  useEffect(() => {
    void run(async () => {
      const s = await api.session();
      setSession(s);
      if (s.authenticated) await loadOverview();
      else setScreen('login');
    });
  }, []);

  const login = () =>
    run(async () => {
      const s = await api.login();
      setSession(s);
      await loadOverview();
    });

  const runAudit = () =>
    run(async () => {
      setAudit(null);
      setScreen('audit');
      setAudit(await api.audit());
    });

  return (
    <>
      {session?.synthetic && (
        <div class="synthetic-banner" role="note">
          Datos sintéticos: contribuyente de demostración, no corresponde a una persona ni empresa
          real.
        </div>
      )}
      <div class="page">
        <header class="top">
          <h1>Tu SII</h1>
          {screen === 'audit' && (
            <button class="link" onClick={() => setScreen('overview')} disabled={busy}>
              Volver a Tu SII
            </button>
          )}
        </header>
        {error && (
          <p class="error" role="alert">
            {error}
          </p>
        )}
        <main>
          {screen === 'loading' && <p class="muted">Cargando…</p>}
          {screen === 'login' && session && (
            <LoginView synthetic={session.synthetic} busy={busy} onLogin={login} />
          )}
          {screen === 'overview' && (
            <OverviewView overview={overview} busy={busy} onAudit={runAudit} />
          )}
          {screen === 'audit' && <AuditView report={audit} busy={busy} />}
        </main>
      </div>
    </>
  );
}
