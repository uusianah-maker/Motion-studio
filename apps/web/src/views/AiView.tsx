import { useCallback, useEffect, useState } from 'react';
import type { AiCatalogItem, AiConnection, AiLogEntry, AiSettings, Api, Capability, ProviderId } from '../api';
import { formatDate } from '../lib';
import { ErrorNotice } from '../ui';

const MODE_TEXT: Record<AiSettings['mode'], string> = {
  local: 'Lokal saja: hanya perintah yang dikenali aturan. Tidak pernah memanggil AI, tanpa biaya API.',
  auto: 'Otomatis: aturan lokal dulu; AI hanya dipanggil kalau perintah tidak dikenali (berbiaya).',
  ai: 'Selalu AI: setiap perintah dikirim ke AI (berbiaya).',
};
const STATUS: Record<AiConnection['status'], [string, string]> = {
  untested: ['Belum dites', ''],
  ok: ['Siap', 'ok'],
  error: ['Gagal terakhir', 'warn'],
  needs_admin: ['Perlu tindakan', 'bad'],
};
const CAP: Record<Capability, string> = { planner: 'Copilot (planner)', transcription: 'Transkripsi (STT)' };

/**
 * AI Provider Manager (W12) + usage/budget (W13). API keys are typed once and sent to the
 * server, which seals them; this page never receives a key back (only "…1234").
 */
