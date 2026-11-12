import { useCallback, useEffect, useRef, useState } from 'react';
import type { Api, GuardIssue, Project, RenderJob, RenderOutputFile, RenderPhase, RenderTools } from '../api';
import { formatBytes, formatDate, formatDuration } from '../lib';
import { ErrorNotice, Modal } from '../ui';

const PHASE: Record<RenderPhase, string> = {
  preflight: 'Memeriksa media, versi & ruang disk…',
  preparing: 'Menyiapkan bahan render…',
  encoding: 'Merender video…',
  verifying: 'Memverifikasi metadata sudah bersih…',
  saving: 'Menyimpan ke folder output…',
};

const PROBLEM: Record<string, string> = {
  NO_MEDIA: 'Linimasa belum berisi media.',
  MEDIA_TRASHED: 'Ada media di Trash. Pulihkan dulu dari menu Trash.',
  MEDIA_PURGED: 'Ada media yang sudah dihapus permanen. Ganti klipnya.',
  MEDIA_MISSING: 'File media hilang dari workspace.',
  MEDIA_CHANGED: 'File media berubah sejak diimpor (isi tidak cocok). Impor ulang file aslinya.',
  MEDIA_BUSY: 'Ada media yang sedang dipindah. Coba lagi sebentar.',
  MEDIA_UNKNOWN: 'Ada klip yang merujuk media tak dikenal.',
  OUTPUT_NOT_WRITABLE: 'Folder output tidak bisa ditulis.',
  INSUFFICIENT_DISK: 'Ruang disk tidak cukup untuk render ini.',
  BRAND_BLOCKED: 'Brand guard: ada harga kedaluwarsa / klaim terlarang di video. Ubah teksnya dulu.',
  BRAND_WARNING: 'Brand guard: ada peringatan yang belum dikonfirmasi.',
};

