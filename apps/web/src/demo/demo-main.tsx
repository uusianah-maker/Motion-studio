import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../App';
import '../styles.css';
import { createDemoApi } from './mockApi';
import './demo.css';

const api = createDemoApi();

function Demo() {
  const [out, setOut] = useState(false);
  if (out) {
    return (
      <div className="gate">
        <div className="card login">
          <h2>Motion Studio</h2>
          <div className="notice info">Anda sudah keluar (demo).</div>
          <button className="btn primary" onClick={() => setOut(false)}>
            Masuk lagi
          </button>
        </div>
      </div>
    );
  }
  return (
    <>
      <App api={api} workspaceId="ws_demo" account={{ email: 'owner@contoh.com', name: 'Owner', onLogout: async () => setOut(true) }} />
      <div className="demoBadge" role="note">
        Demo · data contoh · AI &amp; render disimulasikan · tidak ada yang tersimpan
      </div>
    </>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Demo />
  </StrictMode>,
);
