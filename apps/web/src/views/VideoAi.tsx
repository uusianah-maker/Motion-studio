import { useCallback, useEffect, useRef, useState } from 'react';
import type { Api, BrandAsset, Media, VideoAiJob } from '../api';
import { formatDuration } from '../lib';
import { Modal } from '../ui';

type Ref = { media_id: string; version_id: string };
const PLACED_KEY = 'ms.videoai.placed';
const placedSet = (): Set<string> => {
  try {
    return new Set(JSON.parse(localStorage.getItem(PLACED_KEY) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
};
const markPlaced = (id: string) => {
  try {
    const s = placedSet();
    s.add(id);
    localStorage.setItem(PLACED_KEY, JSON.stringify([...s].slice(-200)));
  } catch {
    /* storage off: the clip may be offered again after a reload — harmless (one more add_clip) */
  }
};

/**
 * 25 Nov (Video AI): the project's Video AI jobs, polled while one is running. A finished job with
 * a `tempat` is handed to `onReady` once (remembered per browser) so the editor can put the clip on
 * the timeline as an ordinary edit (one Undo). Without the editor open the video simply stays in Media.
 */
export function useVideoAi(api: Api, projectId: string | null, onReady: (j: VideoAiJob) => Promise<void> | void) {
  const [jobs, setJobs] = useState<VideoAiJob[]>([]);
  const ready = useRef(onReady);
  ready.current = onReady;
  const refresh = useCallback(async () => {
    if (!projectId) return;
    const list = await api.videoAiJobs(projectId).catch(() => null);
    if (!list) return;
    setJobs(list);
    const done = placedSet();
    for (const j of list) {
      if (j.state === 'siap' && j.tempat && j.hasil && !done.has(j.job_id)) {
        markPlaced(j.job_id);
        await ready.current(j);
      }
    }
  }, [api, projectId]);
  const active = jobs.some((j) => j.state === 'antre' || j.state === 'membuat');
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => void refresh(), 4000);
    return () => clearInterval(t);
  }, [active, refresh]);
  const start = useCallback(
    async (body: Parameters<Api['videoAiStart']>[1]) => {
      if (!projectId) return;
      const j = await api.videoAiStart(projectId, body);
      setJobs((x) => [...x.filter((y) => y.job_id !== j.job_id), j]);
    },
    [api, projectId],
  );
  return { jobs, active, start, refresh };
}

const STATUS: Record<string, string> = { queued: 'antre di beliapi', ready: 'siap diproses', submitting: 'dikirim', processing: 'sedang dibuat' };
export const jobLabel = (j: VideoAiJob) => (j.state === 'antre' ? 'menunggu giliran' : j.state === 'membuat' ? (STATUS[j.status ?? ''] ?? 'dibuat') : j.state === 'siap' ? 'selesai' : `gagal: ${j.alasan ?? ''}`);

/**
 * "＋ Video AI" (owner 25 Nov): prompt → OMNI FLASH 1.2 (beliapi). Text only, a picture as the
 * first frame, or 1–3 pictures as material. The clip lands in Media and on the B-roll track at the
 * playhead when ready (muted; the voice / music stay on).
 */
