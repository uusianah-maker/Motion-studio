import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Api, BatchRow, BrandKit, EngineBatchInfo, LibraryShot, PisahResult, Role, ShotLibrary } from '../api';
import { readyJobShown } from '../lib';
import { ErrorNotice } from '../ui';
import { EngineProgress, useEngineJob } from './GenerateView';

/**
 * Batch Remix library (audit yuki, 14 Nov): Pisah Audio from the dashboard, the batch list from
 * the engine, the Shot Library with the team's exclusions, and the shots behind each VO sentence.
 * Thumbnails are made by the engine and come as data URLs (an <img> cannot send the session).
 */
const today = () => new Date().toISOString().slice(0, 10);
const sec = (n: number) => `${n.toFixed(1).replace('.', ',')}`;

// ------------------------------------------------------------------ thumbnails

const thumbCache = new Map<string, string | null>(); // `${batch}|${id}` → data URL (null = none)
const MAX_CACHED = 1500;
/** After Pisah Audio re-ran a batch its thumbnails may be new. */
export function forgetThumbs(batch: string): void {
  for (const k of [...thumbCache.keys()]) if (k.startsWith(`${batch}|`)) thumbCache.delete(k);
}

export function useShotThumbs(api: Api, batch: string | null, ids: string[]): Record<string, string> {
  const key = ids.join(',');
  const [, bump] = useState(0);
  useEffect(() => {
    if (!batch || !key) return;
    const missing = key.split(',').filter((id) => !thumbCache.has(`${batch}|${id}`));
    if (!missing.length) return;
    let stop = false;
    void (async () => {
      for (let i = 0; i < missing.length && !stop; i += 60) {
        const part = missing.slice(i, i + 60);
        let got: Record<string, string>;
        try {
          got = await api.engineThumbs(batch, part);
        } catch {
          continue; // a failed request is not "no thumbnail": asked again next time
        }
        // Data URLs are ~30 KB each: keep the most recent ones only.
        if (thumbCache.size > MAX_CACHED) for (const k of [...thumbCache.keys()].slice(0, thumbCache.size - MAX_CACHED + part.length)) thumbCache.delete(k);
        for (const id of part) thumbCache.set(`${batch}|${id}`, got[id] ?? null);
        if (!stop) bump((n) => n + 1);
      }
    })();
    return () => {
      stop = true;
    };
  }, [api, batch, key]);
  const out: Record<string, string> = {};
  if (batch) for (const id of ids) {
    const t = thumbCache.get(`${batch}|${id}`);
    if (t) out[id] = t;
  }
  return out;
}

function ShotThumb({ src, id, small }: { src: string | undefined; id: string; small?: boolean }) {
  return src ? <img className={`shotThumb${small ? ' small' : ''}`} src={src} alt={`Shot ${id}`} loading="lazy" /> : <div className={`shotThumb none${small ? ' small' : ''}`} aria-label={`Shot ${id} tanpa thumbnail`} />;
}

/** Labels worth a badge: true booleans and short text (framing). */
function labelBadges(s: LibraryShot): string[] {
  return Object.entries(s.label)
    .filter(([, v]) => v === true || (typeof v === 'string' && v.length <= 20))
    .map(([k, v]) => (v === true ? k : `${k}: ${v}`));
}

// ------------------------------------------------------------------ batch list

