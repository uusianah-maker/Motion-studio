import { useCallback, useEffect, useState } from 'react';
import type { AiCatalogItem, AiConnection, AiLogEntry, AiSettings, AiUsage, Api, Capability, ImageAiUsage, ImageAiView, ProviderId } from '../api';
import { formatDate, parseDecimal } from '../lib';
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
  const [usage, setUsage] = useState<AiUsage | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [p, l, u] = await Promise.all([api.aiProviders(), api.aiLog(), api.aiUsage()]);
    setUsage(u);
    setConns(p.connections.sort((a, b) => a.priority - b.priority));
    setSettings(p.settings);
    setCatalog(p.catalog);
    setLog(l);
  }, [api]);

  useEffect(() => {
    load().catch(setError);
  }, [load]);

  /** Resolves true when it worked (forms clear themselves only then — audit 14 Nov). */
  const act = async (fn: () => Promise<unknown>, ok?: string): Promise<boolean> => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
      if (ok) setNotice(ok);
      await load().catch(setError);
      return true;
    } catch (e) {
      setError(e);
      return false;
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
      <p className="muted">Satu kunci untuk semua fitur AI: Copilot di Edit dan gambar Ganti Outfit. Kunci disimpan terkunci di server dan tidak pernah ditampilkan lagi.</p>
      <ErrorNotice error={error} />
      {notice && (
        <div className="notice ok" role="status">
          {notice}
        </div>
      )}

      <TempelKunci api={api} conns={conns} onDone={() => load().catch(setError)} />

      <details className="card aiSection" aria-label="Pengaturan lanjutan AI">
      <summary>
        <b>Pengaturan lanjutan</b> <span className="muted small">(tidak perlu diubah — AI gambar, mode, koneksi manual, batas biaya, log)</span>
      </summary>
      <ImageAiSection api={api} />
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

      {settings && usage && <BudgetSection settings={settings} usage={usage} busy={busy} onSave={(b) => act(() => api.aiSettings({ budget: b }), 'Batas anggaran disimpan.')} />}

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
      </details>
    </div>
  );
}

/**
 * 27 Nov owner: "cukup masukin API-nya, otomatis test bisa atau tidaknya". One box: the server
 * finds where the key belongs (OpenAI / Claude / Gemini / apimart), picks a model, tests it with a
 * tiny call and turns Copilot on. Everything else lives under "Pengaturan lanjutan".
 */