export function VideoAiDialog({ media, aset, ratio, playhead, jobs, start, onClose }: { media: readonly Media[]; aset: readonly BrandAsset[]; ratio: string; playhead: number; jobs: VideoAiJob[]; start: (b: Parameters<Api['videoAiStart']>[1]) => Promise<void>; onClose: () => void }) {
  const [prompt, setPrompt] = useState('');
  const [mode, setMode] = useState<'t2v' | 'sfv' | 'i2v'>('t2v');
  const [pick, setPick] = useState<Ref[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const r = ratio === '16:9' ? '16:9' : '9:16';
  // pictures: images in this project's Media + the brand's pictures (product photos, stickers …)
  const pics: { ref: Ref; nama: string }[] = [
    ...media.flatMap((m) => {
      const v = m.versions.find((x) => x.version_id === m.current_version_id) ?? m.versions[0];
      return v && /\.(png|jpe?g|webp)$/i.test(v.original_name) ? [{ ref: { media_id: m.media_id, version_id: v.version_id }, nama: v.original_name }] : [];
    }),
    ...aset.filter((a) => ['stiker', 'logo', 'frame', 'watermark', 'lainnya'].includes(a.jenis)).map((a) => ({ ref: a.ref, nama: a.nama || a.id })),
  ].filter((x, i, all) => all.findIndex((y) => y.ref.version_id === x.ref.version_id) === i);
  const max = mode === 'sfv' ? 1 : mode === 'i2v' ? 3 : 0;
  const toggle = (ref: Ref) => setPick((p) => (p.some((x) => x.version_id === ref.version_id) ? p.filter((x) => x.version_id !== ref.version_id) : [...p, ref].slice(-max)));
  const okPick = mode === 't2v' ? true : mode === 'sfv' ? pick.length === 1 : pick.length >= 1 && pick.length <= 3;
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await start({ prompt: prompt.trim(), mode, ratio: r, ...(mode !== 't2v' ? { media: pick } : {}), tempat: { start_ms: Math.round(playhead / 100) * 100, max_ms: null, asal: 'toolbar' } });
      setPrompt('');
      setPick([]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const mine = jobs.filter((j) => j.tempat?.asal === 'toolbar' || !j.tempat).slice(-6).reverse();
  return (
    <Modal title="Video AI (OMNI FLASH 1.2)" onClose={onClose}>
      <p className="muted small">Klip baru dibuat oleh beliapi.com, masuk ke Media, lalu otomatis ditaruh di track B-roll di playhead {formatDuration(playhead)} (tanpa suara). Satu video dibuat bergiliran; tab boleh ditutup, hasil tetap masuk Media.</p>
      <label className="videoAiPrompt">
        Prompt (apa yang terjadi di video)
        <textarea aria-label="Prompt Video AI" rows={4} maxLength={4400} value={prompt} placeholder="mis. Celana kulot coklat tertiup angin di taman, kamera mendekat pelan, cahaya sore" onChange={(e) => setPrompt(e.target.value)} />
      </label>
      <div className="row wrap" style={{ gap: 8, alignItems: 'center', marginTop: 6 }}>
        <label>
          Mode{' '}
          <select aria-label="Mode Video AI" value={mode} onChange={(e) => (setMode(e.target.value as typeof mode), setPick([]))}>
            <option value="t2v">Teks saja</option>
            <option value="sfv">Foto jadi awal video (1 gambar)</option>
            <option value="i2v">Pakai 1–3 gambar sebagai bahan</option>
          </select>
        </label>
        <span className="muted small">Rasio {r} (ikut kanvas)</span>
      </div>
      {max > 0 && (
        <div className="videoAiPics" role="group" aria-label="Gambar untuk Video AI">
          {!pics.length && <div className="muted small">Belum ada gambar di Media / Aset brand. Upload foto produk dulu.</div>}
          {pics.map((p) => {
            const on = pick.some((x) => x.version_id === p.ref.version_id);
            return (
              <button key={p.ref.version_id} className={`chip tiny${on ? ' on' : ''}`} aria-pressed={on} onClick={() => toggle(p.ref)} title={p.nama}>
                {on ? '✓ ' : ''}
                {p.nama.length > 28 ? `${p.nama.slice(0, 26)}…` : p.nama}
              </button>
            );
          })}
        </div>
      )}
      <div className="row" style={{ gap: 8, marginTop: 8 }}>
        <button className="btn primary small" disabled={busy || prompt.trim().length < 3 || !okPick} onClick={() => void submit()}>
          ✨ Buat video
        </button>
        {error && <span className="notice warn small">{error}</span>}
      </div>
      {mine.length > 0 && (
        <div className="videoAiJobs" role="list" aria-label="Antrean Video AI">
          {mine.map((j) => (
            <div key={j.job_id} role="listitem" className={`small videoAiJob ${j.state}`}>
              <b>{j.state === 'siap' ? '✓' : j.state === 'gagal' ? '✕' : '⏳'}</b> {j.prompt.slice(0, 60)} — {jobLabel(j)}
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}
