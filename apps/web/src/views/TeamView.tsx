import { useCallback, useEffect, useState } from 'react';
import type { Api, Role, TeamMember } from '../api';
import { formatDate } from '../lib';
import { ErrorNotice } from '../ui';

const ROLE_TEXT: Record<Role, string> = {
  owner: 'Owner: semua akses, termasuk Brand Kit, AI, hapus permanen, dan halaman Tim.',
  editor: 'Editor: edit proyek, upload, render, jalankan mesin, komentar. Tidak bisa menyetujui.',
  reviewer: 'Reviewer: lihat semua, komentar, Lulus / minta revisi. Tidak bisa mengedit atau render.',
};
const ROLE_NAME: Record<Role, string> = { owner: 'Owner', editor: 'Editor', reviewer: 'Reviewer' };

/**
 * Halaman Tim (owner only): which Google accounts may sign in, and their role. The server
 * enforces everything (owner-only API, last owner, locked .env.local accounts); this page only asks.
 */
export function TeamView({ api }: { api: Api }) {
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [me, setMe] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('editor');

  const load = useCallback(async () => {
    try {
      const r = await api.team();
      setMembers(r.members);
      setMe(r.me);
      setError(null);
    } catch (e) {
      setError(e);
    } finally {
      setLoaded(true);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (fn: () => Promise<{ members: TeamMember[] }>, ok: string) => {
    setBusy(true);
    setNotice(null);
    try {
      const r = await fn();
      setMembers(r.members);
      setError(null);
      setNotice(ok);
      return true;
    } catch (e) {
      setError(e);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const owners = members.filter((m) => m.role === 'owner').length;
  const clean = email.trim().toLowerCase();
  const validEmail = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(clean);

  return (
    <div className="body aiPage">
      <h2>Tim</h2>
      <p className="muted">Akun Google yang boleh masuk ke Motion Studio, beserta perannya. Perubahan langsung berlaku tanpa restart server. Email yang dihapus langsung keluar dari sesinya.</p>
      <div className="notice warn" role="note">
        Selama app Google masih status <b>Testing</b>, email baru juga harus ditambahkan sebagai <b>Test user</b> di Google Auth Platform → Audience. Kalau belum, Google menolak login email itu sebelum sampai ke Motion Studio.
      </div>
      <ErrorNotice error={error} />
      {notice && (
        <div className="notice ok" role="status">
          {notice}
        </div>
      )}

      <section className="card aiSection" aria-label="Tambah anggota tim">
        <h3>Tambah email</h3>
        <form
          className="row wrap"
          onSubmit={(e) => {
            e.preventDefault();
            if (!validEmail || busy) return;
            void act(() => api.teamAdd(clean, role), `${clean} ditambahkan sebagai ${ROLE_NAME[role]}.`).then((ok) => ok && setEmail(''));
          }}
        >
          <input type="email" aria-label="Email Google" placeholder="nama@gmail.com" value={email} disabled={busy} onChange={(e) => setEmail(e.target.value)} style={{ minWidth: 220, flex: 1 }} />
          <select aria-label="Peran" value={role} disabled={busy} onChange={(e) => setRole(e.target.value as Role)}>
            <option value="editor">Editor</option>
            <option value="reviewer">Reviewer</option>
            <option value="owner">Owner</option>
          </select>
          <button className="btn primary" type="submit" disabled={busy || !validEmail}>
            Tambah
          </button>
        </form>
        <p className="muted small">{ROLE_TEXT[role]}</p>
      </section>

      <section className="card aiSection" aria-label="Daftar tim">
        <h3>Anggota ({members.length})</h3>
        {!loaded && <div className="muted">Memuat…</div>}
        {loaded && members.length > 0 && (
          <table className="list small">
            <thead>
              <tr>
                <th>Email</th>
                <th>Peran</th>
                <th className="hideNarrow">Asal</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {members.map((m) => {
                const self = m.email === me;
                const locked = m.source === 'env' || self;
                const lastOwner = m.role === 'owner' && owners <= 1;
                return (
                  <tr key={m.email}>
                    <td>
                      {m.email}
                      {self && <span className="muted"> (Anda)</span>}
                    </td>
                    <td>
                      {locked ? (
                        <span className="badge">{ROLE_NAME[m.role]}</span>
                      ) : (
                        <select
                          aria-label={`Peran ${m.email}`}
                          value={m.role}
                          disabled={busy}
                          onChange={(e) => {
                            const next = e.target.value as Role;
                            void act(() => api.teamSetRole(m.email, next), `Peran ${m.email} sekarang ${ROLE_NAME[next]}.`);
                          }}
                        >
                          <option value="owner">Owner</option>
                          <option value="editor" disabled={lastOwner}>Editor</option>
                          <option value="reviewer" disabled={lastOwner}>Reviewer</option>
                        </select>
                      )}
                    </td>
                    <td className="hideNarrow muted">
                      {m.source === 'env' ? 'Dari .env.local' : `Ditambah ${m.added_at ? formatDate(m.added_at) : ''}${m.added_by ? ` oleh ${m.added_by}` : ''}`}
                    </td>
                    <td>
                      {!locked && (
                        <button
                          className="btn small danger"
                          disabled={busy || lastOwner}
                          title={lastOwner ? 'Owner terakhir tidak bisa dihapus' : undefined}
                          onClick={() => window.confirm(`Hapus ${m.email} dari tim? Akun ini langsung keluar dan tidak bisa masuk lagi.`) && void act(() => api.teamRemove(m.email), `${m.email} dihapus dari tim.`)}
                        >
                          Hapus
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <p className="muted small">Email dengan asal "Dari .env.local" diatur di file <code>.env.local</code> di komputer server, jadi tidak bisa diubah di sini. Akun sendiri juga tidak bisa diubah dari sini; minta owner lain.</p>
      </section>
    </div>
  );
}