function TempelKunci({ api, conns, onDone }: { api: Api; conns: AiConnection[]; onDone: () => void }) {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [hasil, setHasil] = useState<{ ok: boolean; pesan: string } | null>(null);
  const aktif = conns.filter((c) => c.enabled && c.has_key && c.capabilities.includes('planner'));
  const sambung = async () => {
    setBusy(true);
    setHasil({ ok: true, pesan: 'Mengecek kunci… (bisa sampai 1 menit)' });
    try {
      const r = await api.aiTempel(key.trim());
      if (r.ok) {
        setKey('');
        const g = r.gambar.status === 'dipakai' ? ` Gambar Ganti Outfit juga memakai kunci ini (${r.gambar.model}).` : r.gambar.status === 'sudah_ada' ? ' Gambar Ganti Outfit tetap memakai kunci gambar yang sudah tersimpan.' : ' Kunci ini belum boleh membuat gambar — Ganti Outfit tetap memakai kunci gambar lama (kalau ada).';
        setHasil({ ok: true, pesan: `✓ Berhasil. Kunci dari ${r.penyedia}, model ${r.model}. Copilot sudah aktif.${g}` });
        onDone();
      } else setHasil({ ok: false, pesan: `✗ ${r.pesan}` });
    } catch (e) {
      setHasil({ ok: false, pesan: `✗ ${e instanceof Error ? e.message : 'Gagal mengecek kunci'}` });
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card aiSection" aria-label="Tempel API key AI">
      <h3>API key AI</h3>
      {/* 27 Nov: "Tersambung" only when the last test worked — a saved key alone proves nothing. */}
      {aktif.length > 0 ? (
        aktif.map((c) => (
          <p className="small" key={c.connection_id}>
            {c.status === 'ok' ? (
              <span className="badge ok">Tersambung</span>
            ) : c.status === 'untested' ? (
              <span className="badge">Belum dites</span>
            ) : (
              <span className="badge bad">{c.status === 'needs_admin' ? 'Gagal: kunci ditolak' : 'Gagal terakhir'}</span>
            )}{' '}
            {c.label} · {c.model}
            {c.status !== 'ok' && c.status !== 'untested' && <span className="muted"> — tempel ulang kunci yang benar di bawah</span>}
          </p>
        ))
      ) : (
        <p className="muted small">Belum tersambung.</p>
      )}
      <p className="muted small">Cukup tempel API key (apimart.ai, OpenAI, Claude, atau Gemini), lalu klik Sambungkan. Aplikasi mengecek sendiri kunci itu dari mana, apakah bisa dipakai, dan memilih modelnya.</p>
      <div className="row wrap" style={{ gap: 6 }}>
        <input type="password" autoComplete="off" aria-label="Tempel API key" placeholder="Tempel API key di sini" value={key} onChange={(e) => setKey(e.target.value)} style={{ flex: 1, minWidth: 220 }} />
        <button className="btn primary" disabled={busy || key.trim().length < 8} onClick={() => void sambung()}>
          {busy ? 'Mengecek…' : 'Sambungkan'}
        </button>
      </div>
      {hasil && (
        <div className={`notice ${hasil.ok ? 'ok' : 'bad'}`} role="status">
          {hasil.pesan}
        </div>
      )}
    </section>
  );
}

const money = (n: number) => `$${n.toFixed(4)}`;

function Meter({ label, spent, cap }: { label: string; spent: number; cap: number }) {
  const pct = cap > 0 ? Math.min(100, (spent / cap) * 100) : spent > 0 ? 100 : 0;
  return (
    <div className="meter">
      <div className="row">
        <span>{label}</span>
        <span className="spacer" />
        <b>
          {money(spent)} / {money(cap)}
        </b>
      </div>
      <div className="bar" role="progressbar" aria-label={`Pemakaian ${label}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}>
        <span className={pct >= 90 ? 'hot' : ''} style={{ width: `${Math.max(1, pct)}%` }} />
      </div>
    </div>
  );
}

function BudgetSection({ settings, usage, busy, onSave }: { settings: AiSettings; usage: AiUsage; busy: boolean; onSave: (b: AiSettings['budget']) => Promise<boolean> }) {
  const [daily, setDaily] = useState(String(settings.budget.daily_usd));
  const [monthly, setMonthly] = useState(String(settings.budget.monthly_usd));
  const [perReq, setPerReq] = useState(String(settings.budget.per_request_usd));
  useEffect(() => {
    setDaily(String(settings.budget.daily_usd));
    setMonthly(String(settings.budget.monthly_usd));
    setPerReq(String(settings.budget.per_request_usd));
  }, [settings.budget.daily_usd, settings.budget.monthly_usd, settings.budget.per_request_usd]);
  // "0,5" is half a dollar; an empty field is not 0 (that would block all AI).
  const nums = [daily, monthly, perReq].map(parseDecimal);
  const valid = nums.every((n) => n !== null && n >= 0);
  return (
    <section className="card aiSection" aria-label="Anggaran dan pemakaian AI">
      <h3>Anggaran &amp; pemakaian</h3>
      <p className="muted small">
        Batas keras: panggilan AI yang perkiraan biayanya melewati batas ditolak <b>sebelum</b> dikirim. Biaya sebenarnya dicatat dari angka pemakaian provider.
      </p>
      <Meter label="Hari ini" spent={usage.today.usd} cap={settings.budget.daily_usd} />
      <Meter label="Bulan ini" spent={usage.month.usd} cap={settings.budget.monthly_usd} />
      <div className="formGrid">
        <label>
          Batas harian (USD)
          <input aria-label="Batas harian" inputMode="decimal" value={daily} onChange={(e) => setDaily(e.target.value)} />
        </label>
        <label>
          Batas bulanan (USD)
          <input aria-label="Batas bulanan" inputMode="decimal" value={monthly} onChange={(e) => setMonthly(e.target.value)} />
        </label>
        <label>
          Maks per permintaan (USD)
          <input aria-label="Batas per permintaan" inputMode="decimal" value={perReq} onChange={(e) => setPerReq(e.target.value)} />
        </label>
      </div>
      <div>
        <button className="btn primary" disabled={busy || !valid} onClick={() => void onSave({ daily_usd: nums[0]!, monthly_usd: nums[1]!, per_request_usd: nums[2]! })}>
          Simpan batas
        </button>
      </div>
      {usage.by_model.length > 0 && (
        <table className="list small" aria-label="Pemakaian per model bulan ini">
          <thead>
            <tr>
              <th>Model (bulan ini)</th>
              <th>Panggilan</th>
              <th className="hideNarrow">Token in/out</th>
              <th>Biaya</th>
            </tr>
          </thead>
          <tbody>
            {usage.by_model.map((m) => (
              <tr key={`${m.provider}|${m.model}`}>
                <td>
                  {m.provider} · {m.model}
                </td>
                <td>
                  {m.calls - m.failed}
                  {m.failed ? ` (+${m.failed} gagal)` : ''}
                </td>
                <td className="hideNarrow">
                  {m.input_tokens.toLocaleString('id-ID')} / {m.output_tokens.toLocaleString('id-ID')}
                  {m.audio_seconds ? ` · ${Math.round(m.audio_seconds)} dtk audio` : ''}
                </td>
                <td>{money(m.usd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function RotateKey({ onRotate, disabled, label }: { onRotate: (key: string) => Promise<boolean>; disabled: boolean; label: string }) {
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
          void onRotate(key).then((ok) => {
            if (!ok) return;
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

function AddConnection({ catalog, busy, onAdd }: { catalog: AiCatalogItem[]; busy: boolean; onAdd: (b: Parameters<Api['aiAdd']>[0]) => Promise<boolean> }) {
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
    const ok = await onAdd({
      provider,
      ...(label.trim() ? { label: label.trim() } : {}),
      model: model.trim(),
      ...(key ? { api_key: key } : {}),
      capabilities: caps,
      ...(baseUrl.trim() ? { base_url: baseUrl.trim() } : {}),
      prices: { input_per_mtok: parseDecimal(pin) ?? 0, output_per_mtok: parseDecimal(pout) ?? 0, per_audio_minute: parseDecimal(pmin) ?? 0 },
    });
    if (!ok) return; // keep what was typed so it can be fixed
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

/**
 * R12a: "AI gambar" for Motion Transfer stage 2 (owner fills in the account later). The key goes
 * to the server only and is never shown again (just "tersimpan ••••abcd"). Not used yet.
 */
function ImageAiSection({ api }: { api: Api }) {
  const [v, setV] = useState<ImageAiView | null>(null);
  const [provider, setProvider] = useState<'' | 'openai' | 'gemini' | 'beliapi' | 'apimart' | 'lainnya'>('');
  const [endpoint, setEndpoint] = useState('');
  const [model, setModel] = useState('');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState<'IDR' | 'USD'>('IDR');
  const [harga, setHarga] = useState('');
  const [pakai, setPakai] = useState<ImageAiUsage | null>(null);
  const [key, setKey] = useState('');
  const [changingKey, setChangingKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const fill = (g: ImageAiView) => {
    setV(g);
    setProvider(g.provider ?? '');
    setEndpoint(g.endpoint ?? '');
    setModel(g.model ?? '');
    setAmount(g.budget.amount === null ? '' : String(g.budget.amount));
    setCurrency(g.budget.currency);
    setHarga(g.harga_per_gambar === null ? '' : String(g.harga_per_gambar));
    void api.imageAiUsage().then(setPakai, () => undefined);
  };
  useEffect(() => {
    void api.imageAi().then(fill, setError);
  }, [api]);
  const run = async (fn: () => Promise<ImageAiView>, ok: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      fill(await fn());
      setNotice(ok);
      return true;
    } catch (e) {
      setError(e);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const p = v?.providers.find((x) => x.id === provider);
  const amountNum = parseDecimal(amount);
  const amountOk = amount.trim() === '' || (amountNum !== null && amountNum >= 0);
  const hargaNum = parseDecimal(harga);
  const hargaOk = harga.trim() === '' || (hargaNum !== null && hargaNum >= 0);
  const uang = (n: number) => (currency === 'IDR' ? `Rp ${Math.round(n).toLocaleString('id-ID')}` : `USD ${n.toFixed(2)}`);
  return (
    <section className="card aiSection" aria-label="AI gambar">
      <h3>AI gambar (Beat Spot Ganti Outfit)</h3>
      <p className="muted small">
        Dipakai Beat Spot <b>Ganti Outfit</b> untuk membuat gambar (1 gambar per footage): OpenAI gpt-image, atau <b>beliapi.com</b> (Nano Banana, pilih penyedianya — key beliapi tidak bisa dikenali otomatis). Cukup tempel API key: penyedia dikenali dari key, model kosong = model gambar terbaru yang terbaca saat Tes koneksi. API key disimpan terenkripsi di server dan tidak pernah ditampilkan lagi.
      </p>
      <ErrorNotice error={error} />
      {notice && (
        <div className="notice ok small" role="status">
          {notice}
        </div>
      )}
      <div className="formGrid">
        <label>
          Penyedia
          <select aria-label="Penyedia AI gambar" value={provider} disabled={busy} onChange={(e) => setProvider(e.target.value as typeof provider)}>
            <option value="">— Otomatis dari API key —</option>
            {(v?.providers ?? []).map((x) => (
              <option key={x.id} value={x.id}>
                {x.label}
              </option>
            ))}
          </select>
        </label>
        {p?.needs_endpoint && (
          <label>
            URL endpoint
            <input aria-label="URL endpoint AI gambar" value={endpoint} placeholder="https://…" onChange={(e) => setEndpoint(e.target.value)} />
          </label>
        )}
        <label>
          Model (opsional)
          <input aria-label="Model AI gambar" value={model} maxLength={100} placeholder={v?.model_dipakai ? `otomatis: ${v.model_dipakai}` : p?.model_hint || 'otomatis'} onChange={(e) => setModel(e.target.value)} />
        </label>
        <label>
          Batas biaya per bulan (opsional)
          <span className="row" style={{ gap: 4 }}>
            <input aria-label="Batas biaya AI gambar" inputMode="decimal" value={amount} placeholder="kosong = tanpa batas" onChange={(e) => setAmount(e.target.value)} />
            <select aria-label="Mata uang batas AI gambar" value={currency} onChange={(e) => setCurrency(e.target.value as 'IDR' | 'USD')}>
              <option value="IDR">Rp</option>
              <option value="USD">USD</option>
            </select>
          </span>
        </label>
        <label>
          Perkiraan harga per gambar {amount.trim() ? '(wajib kalau ada batas)' : '(opsional)'}
          <input aria-label="Perkiraan harga per gambar" inputMode="decimal" value={harga} placeholder={currency === 'IDR' ? 'mis. 3000' : 'mis. 0.2'} onChange={(e) => setHarga(e.target.value)} />
        </label>
      </div>
      {pakai && (
        <p className="small muted" aria-label="Pemakaian AI gambar">
          Bulan ini ({pakai.bulan}): {pakai.gambar} gambar{pakai.harga_per_gambar !== null ? ` · perkiraan ${uang(pakai.biaya)}` : ''}
          {pakai.batas !== null ? ` dari batas ${uang(pakai.batas)}` : ' · tanpa batas'}. Cek tagihan asli di halaman billing penyedia.
        </p>
      )}
      <button
        className="btn primary"
        disabled={busy || !amountOk || !hargaOk}
        onClick={() =>
          void run(
            () => api.saveImageAi({ provider: provider || null, endpoint: p?.needs_endpoint ? endpoint.trim() || null : null, model: model.trim() || null, budget: { amount: amount.trim() ? amountNum : null, currency }, harga_per_gambar: harga.trim() ? hargaNum : null }),
            'Pengaturan AI gambar disimpan.',
          )
        }
      >
        Simpan pengaturan
      </button>
      <div className="row wrap" style={{ gap: 8, alignItems: 'center', marginTop: 10 }}>
        <b className="small">API key:</b>
        {v?.key_saved && !changingKey ? (
          <>
            <span className="badge ok" aria-label="Status API key AI gambar">
              tersimpan ••••{v.key_hint}
            </span>
            <button className="btn small" disabled={busy} onClick={() => setChangingKey(true)}>
              Ganti
            </button>
            <button className="btn small danger" disabled={busy} onClick={() => window.confirm('Hapus API key AI gambar dari server?') && void run(() => api.setImageAiKey(null), 'API key dihapus.')}>
              Hapus
            </button>
          </>
        ) : (
          <>
            <input type="password" autoComplete="off" aria-label="API key AI gambar" value={key} placeholder="Tempel API key" onChange={(e) => setKey(e.target.value)} />
            <button
              className="btn small primary"
              disabled={busy || key.length < 8}
              onClick={() =>
                void run(() => api.setImageAiKey(key), 'API key disimpan (terenkripsi).').then((ok) => {
                  if (!ok) return;
                  setKey('');
                  setChangingKey(false);
                })
              }
            >
              Simpan key
            </button>
            {changingKey && (
              <button className="btn small" onClick={() => (setChangingKey(false), setKey(''))}>
                Batal
              </button>
            )}
          </>
        )}
        <button className="btn small" disabled={busy || !v?.key_saved} onClick={() => void run(() => api.testImageAi(), 'Tes selesai.')} title="Hanya membaca daftar model (gratis), tidak membuat gambar">
          Tes koneksi
        </button>
        {v?.last_test && <span className={`badge ${v.last_test.ok ? 'ok' : 'bad'}`}>{v.last_test.message}</span>}
      </div>
    </section>
  );
}