const fmtT = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`;
const issueText = (i: GuardIssue) =>
  i.kind === 'PRICE_EXPIRED' ? `Harga "${i.match}" sudah lewat masa berlaku (${i.valid_until})` : `Klaim terlarang "${i.match}"`;

const TOOL: Record<string, string> = {
  FFMPEG_MISSING: 'FFmpeg tidak ditemukan di server (pasang FFmpeg atau set MOTION_FFMPEG).',
  FFMPEG_TOO_OLD: 'FFmpeg terlalu lama; butuh versi 7 ke atas.',
  FFMPEG_NO_LIBX264: 'FFmpeg ini tidak punya encoder H.264 (libx264).',
  FFMPEG_NO_DRAWTEXT: 'FFmpeg ini tidak bisa menulis teks (drawtext).',
  FFPROBE_MISSING: 'ffprobe tidak ditemukan (dipakai untuk verifikasi metadata).',
};

const active = (j: RenderJob) => j.status === 'queued' || j.status === 'running';

/**
 * Render MP4 (W08). Jobs run on the server; this dialog only starts, watches and cancels them,
 * so it can be closed and reopened while a render runs. Every finished file has passed the
 * metadata check (owner rule) — a file that fails it is never saved.
 */
export function RenderDialog({ api, project, onClose }: { api: Api; project: Project; onClose: () => void }) {
  const [tools, setTools] = useState<RenderTools | null>(null);
  const [jobs, setJobs] = useState<RenderJob[]>([]);
  const [outputs, setOutputs] = useState<RenderOutputFile[]>([]);
  const [name, setName] = useState(project.name);
  const [short, setShort] = useState<720 | 1080>(1080);
  const [error, setError] = useState<unknown>(null);
  const [starting, setStarting] = useState(false);
  const [playing, setPlaying] = useState<{ name: string; url: string } | null>(null);
  const alive = useRef(true);
  /** X08: Brand guard result for the current timeline (null = not loaded yet). */
  const [issues, setIssues] = useState<GuardIssue[] | null>(null);
  const [acceptWarn, setAcceptWarn] = useState(false);
  useEffect(() => {
    api.brandCheck(project.project_id).then((r) => alive.current && setIssues(r.issues), () => setIssues([]));
  }, [api, project.project_id, project.revision]);
  const blocking = (issues ?? []).filter((i) => i.level === 'block');
  const warnings = (issues ?? []).filter((i) => i.level === 'warn');

  const refresh = useCallback(async () => {
    const r = await api.renders(project.project_id);
    if (!alive.current) return;
    setJobs(r.jobs);
    setOutputs(r.outputs);
  }, [api, project.project_id]);

  useEffect(() => {
    alive.current = true;
    api.renderTools().then((t) => alive.current && setTools(t), setError);
    refresh().catch(setError);
    return () => {
      alive.current = false;
    };
  }, [api, refresh]);

  const running = jobs.some(active);
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => void refresh().catch(setError), 600);
    return () => clearInterval(id);
  }, [running, refresh]);

  const start = async () => {
    setError(null);
    setStarting(true);
    try {
      await api.startRender(project.project_id, { output_name: name.trim() || project.name, short_side: short, ...(acceptWarn && warnings.length ? { accept_brand_warnings: true } : {}) });
      await refresh();
    } catch (e) {
      setError(e);
    } finally {
      setStarting(false);
    }
  };

  const play = async (o: RenderOutputFile) => {
    setError(null);
    try {
      setPlaying({ name: o.name, url: (await api.outputUrl(project.project_id, o.name)).url });
    } catch (e) {
      setError(e);
    }
  };

  const download = async (o: RenderOutputFile) => {
    setError(null);
    try {
      const { url } = await api.outputUrl(project.project_id, o.name, true);
      const a = document.createElement('a');
      a.href = url;
      a.download = o.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (e) {
      setError(e);
    }
  };

  const ratio = project.timeline.canvas?.ratio ?? '9:16';
  const [a, b] = ratio.split(':').map(Number) as [number, number];
  const size = a <= b ? `${short}×${Math.round((short * b) / a / 2) * 2}` : `${Math.round((short * a) / b / 2) * 2}×${short}`;
  const latest = jobs[0];
  const blockedTools = tools && !tools.ok;

  return (
    <Modal title="Render MP4" onClose={onClose}>
      <p>
        Hasil render disimpan sebagai file baru di folder output proyek. Nama yang sudah ada tidak ditimpa (jadi <code>_v2</code>, <code>_v3</code>…). File asli tidak pernah diubah.
      </p>
      <div className="notice info" role="note">
        🔒 Metadata (judul, lokasi/GPS, perangkat, encoder, tanggal) <b>dihapus otomatis</b> dan diverifikasi ulang sebelum file dinyatakan jadi. Kalau verifikasi gagal, file tidak disimpan.
      </div>
      {blockedTools && (
        <div className="notice warn" role="alert">
          <b>Render belum bisa jalan di server ini:</b>
          <ul>
            {tools.problems.map((p) => (
              <li key={p}>{TOOL[p] ?? p}</li>
            ))}
          </ul>
        </div>
      )}
      {tools?.ok && !tools.font && <div className="notice warn">Font untuk teks/subtitle tidak ditemukan; proyek dengan teks belum bisa dirender (set MOTION_FONT).</div>}
      <ErrorNotice error={error} />
      {blocking.length > 0 && (
        <div className="notice err" role="alert" aria-label="Brand guard memblokir">
          <b>Brand guard: render diblokir sampai teks ini diubah</b>
          <ul className="guardList">
            {blocking.map((i, k) => (
              <li key={k}>
                {issueText(i)} — {i.track_kind === 'subtitle' ? 'subtitle' : 'teks'} “{i.text}” di {fmtT(i.start_ms)}
              </li>
            ))}
          </ul>
          <span className="muted small">Aturan ada di menu Brand → Brand guard.</span>
        </div>
      )}
      {warnings.length > 0 && (
        <div className="notice warn" role="note" aria-label="Brand guard memperingatkan">
          <b>Brand guard: periksa dulu</b>
          <ul className="guardList">
            {warnings.map((i, k) => (
              <li key={k}>
                {issueText(i)} — {i.track_kind === 'subtitle' ? 'subtitle' : 'teks'} “{i.text}” di {fmtT(i.start_ms)}
              </li>
            ))}
          </ul>
          <label className="inline">
            <input type="checkbox" aria-label="Render tetap meski ada peringatan Brand guard" checked={acceptWarn} onChange={(e) => setAcceptWarn(e.target.checked)} /> Sudah gue cek, render tetap (tercatat di audit)
          </label>
        </div>
      )}

      <div className="renderForm">
        <label>
          <span className="muted">Nama file</span>
          <span className="nameField">
            <input value={name} maxLength={120} onChange={(e) => setName(e.target.value)} aria-label="Nama file output" />
            <span className="muted">.mp4</span>
          </span>
        </label>
        <label>
          <span className="muted">Resolusi</span>
          <select value={short} onChange={(e) => setShort(Number(e.target.value) as 720 | 1080)} aria-label="Resolusi render">
            <option value={1080}>1080p</option>
            <option value={720}>720p</option>
          </select>
        </label>
        <span className="muted renderSize">
          {ratio} · {size} · 30 fps · H.264/AAC
        </span>
        <button className="btn primary" onClick={() => void start()} disabled={starting || !!blockedTools || !tools || issues === null || blocking.length > 0 || (warnings.length > 0 && !acceptWarn)}>
          {running ? '＋ Antrekan render' : '↧ Mulai render'}
        </button>
      </div>

      {latest && (
        <div className="card renderJob" aria-live="polite">
          <div className="row">
            <b>{latest.output_name}</b>
            <span className={`badge ${latest.status === 'completed' ? 'ok' : latest.status === 'failed' || latest.status === 'blocked' ? 'bad' : ''}`}>{STATUS[latest.status]}</span>
            <div className="spacer" />
            {active(latest) && (
              <button className="btn small" onClick={() => void api.cancelRender(latest.job_id).then(refresh).catch(setError)}>
                Batalkan
              </button>
            )}
          </div>
          {active(latest) && (
            <>
              <div className="muted">{latest.status === 'queued' ? 'Menunggu render lain selesai…' : latest.phase ? PHASE[latest.phase] : 'Memulai…'}</div>
              <div className="bar" role="progressbar" aria-label="Progres render" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(latest.progress * 100)}>
                <span style={{ width: `${Math.max(2, Math.round(latest.progress * 100))}%` }} />
              </div>
            </>
          )}
          {latest.status === 'completed' && latest.output && (
            <div className="muted">
              ✓ Jadi: {latest.output.width}×{latest.output.height}, {formatDuration(latest.output.duration_ms)}, {formatBytes(latest.output.size)} · metadata bersih (terverifikasi)
            </div>
          )}
          {latest.status === 'blocked' && (
            <ul className="problems">
              {latest.problems.map((p, i) => (
                <li key={i}>
                  {PROBLEM[p.code] ?? p.code}
                  {p.issues?.length ? ` (${p.issues.map(issueText).join('; ')})` : ''}
                </li>
              ))}
            </ul>
          )}
          {(latest.status === 'failed' || latest.status === 'cancelled') && latest.error && <div className="muted">{latest.error.message}</div>}
        </div>
      )}

      <h3 className="renderOutTitle">Hasil render</h3>
      {outputs.length === 0 ? (
        <div className="muted">Belum ada file hasil render untuk proyek ini.</div>
      ) : (
        <ul className="outputs">
          {outputs.map((o) => (
            <li key={o.name}>
              <span className="outName" title={o.name}>
                {o.name}
              </span>
              <span className="muted">
                {formatBytes(o.size)} · {formatDate(o.mtime_ms)}
              </span>
              <button className="btn small" onClick={() => void play(o)} aria-label={`Putar ${o.name}`}>
                ▶ Putar
              </button>
              <button className="btn small" onClick={() => void download(o)} aria-label={`Unduh ${o.name}`}>
                ⤓ Unduh
              </button>
            </li>
          ))}
        </ul>
      )}
      {playing && (
        <div className="outputPlayer">
          <div className="row">
            <b>{playing.name}</b>
            <div className="spacer" />
            <button className="btn small" onClick={() => setPlaying(null)}>
              Tutup
            </button>
          </div>
          <video src={playing.url} controls playsInline aria-label="Putar hasil render" />
        </div>
      )}
      <div className="row" style={{ marginTop: 14 }}>
        <div className="spacer" />
        <button className="btn" onClick={onClose}>
          Tutup
        </button>
      </div>
    </Modal>
  );
}

const STATUS: Record<RenderJob['status'], string> = {
  queued: 'Antre',
  running: 'Berjalan',
  completed: 'Selesai',
  failed: 'Gagal',
  cancelled: 'Dibatalkan',
  blocked: 'Tertahan',
};