export function useEngineBatches(api: Api, enabled: boolean) {
  const [state, setState] = useState<{ tersedia: boolean; batches: EngineBatchInfo[]; alasan: string | null } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const reload = useCallback(async () => {
    if (!enabled) return;
    try {
      setState(await api.engineBatches());
    } catch (e) {
      setError(e);
    }
  }, [api, enabled]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { list: state, error, reload };
}

export const batchLabel = (b: EngineBatchInfo) => `${b.batch} · ${b.footage} footage · ${b.vo} VO${b.shot_library ? ` · ${b.jumlah_shot} shot` : ' · Shot Library belum ada'}`;

// ------------------------------------------------------------------ Pisah Audio

/** Upload footage into a new "Footage <batch>" project, then `engine pisah` (Demucs + Shot Library). */
export function PisahPanel({ api, role, brand, installed, onDone }: { api: Api; role: Role; brand: BrandKit | null; installed: boolean; onDone: (batch: string) => void }) {
  const [batch, setBatch] = useState(`${today()}_footage`);
  const [files, setFiles] = useState<File[]>([]);
  const [videoSaja, setVideoSaja] = useState(false);
  const [busy, setBusy] = useState(false);
  const [upload, setUpload] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [current, setCurrent] = useState<{ project_id: string; job_id: string } | null>(null);
  const [result, setResult] = useState<PisahResult | null>(null);
  const { job, log, error: jobError } = useEngineJob(api, current?.project_id ?? null, current?.job_id ?? null);
  // The parent's callback, read once per finished job (not a reason to re-read the result).
  const done = useRef(onDone);
  done.current = onDone;
  // Only the CURRENT job's own "siap" (the previous job's state lingers for one render).
  const finished = readyJobShown(job, current);
  useEffect(() => {
    if (!finished || !current) return;
    void api.enginePisahResult(current.project_id, current.job_id).then((r) => {
      setError(null);
      setResult(r);
      if (r.batch) {
        forgetThumbs(r.batch);
        done.current(r.batch);
      }
    }, setError);
  }, [api, finished, current]);

  const unstarted = useRef<string | null>(null);
  const nameOk = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(batch) && !batch.includes('..');
  const start = async () => {
    if (!brand || !files.length) return;
    // Checked before anything is uploaded: a refusal after the upload would leave a stray project.
    if (!nameOk) return setError(new Error('Nama batch: mulai huruf/angka, lalu huruf, angka, _ . -'));
    if (!brand.kode) return setError(new Error('Brand belum punya kode (Brand Kit → A)'));
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      // A project made for a start that then failed is reused by the retry (audit 14 Nov).
      const p = unstarted.current ? { project_id: unstarted.current } : await api.createProject(`Footage ${batch}`.slice(0, 120));
      unstarted.current = p.project_id;
      const full = await api.project(p.project_id);
      if (full.brand_id !== brand.brand_id) await api.updateProject(p.project_id, full.revision, { brand_id: brand.brand_id });
      const sources: { kunci: string; ref: { media_id: string; version_id: string } }[] = [];
      const used = new Set<string>();
      for (const [i, f] of files.entries()) {
        setUpload(`Upload ${i + 1}/${files.length}: ${f.name}`);
        const r = await api.importFile(f, { kind: 'project', project_id: p.project_id }, (x) => setUpload(`Upload ${i + 1}/${files.length}: ${f.name} · ${Math.round(x * 100)}%`));
        // The name becomes the file name in the engine (IN1.mp4 → IN1): safe and unique.
        const stem = (f.name.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 36) || 'video').replace(/^_+/, '') || 'video';
        let name = stem;
        for (let n = 2; used.has(name.toLowerCase()); n++) name = `${stem}-${n}`;
        used.add(name.toLowerCase());
        sources.push({ kunci: `$sumber:${name}`, ref: { media_id: r.media_id, version_id: r.version.version_id } });
      }
      setUpload(null);
      const j = await api.enginePisah(p.project_id, { mode: 'pisah', sources, pisah: { batch, ...(videoSaja ? { video_saja: true } : {}) } });
      unstarted.current = null;
      setCurrent({ project_id: p.project_id, job_id: j.job_id });
    } catch (e) {
      setError(e);
      setUpload(null);
    } finally {
      setBusy(false);
    }
  };
  const live = job?.state === 'menunggu' || job?.state === 'berjalan';

  return (
    <section className="card" aria-label="Footage baru">
      <h2>0 · Footage baru — Upload &amp; Pisah Audio</h2>
      <p className="muted small">Video winning diunggah ke proyek “Footage …”, lalu mesin memisahkan video bisu, vokal, dan musik ke batch ini dan membuat Shot Library-nya.</p>
      <ErrorNotice error={error ?? jobError} />
      <div className="inspGrid">
        <label>
          Nama batch baru
          <input aria-label="Nama batch baru" value={batch} maxLength={80} onChange={(e) => setBatch(e.target.value.replace(/[^A-Za-z0-9_.-]/g, ''))} />
        </label>
        <label>
          Video (.mp4 / .mov)
          <input aria-label="Video footage" type="file" multiple accept="video/mp4,video/quicktime,.mp4,.mov" onChange={(e) => setFiles([...(e.target.files ?? [])].slice(0, 50))} />
        </label>
        <label className="inline inspFull">
          <input type="checkbox" aria-label="Video saja" checked={videoSaja} onChange={(e) => setVideoSaja(e.target.checked)} /> Video saja (tanpa pisah vokal / musik — lebih cepat)
        </label>
      </div>
      <button className="btn primary" disabled={role === 'reviewer' || !installed || !brand || !files.length || !nameOk || busy || live} onClick={() => void start()}>
        ⇪ Upload {files.length || ''} video &amp; Pisahkan
      </button>
      {upload && (
        <div className="muted small" role="status">
          {upload}
        </div>
      )}
      {job && current && <EngineProgress job={job} log={log} onCancel={() => void api.engineCancel(current.project_id, current.job_id).catch(setError)} />}
      {result && (
        <div aria-label="Hasil pisah">
          <div className="notice small" role="status">
            Batch <b>{result.batch}</b> siap: {result.files.length} file dipisah. Shot Library dibuat — cek di menu Shot.
          </div>
          {result.ditolak.length > 0 && (
            <div className="notice warn small" aria-label="File dilewati">
              {result.ditolak.length} file dilewati mesin:
              <ul>
                {result.ditolak.map((f) => (
                  <li key={f.file}>
                    <b>{f.file}</b> — {f.alasan}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <table className="list">
            <thead>
              <tr>
                <th>File</th>
                <th>Video bisu</th>
                <th>Vokal</th>
                <th>Musik</th>
              </tr>
            </thead>
            <tbody>
              {result.files.map((f) => (
                <tr key={f.file}>
                  <td>{f.file}</td>
                  <td>{f.video ? '✓' : '–'}</td>
                  <td>{f.vokal ? '✓' : '–'}</td>
                  <td>{f.musik ? '✓' : '–'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ per-sentence breakdown

/** VO sentence → the shots under it, with the engine's thumbnails (batch table detail row). */
export function LineBreakdown({ api, batch, row, library }: { api: Api; batch: string | null; row: BatchRow; library: ShotLibrary | null }) {
  const lines = row.kalimat ?? [];
  const ids = useMemo(() => [...new Set(lines.flatMap((l) => l.shot))], [lines]);
  const thumbs = useShotThumbs(api, batch, ids);
  const byId = useMemo(() => new Map((library?.shots ?? []).map((s) => [s.id, s])), [library]);
  if (!lines.length) return <div className="muted small">Belum ada rincian kalimat dari mesin untuk varian ini.</div>;
  return (
    <div className="lineBreakdown" aria-label={`Rincian ${row.id}`}>
      {row.kalimat_sumber === 'ops' && <div className="muted small">Dari caption rencana — mesin belum menulis shot per kalimat untuk batch ini.</div>}
      <ol>
        {lines.map((l, i) => (
          <li key={i}>
            <span className="muted small">
              {sec(l.dari)}–{sec(l.sampai)} dtk
            </span>{' '}
            <span className="lineText">{l.teks}</span>
            {l.shot.length > 0 && (
              <div className="row wrap" style={{ gap: 6, marginTop: 4 }}>
                {l.shot.map((id) => {
                  const s = byId.get(id);
                  return (
                    <figure key={id} className="shotMini" title={s ? labelBadges(s).join(', ') : id}>
                      <ShotThumb src={thumbs[id]} id={id} small />
                      <figcaption className="small">{id}</figcaption>
                    </figure>
                  );
                })}
              </div>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

// ------------------------------------------------------------------ Shot Library page

const PAGE = 60;

export function ShotLibraryView({ api, role = 'owner' }: { api: Api; role?: Role }) {
  const [installed, setInstalled] = useState<boolean | null>(null);
  const { list, error: listError } = useEngineBatches(api, installed === true);
  const [batch, setBatch] = useState('');
  const [lib, setLib] = useState<ShotLibrary | null>(null);
  const [saved, setSaved] = useState<string[]>([]);
  const [draft, setDraft] = useState<Set<string>>(new Set());
  const [footage, setFootage] = useState('');
  const [label, setLabel] = useState('');
  const [show, setShow] = useState<'semua' | 'dipakai' | 'dikecualikan'>('semua');
  const [page, setPage] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [note, setNote] = useState<string | null>(null);
  const readOnly = role === 'reviewer';

  useEffect(() => {
    void api.engineInfo().then((r) => setInstalled(r.installed), setError);
  }, [api]);
  const withLib = useMemo(() => (list?.batches ?? []).filter((b) => b.shot_library), [list]);
  useEffect(() => {
    setBatch((b) => b || withLib[0]?.batch || '');
  }, [withLib]);
  useEffect(() => {
    setLib(null);
    setFootage('');
    setLabel('');
    setPage(0);
    setNote(null);
    if (!batch) return;
    let stale = false; // a slower answer for the previous batch must never show (or be saved) here
    void api.engineShots(batch).then(
      (r) => {
        if (stale) return;
        setLib(r.library);
        setSaved(r.kecualikan);
        setDraft(new Set(r.kecualikan));
      },
      (e) => !stale && setError(e),
    );
    return () => {
      stale = true;
    };
  }, [api, batch]);

  const labelKeys = useMemo(() => [...new Set((lib?.shots ?? []).flatMap((s) => Object.entries(s.label).filter(([, v]) => typeof v === 'boolean').map(([k]) => k)))].sort(), [lib]);
  const shown = useMemo(
    () =>
      (lib?.shots ?? []).filter(
        (s) => (!footage || s.footage === footage) && (!label || s.label[label] === true) && (show === 'semua' || (show === 'dikecualikan') === draft.has(s.id)),
      ),
    [lib, footage, label, show, draft],
  );
  const pages = Math.max(1, Math.ceil(shown.length / PAGE));
  const pageShots = shown.slice(page * PAGE, page * PAGE + PAGE);
  const thumbs = useShotThumbs(api, batch || null, useMemo(() => pageShots.filter((s) => s.thumb).map((s) => s.id), [pageShots]));
  const changed = useMemo(() => {
    const a = new Set(saved);
    return [...draft].filter((x) => !a.has(x)).length + saved.filter((x) => !draft.has(x)).length;
  }, [saved, draft]);
  const toggle = (id: string) =>
    setDraft((d) => {
      const n = new Set(d);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const save = async () => {
    if (!lib || lib.batch !== batch) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.engineSetExcluded(lib.batch, [...draft]);
      setSaved(r);
      setDraft(new Set(r));
      setNote(`${r.length} shot dikecualikan. Berlaku untuk batch yang disusun berikutnya.`);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <header className="top">
        <h1>Shot Library</h1>
        <div className="spacer" />
        <span className="muted small hideNarrow">Potongan footage per batch dengan label mesin — kecualikan shot yang tidak boleh dipakai Batch Remix</span>
      </header>
      <div className="body enginePage">
        <ErrorNotice error={error ?? listError} />
        {installed === false && <div className="notice warn">Mesin belum dipasang di server ini. Set <code>MOTION_ENGINE_ROOT</code> ke folder repo mesin lalu jalankan ulang server.</div>}
        {list && !list.tersedia && <div className="notice warn small">Daftar batch belum bisa dibaca dari mesin: {list.alasan}</div>}
        {list?.tersedia && !withLib.length && <div className="notice small">Belum ada batch dengan Shot Library. Upload &amp; pisahkan footage dulu di halaman Batch.</div>}
        {withLib.length > 0 && (
          <section className="card" aria-label="Pilih batch">
            <div className="inspGrid">
              <label>
                Batch
                <select aria-label="Batch Shot Library" value={batch} onChange={(e) => setBatch(e.target.value)}>
                  {withLib.map((b) => (
                    <option key={b.batch} value={b.batch}>
                      {batchLabel(b)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Footage
                <select aria-label="Filter footage" value={footage} onChange={(e) => (setFootage(e.target.value), setPage(0))}>
                  <option value="">Semua footage</option>
                  {(lib?.footage ?? []).map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.id}
                      {f.durasi !== null ? ` (${sec(f.durasi)} dtk)` : ''}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Label
                <select aria-label="Filter label" value={label} onChange={(e) => (setLabel(e.target.value), setPage(0))}>
                  <option value="">Semua label</option>
                  {labelKeys.map((k) => (
                    <option key={k} value={k}>
                      {k}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Tampilkan
                <select aria-label="Filter status" value={show} onChange={(e) => (setShow(e.target.value as typeof show), setPage(0))}>
                  <option value="semua">Semua shot</option>
                  <option value="dipakai">Dipakai</option>
                  <option value="dikecualikan">Dikecualikan</option>
                </select>
              </label>
            </div>
          </section>
        )}
        {lib && (
          <section className="card" aria-label="Daftar shot">
            <div className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
              <b>
                {shown.length} dari {lib.shots.length} shot
              </b>
              <span className="muted small">· {draft.size} dikecualikan</span>
              <div className="spacer" />
              {!readOnly && (
                <button className="btn primary" disabled={busy || !changed} onClick={() => void save()}>
                  Simpan pengecualian ({changed})
                </button>
              )}
            </div>
            {note && (
              <div className="notice small" role="status">
                {note}
              </div>
            )}
            <div className="shotGrid">
              {pageShots.map((s) => {
                const out = draft.has(s.id);
                return (
                  <div key={s.id} className={`shotCard${out ? ' excluded' : ''}`} data-shot={s.id} aria-label={`Shot ${s.id}`}>
                    <ShotThumb src={thumbs[s.id]} id={s.id} />
                    <div className="small">
                      <b>{s.id}</b> · {sec(s.dari)}–{sec(s.sampai)} dtk{s.koreksi ? ' · dikoreksi tim' : ''}
                    </div>
                    <div className="row wrap" style={{ gap: 4 }}>
                      {labelBadges(s).map((b) => (
                        <span key={b} className="badge">
                          {b}
                        </span>
                      ))}
                      {s.tag.map((t) => (
                        <span key={t} className="badge">
                          #{t}
                        </span>
                      ))}
                    </div>
                    {(s.ucapan || s.teks.length > 0) && <div className="muted small shotText">{s.ucapan ? `“${s.ucapan}”` : `Teks: ${s.teks.join(' · ')}`}</div>}
                    {!readOnly && (
                      <button className={`btn small${out ? ' sel' : ''}`} aria-pressed={out} onClick={() => toggle(s.id)}>
                        {out ? '↺ Pakai lagi' : '✕ Kecualikan'}
                      </button>
                    )}
                    {readOnly && out && <span className="badge bad">dikecualikan</span>}
                  </div>
                );
              })}
            </div>
            {pages > 1 && (
              <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                <button className="btn small" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
                  ‹ Sebelumnya
                </button>
                <span className="small">
                  Halaman {page + 1}/{pages}
                </span>
                <button className="btn small" disabled={page >= pages - 1} onClick={() => setPage((p) => p + 1)}>
                  Berikutnya ›
                </button>
              </div>
            )}
          </section>
        )}
      </div>
    </>
  );
}
