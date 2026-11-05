import { StrictMode, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ApiError, createApi } from './api';
import { App } from './App';
import { takeTokenFromHash } from './lib';
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

function Root() {
  const [token] = useState(bootToken);
  const [state, setState] = useState<'checking' | 'ok' | 'denied' | 'offline'>(token ? 'checking' : 'denied');
  const [workspaceId, setWorkspaceId] = useState('');
  const api = useMemo(() => (token ? createApi(token) : null), [token]);

  useEffect(() => {
    if (!api) return;
    api
      .session()
      .then((s) => {
        setWorkspaceId(s.workspace_id);
        setState('ok');
      })
      .catch((e: unknown) => {
        if (e instanceof ApiError && e.status === 401) {
          try {
            sessionStorage.removeItem(STORAGE_KEY);
          } catch {
            /* ignore */
          }
          setState('denied');
        } else setState('offline');
      });
  }, [api]);

  if (state === 'checking') return <Gate reason="Menghubungkan ke server…" />;
  if (state === 'offline') return <Gate reason="Server tidak bisa dihubungi." />;
  if (state === 'denied' || !api) return <Gate reason="Sesi tidak ada atau sudah kedaluwarsa." />;
  return <App api={api} workspaceId={workspaceId} />;
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