export function AiView({ api }: { api: Api }) {
  const [conns, setConns] = useState<AiConnection[]>([]);
  const [settings, setSettings] = useState<AiSettings | null>(null);
  const [catalog, setCatalog] = useState<AiCatalogItem[]>([]);
  const [log, setLog] = useState<AiLogEntry[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [p, l] = await Promise.all([api.aiProviders(), api.aiLog()]);
    setConns(p.connections.sort((a, b) => a.priority - b.priority));
    setSettings(p.settings);
    setCatalog(p.catalog);
    setLog(l);
  }, [api]);

  useEffect(() => {
    load().catch(setError);
  }, [load]);

  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
      if (ok) setNotice(ok);
      await load();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const move = (c: AiConnection, dir: -1 | 1) => {
    const i = conns.indexOf(c);
    const other = conns[i + dir];
    if (!other) return;
    void act(async () => {
      await api.aiUpdate(c.connection_id, { priority: other.priority === c.priority ? c.priority + dir : other.priority });
      await api.aiUpdate(other.connection_id, { priority: c.priority });
    });
  };

  return (
    <div className="body aiPage">
      <h2>AI</h2>
      <p className="muted">
        Koneksi API resmi yang lo daftarkan sendiri. Key disimpan terenkripsi di server dan tidak pernah dikirim balik ke browser. Failover hanya ke provider <b>lain</b>, tidak pernah ke key lain dari provider yang sama.
      </p>
      <ErrorNotice error={error} />
      {notice && (
        <div className="notice ok" role="status">
          {notice}
        </div>
      )}

      {settings && (
        <section className="card aiSection" aria-label="Mode Copilot">
          <h3>Mode Copilot</h3>
          <div className="row wrap">
            <select aria-label="Pilih mode Copilot" value={settings.mode} disabled={busy} onChange={(e) => void act(() => api.aiSettings({ mode: e.target.value as AiSettings['mode'] }), 'Mode disimpan.')}>
              <option value="local">Lokal saja (tanpa AI)</option>
              <option value="auto">Otomatis (aturan dulu, AI jika perlu)</option>
              <option value="ai">Selalu AI</option>
            </select>
            <label className="inline">
              <input type="checkbox" checked={settings.failover} disabled={busy} onChange={(e) => void act(() => api.aiSettings({ failover: e.target.checked }))} /> Failover ke provider lain
            </label>
            <label className="inline">
              Ulangi
              <select aria-label="Jumlah ulang" value={settings.max_retries} disabled={busy} onChange={(e) => void act(() => api.aiSettings({ max_retries: Number(e.target.value) }))}>
                {[0, 1, 2, 3].map((n) => (
                  <option key={n} value={n}>
                    {n}×
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="muted small">{MODE_TEXT[settings.mode]}</p>
        </section>
      )}

      <section className="card aiSection" aria-label="Koneksi AI">
        <h3>Koneksi ({conns.length})</h3>
        {conns.length === 0 && <div className="muted">Belum ada koneksi. Copilot tetap jalan dengan aturan lokal.</div>}
        <ul className="conns">
          {conns.map((c, i) => (
            <li key={c.connection_id} className={c.enabled ? '' : 'off'}>
              <div className="row wrap">
                <b>
                  {i + 1}. {c.label}
                </b>
                <span className="muted small">
                  {c.provider} · {c.model} · {c.capabilities.map((x) => CAP[x]).join(', ')} · key {c.key_hint ?? '—'}
                </span>
                <span className={`badge ${STATUS[c.status][1]}`}>{!c.enabled ? 'Nonaktif' : c.status !== 'needs_admin' && c.cooling_down ? 'Jeda (cooldown)' : STATUS[c.status][0]}</span>
              </div>
              {c.last_error && (
                <div className="muted small">
                  Error terakhir: {c.last_error.message} ({formatDate(c.last_error.at)})
                </div>
              )}
              <div className="muted small">
                Harga: ${c.prices.input_per_mtok}/1M input · ${c.prices.output_per_mtok}/1M output{c.capabilities.includes('transcription') ? ` · $${c.prices.per_audio_minute}/menit audio` : ''}
              </div>
              <div className="row wrap" style={{ gap: 6 }}>
                <button className="btn small" disabled={busy} onClick={() => void act(async () => {
                  const r = await api.aiTest(c.connection_id);
                  setTimeout(() => setNotice(r.result.ok ? `Tes ${c.label}: berhasil${r.result.model_listed === false ? ' (tapi model tidak ada di daftar provider)' : ''}.` : `Tes ${c.label} gagal: ${r.result.error?.message ?? ''}`), 0);
                })} aria-label={`Tes ${c.label}`}>
                  Tes koneksi
                </button>
                <button className="btn small" disabled={busy} onClick={() => void act(() => api.aiUpdate(c.connection_id, { enabled: !c.enabled }))}>
                  {c.enabled ? 'Nonaktifkan' : 'Aktifkan'}
                </button>
                <button className="btn small" disabled={busy || i === 0} onClick={() => move(c, -1)} aria-label={`Naikkan prioritas ${c.label}`}>
                  ↑
                </button>
                <button className="btn small" disabled={busy || i === conns.length - 1} onClick={() => move(c, 1)} aria-label={`Turunkan prioritas ${c.label}`}>
                  ↓
                </button>
                <RotateKey disabled={busy} onRotate={(k) => act(() => api.aiRotate(c.connection_id, k), 'Key diganti. Tes ulang koneksinya.')} label={c.label} />
                <button className="btn small danger" disabled={busy} onClick={() => window.confirm(`Hapus koneksi ${c.label}? Key-nya ikut dihapus dari server.`) && void act(() => api.aiRemove(c.connection_id), 'Koneksi dihapus.')}>
                  Hapus
                </button>
              </div>
            </li>
          ))}
        </ul>
        <AddConnection catalog={catalog} busy={busy} onAdd={(body) => act(() => api.aiAdd(body), 'Koneksi ditambahkan. Klik "Tes koneksi" untuk mengecek key-nya.')} />
      </section>

      <section className="card aiSection" aria-label="Log routing AI">
        <h3>Log routing</h3>
        {log.length === 0 ? (
          <div className="muted">Belum ada panggilan AI.</div>
        ) : (
          <table className="list small">
            <thead>
              <tr>
                <th>Waktu</th>
                <th>Kejadian</th>
                <th>Provider</th>
                <th className="hideNarrow">Detail</th>
              </tr>
            </thead>
            <tbody>
              {log.slice(0, 30).map((e, i) => (
                <tr key={i}>
                  <td>{formatDate(e.ts)}</td>
                  <td>
                    {e.op} · {e.outcome}
                  </td>
                  <td>{e.provider ?? '—'}</td>
                  <td className="hideNarrow">
                    {[e.error_class, e.status, e.cost_usd !== undefined ? `$${e.cost_usd.toFixed(4)}` : null, e.reason, e.request_id].filter((x) => x !== null && x !== undefined && x !== '').join(' · ')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

function RotateKey({ onRotate, disabled, label }: { onRotate: (key: string) => Promise<void>; disabled: boolean; label: string }) {
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState('');
  if (!open)
    return (
      <button className="btn small" disabled={disabled} onClick={() => setOpen(true)}>
        Ganti key
      </button>
    );
  return (
    <span className="row" style={{ gap: 4 }}>
      <input type="password" autoComplete="off" aria-label={`Key baru ${label}`} value={key} onChange={(e) => setKey(e.target.value)} placeholder="Key baru" />
      <button
        className="btn small primary"
        disabled={disabled || key.length < 8}
        onClick={() => {
          void onRotate(key).then(() => {
            setKey('');
            setOpen(false);
          });
        }}
      >
        Simpan
      </button>
      <button className="btn small" onClick={() => setOpen(false)}>
        Batal
      </button>
    </span>
  );
}

function AddConnection({ catalog, busy, onAdd }: { catalog: AiCatalogItem[]; busy: boolean; onAdd: (b: Parameters<Api['aiAdd']>[0]) => Promise<void> }) {
  const [provider, setProvider] = useState<ProviderId>('anthropic');
  const [label, setLabel] = useState('');
  const [model, setModel] = useState('');
  const [key, setKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [caps, setCaps] = useState<Capability[]>(['planner']);
  const [pin, setPin] = useState('0');
  const [pout, setPout] = useState('0');
  const [pmin, setPmin] = useState('0');
  const [open, setOpen] = useState(false);
  const item = catalog.find((c) => c.provider === provider);

  useEffect(() => {
    setCaps(item ? [item.capabilities[0]!] : ['planner']);
  }, [provider, item]);

  const submit = async () => {
    await onAdd({
      provider,
      ...(label.trim() ? { label: label.trim() } : {}),
      model: model.trim(),
      ...(key ? { api_key: key } : {}),
      capabilities: caps,
      ...(baseUrl.trim() ? { base_url: baseUrl.trim() } : {}),
      prices: { input_per_mtok: Number(pin) || 0, output_per_mtok: Number(pout) || 0, per_audio_minute: Number(pmin) || 0 },
    });
    setKey('');
    setModel('');
    setLabel('');
    setOpen(false);
  };

  return (
    <details className="addConn" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>＋ Tambah koneksi</summary>
      <div className="formGrid">
        <label>
          Provider
          <select aria-label="Provider" value={provider} onChange={(e) => setProvider(e.target.value as ProviderId)}>
            {catalog.map((c) => (
              <option key={c.provider} value={c.provider}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Nama
          <input aria-label="Nama koneksi" value={label} maxLength={60} onChange={(e) => setLabel(e.target.value)} placeholder={item?.label} />
        </label>
        <label>
          Model
          <input aria-label="Model" value={model} maxLength={100} onChange={(e) => setModel(e.target.value)} placeholder={item?.model_hint} />
        </label>
        <label>
          API key {item && !item.key_required && <span className="muted">(opsional)</span>}
          <input aria-label="API key" type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} />
        </label>
        <label>
          Alamat server {provider === 'openai_compatible' ? '' : <span className="muted">(kosongkan = resmi)</span>}
          <input aria-label="Alamat server" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder={item?.base_url ?? 'http://127.0.0.1:11434'} />
        </label>
        <fieldset>
          <legend>Kemampuan</legend>
          {(item?.capabilities ?? ['planner']).map((c) => (
            <label key={c} className="inline">
              <input type="checkbox" checked={caps.includes(c)} onChange={(e) => setCaps((x) => (e.target.checked ? [...x, c] : x.filter((y) => y !== c)))} /> {CAP[c]}
            </label>
          ))}
        </fieldset>
        <label>
          USD / 1M token input
          <input aria-label="Harga input" inputMode="decimal" value={pin} onChange={(e) => setPin(e.target.value)} />
        </label>
        <label>
          USD / 1M token output
          <input aria-label="Harga output" inputMode="decimal" value={pout} onChange={(e) => setPout(e.target.value)} />
        </label>
        {caps.includes('transcription') && (
          <label>
            USD / menit audio
            <input aria-label="Harga per menit audio" inputMode="decimal" value={pmin} onChange={(e) => setPmin(e.target.value)} />
          </label>
        )}
      </div>
      <p className="muted small">Isi harga sesuai halaman harga resmi provider: dipakai untuk memperkirakan biaya dan menahan panggilan yang melewati batas anggaran.</p>
      <button className="btn primary" disabled={busy || !model.trim() || !caps.length || (!!item?.key_required && key.length < 8)} onClick={() => void submit()}>
        Simpan koneksi
      </button>
    </details>
  );
}
