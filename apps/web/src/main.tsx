import { StrictMode, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ApiError, type Session, authMode, createApi } from './api';
import { App } from './App';
import { AUTH_ERRORS, takeAuthError, takeTokenFromHash } from './lib';
import './styles.css';

const STORAGE_KEY = 'motion.session';

/** Token from `#token=…` (then wiped from the address bar and history), else this tab's session. */
function bootToken(): string | null {
  const { token, rest } = takeTokenFromHash(window.location.hash);
  if (token) {
    try {
      sessionStorage.setItem(STORAGE_KEY, token);
    } catch {
      /* storage blocked: keep it in memory only */
    }
    history.replaceState(null, '', `${window.location.pathname}${window.location.search}${rest}`);
    return token;
  }
  try {
    return sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

/** `#auth_error=CODE` from a failed Google login: read once, then wiped from the address bar. */
function bootAuthError(): string | null {
  const { code, rest } = takeAuthError(window.location.hash);
  if (code) history.replaceState(null, '', `${window.location.pathname}${window.location.search}${rest}`);
  return code;
}

function Gate({ reason }: { reason: string }) {
  return (
    <div className="gate">
      <div className="card">
        <h2>Motion Studio</h2>
        <p>{reason}</p>
        <p className="muted">
          Jalankan server (<code>npm run start:server</code>) lalu buka alamat lengkap yang dicetak di terminal, yang berakhiran <code>#token=…</code>.
          Token berganti setiap server di-restart.
        </p>
      </div>
    </div>
  );
}

/** Google mode (W09): the only way in. The button is a plain link: the server runs the whole OAuth flow. */
function LoginGate({ error, signedOut }: { error: string | null; signedOut: boolean }) {
  return (
    <div className="gate">
      <div className="card login">
        <h2>Motion Studio</h2>
        {signedOut && !error && <div className="notice info" role="status">Anda sudah keluar.</div>}
        {error && (
          <div className="notice warn" role="alert">
            {AUTH_ERRORS[error] ?? 'Login gagal. Coba lagi.'}
          </div>
        )}
        <p>Masuk dengan akun Google yang sudah diizinkan owner.</p>
        <a className="btn primary googleBtn" href="/api/auth/login">
          <span aria-hidden="true" className="gMark">G</span> Masuk dengan Google
        </a>
        <p className="muted small">
          Izin yang diminta hanya nama &amp; email (untuk mencocokkan daftar izin). App tidak mengakses Google Drive, Gmail, atau data Google lain; semua file tetap di server.
        </p>
      </div>
    </div>
  );
}

type State = { kind: 'checking' } | { kind: 'offline' } | { kind: 'denied' } | { kind: 'login'; error: string | null; signedOut: boolean } | { kind: 'ok'; session: Session };

function Root() {
  const [authError] = useState(bootAuthError);
  const [mode, setMode] = useState<'local' | 'google' | null>(null);
  const [state, setState] = useState<State>({ kind: 'checking' });
  const [token] = useState(bootToken);
  const api = useMemo(() => (mode === 'google' ? createApi(null) : mode === 'local' && token ? createApi(token) : null), [mode, token]);

  useEffect(() => {
    authMode().then(setMode, () => setState({ kind: 'offline' }));
  }, []);

  useEffect(() => {
    if (!mode) return;
    if (!api) {
      setState({ kind: 'denied' });
      return;
    }
    api
      .session()
      .then((session) => setState({ kind: 'ok', session }))
      .catch((e: unknown) => {
        if (e instanceof ApiError && e.status === 401) {
          if (mode === 'google') return setState({ kind: 'login', error: authError, signedOut: false });
          try {
            sessionStorage.removeItem(STORAGE_KEY);
          } catch {
            /* ignore */
          }
          setState({ kind: 'denied' });
        } else setState({ kind: 'offline' });
      });
  }, [api, mode, authError]);

  if (state.kind === 'checking') return <Gate reason="Menghubungkan ke server…" />;
  if (state.kind === 'offline') return <Gate reason="Server tidak bisa dihubungi." />;
  if (state.kind === 'login') return <LoginGate error={state.error} signedOut={state.signedOut} />;
  if (state.kind === 'denied' || !api) return <Gate reason="Sesi tidak ada atau sudah kedaluwarsa." />;
  const user = state.session.user;
  return (
    <App
      api={api}
      workspaceId={state.session.workspace_id}
      account={
        user
          ? {
              ...user,
              onLogout: async () => {
                await api.logout().catch(() => undefined);
                setState({ kind: 'login', error: null, signedOut: true });
              },
            }
          : null
      }
    />
  );
}

// Pasting the token URL into a tab already showing the gate only changes the fragment (no
// page load): restart so the new token is picked up and wiped from the address bar.
window.addEventListener('hashchange', () => {
  if (takeTokenFromHash(window.location.hash).token) window.location.reload();
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
