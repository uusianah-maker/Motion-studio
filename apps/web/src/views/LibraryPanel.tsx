import { useState } from 'react';
import { LOOKS, LOOK_IDS, TRANSITIONS, TRANSITION_LABEL, type TransitionType } from '../../../../packages/core/dist/storage/clipLook.js';
import { TEXT_PRESETS } from '../../../../packages/core/dist/storage/textPresets.js';
import { voSubtitleOps } from '../../../../packages/core/dist/storage/voText.js';
import type { Api, BrandKit, Clip, EditOp, Media, Project, Track } from '../api';
import { useSoundPreview } from '../audioPreview';
import { presetOp } from './PresetPanel';

type Tab = 'sfx' | 'vo' | 'transisi' | 'efek' | 'teks';
const TABS: { id: Tab; label: string }[] = [
  { id: 'sfx', label: 'SFX' },
  { id: 'vo', label: 'VO' },
  { id: 'transisi', label: 'Transisi' },
  { id: 'efek', label: 'Efek' },
  { id: 'teks', label: 'Teks' },
];
const TRANS_MS = 500;
const ZOOMS: { id: string; label: string; hint: string; effect: Extract<EditOp, { op: 'add_clip' }>['effect'] }[] = [
  { id: 'zoom-halus', label: 'Zoom halus 1,2×', hint: 'Punch-in pelan (penekanan)', effect: { type: 'zoom', scale: 1.2, mode: 'smooth', x: 0.5, y: 0.5 } },
  { id: 'zoom-kuat', label: 'Zoom kuat 1,5×', hint: 'Punch-in besar ke tengah', effect: { type: 'zoom', scale: 1.5, mode: 'smooth', x: 0.5, y: 0.5 } },
  { id: 'zoom-cut', label: 'Zoom langsung 1,3×', hint: 'Lompat zoom (cut) tanpa gerak', effect: { type: 'zoom', scale: 1.3, mode: 'cut', x: 0.5, y: 0.5 } },
  { id: 'zoom-through', label: 'Zoom-through', hint: 'Zoom tembus untuk ganti adegan', effect: { type: 'zoom_through', scale: 1.4, x: 0.5, y: 0.5 } },
];
const ms = (n: number) => `${(n / 1000).toFixed(1).replace('.', ',')} dtk`;

/** First start ≥ `from` where `len` fits on the `kind` lane (lanes never overlap, overlays excepted). */
export function freeOn(project: Project, kind: Track['kind'], from: number, len: number): number {
  const clips = project.timeline.tracks.filter((t) => t.kind === kind).flatMap((t) => t.clips).sort((a, b) => a.start_ms - b.start_ms);
  let start = Math.max(0, Math.round(from / 100) * 100);
  for (const c of clips) if (c.start_ms < start + len && start < c.end_ms) start = c.end_ms;
  return start;
}

/**
 * The video / b-roll clip a transition or look goes on: the selected one, else the cut nearest to
 * the playhead (a transition is drawn at the START of the clip that comes in, so the first clip of
 * the video never gets one).
 */
export function pictureTarget(project: Project, selected: (Clip & { kind: Track['kind'] }) | null, playhead: number, forTransition: boolean): (Clip & { kind: Track['kind'] }) | null {
  if (selected?.media && (selected.kind === 'video' || selected.kind === 'broll') && (!forTransition || selected.start_ms > 0)) return selected;
  const all = project.timeline.tracks.filter((t) => t.kind === 'video' || t.kind === 'broll').flatMap((t) => t.clips.filter((c) => c.media).map((c) => ({ ...c, kind: t.kind })));
  if (!forTransition) return all.find((c) => playhead >= c.start_ms && playhead < c.end_ms) ?? null;
  return all.filter((c) => c.start_ms > 0).sort((a, b) => Math.abs(a.start_ms - playhead) - Math.abs(b.start_ms - playhead))[0] ?? null;
}

/**
 * R27 Library in the Editor: SFX (▶ listen, search by tag, add at the playhead), transitions, zoom
 * effects + looks and text presets — one click = one edit = one undo. Everything lands as ordinary
 * clips / clip settings, so the inspector can still change it (hybrid).
 */
export function LibraryPanel({ api, project, media, kit, playhead, selected, busy, edit, clipName }: { api: Api; project: Project; media: readonly Media[]; kit: BrandKit | null; playhead: number; selected: (Clip & { kind: Track['kind'] }) | null; busy: boolean; edit: (ops: EditOp[]) => void; clipName: (c: Clip) => string }) {
  const [tab, setTab] = useState<Tab>('sfx');
  const [q, setQ] = useState('');
  const sound = useSoundPreview(api);
  const sfx = (kit?.aset ?? []).filter((a) => a.jenis === 'sfx');
  const tags = [...new Set(sfx.flatMap((a) => a.tag))].sort();
  const needle = q.trim().toLowerCase();
  const shown = sfx.filter((a) => !needle || a.tag.some((t) => t.includes(needle)) || a.id.includes(needle) || a.nama.toLowerCase().includes(needle));
  const durOf = (vid: string) => media.flatMap((m) => m.versions).find((v) => v.version_id === vid)?.probe?.duration_ms;
  const addSfx = (ref: { media_id: string; version_id: string }) => {
    const len = Math.max(100, Math.min(durOf(ref.version_id) ?? 1000, 30_000));
    edit([{ op: 'add_clip', track_kind: 'sfx', media: ref, start_ms: freeOn(project, 'sfx', playhead, len), duration_ms: len }]);
  };
  // R37: VO from the library (Brand → Aset jenis VO, made with "Suara dari Teks").
  const vos = (kit?.aset ?? []).filter((a) => a.jenis === 'vo');
  const [voBusy, setVoBusy] = useState<string | null>(null);
  const [voErr, setVoErr] = useState<string | null>(null);
  const addVo = async (ref: { media_id: string; version_id: string }, withSubs: boolean) => {
    setVoBusy(ref.version_id);
    setVoErr(null);
    try {
      const index = await api.voIndex(ref.version_id).catch(() => null);
      const known = durOf(ref.version_id) ?? (index ? Math.round(Math.max(...index.kalimat.map((k) => k.akhir)) * 1000) : undefined);
      const len = Math.max(100, known ?? 3000);
      const start = freeOn(project, 'audio', playhead, len);
      // One edit = one undo: the voice clip and its subtitles (from the known text, no Whisper).
      edit([{ op: 'add_clip', track_kind: 'audio', media: ref, start_ms: start, duration_ms: len }, ...(withSubs && index ? (voSubtitleOps(index, start, 0, len) as EditOp[]) : [])]);
    } catch (e) {
      setVoErr(e instanceof Error ? e.message : String(e));
    } finally {
      setVoBusy(null);
    }
  };
  const tTarget = pictureTarget(project, selected, playhead, true);
  const lTarget = pictureTarget(project, selected, playhead, false);

  return (
    <section className="presets libraryPanel" aria-label="Library efek">
      <div className="inspHead">
        <b>Library</b>
        <span className="muted small">klik = tambah di playhead {ms(playhead)}</span>
      </div>
      <div className="row wrap libTabs" role="tablist" aria-label="Jenis library" style={{ gap: 4 }}>
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className={`chip tiny${tab === t.id ? ' on' : ''}`} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'sfx' && (
        <div role="tabpanel" aria-label="SFX" className="libList">
          <input aria-label="Cari SFX" placeholder="Cari tag / nama (mis. teks-muncul)" value={q} onChange={(e) => setQ(e.target.value)} />
          {tags.length > 0 && (
            <div className="row wrap" style={{ gap: 4 }}>
              {tags.map((t) => (
                <button key={t} className={`chip tiny${needle === t ? ' on' : ''}`} aria-label={`Saring tag ${t}`} onClick={() => setQ(needle === t ? '' : t)}>
                  #{t}
                </button>
              ))}
            </div>
          )}
          {!sfx.length && <div className="muted small">Belum ada SFX di Aset brand{kit ? ` ${kit.name}` : ''}. Unggah di Brand → Aset (jenis SFX), beri tag mis. teks-muncul, transisi.</div>}
          {sfx.length > 0 && !shown.length && <div className="muted small">Tidak ada SFX dengan tag/nama itu.</div>}
          {shown.map((a) => (
            <div key={a.id} className="libRow" role="group" aria-label={`SFX ${a.id}`}>
              <button className="tiny" aria-label={`${sound.playing === a.ref.version_id ? 'Hentikan' : 'Dengar'} ${a.id}`} aria-pressed={sound.playing === a.ref.version_id} onClick={() => sound.toggle(a.ref.version_id)}>
                {sound.playing === a.ref.version_id ? '■' : '▶'}
              </button>
              <span className="libName" title={a.tag.map((t) => `#${t}`).join(' ')}>
                {a.nama || a.id}
                {a.tag.length > 0 && <span className="muted small"> · {a.tag.join(', ')}</span>}
              </span>
              {durOf(a.ref.version_id) !== undefined && <span className="muted small">{ms(durOf(a.ref.version_id)!)}</span>}
              <button className="btn small" disabled={busy} aria-label={`Tambah ${a.id} di playhead`} onClick={() => addSfx(a.ref)}>
                ＋
              </button>
            </div>
          ))}
        </div>
      )}

      {tab === 'vo' && (
        <div role="tabpanel" aria-label="VO" className="libList">
          {!vos.length && <div className="muted small">Belum ada VO di Aset brand{kit ? ` ${kit.name}` : ''}. Buat lewat menu "Suara dari Teks" (hasilnya otomatis masuk Aset jenis VO).</div>}
          {voErr && <div className="notice err small">{voErr}</div>}
          {vos.map((a) => (
            <div key={a.id} className="libRow" role="group" aria-label={`VO ${a.id}`}>
              <button className="tiny" aria-label={`${sound.playing === a.ref.version_id ? 'Hentikan' : 'Dengar'} ${a.id}`} aria-pressed={sound.playing === a.ref.version_id} onClick={() => sound.toggle(a.ref.version_id)}>
                {sound.playing === a.ref.version_id ? '■' : '▶'}
              </button>
              <span className="libName" title={a.catatan || a.nama}>
                {a.nama || a.id}
              </span>
              {durOf(a.ref.version_id) !== undefined && <span className="muted small">{ms(durOf(a.ref.version_id)!)}</span>}
              <button className="btn small" disabled={busy || voBusy === a.ref.version_id} aria-label={`Tambah ${a.id} dengan subtitle`} title="VO di track Audio mulai playhead + subtitle dari teksnya (tanpa Whisper)" onClick={() => void addVo(a.ref, true)}>
                ＋ VO + subtitle
              </button>
              <button className="tiny" disabled={busy || voBusy === a.ref.version_id} aria-label={`Tambah ${a.id} tanpa subtitle`} title="Suara saja" onClick={() => void addVo(a.ref, false)}>
                ＋
              </button>
            </div>
          ))}
        </div>
      )}

      {tab === 'transisi' && (
        <div role="tabpanel" aria-label="Transisi" className="libList">
          <div className="muted small" aria-label="Sasaran transisi">
            {tTarget ? (
              <>
                Masuk ke <b>{clipName(tTarget)}</b> di {ms(tTarget.start_ms)}
                {tTarget.transition ? ` (sekarang: ${TRANSITION_LABEL[tTarget.transition.type]})` : ''}
              </>
            ) : (
              'Belum ada potongan: butuh minimal dua klip video/b-roll (transisi ada di awal klip yang masuk).'
            )}
          </div>
          <div className="presetGrid">
            {TRANSITIONS.map((tr: TransitionType) => (
              <button key={tr} className={`presetBtn${tTarget?.transition?.type === tr ? ' on' : ''}`} disabled={busy || !tTarget} aria-label={`Pasang transisi ${TRANSITION_LABEL[tr]}`} onClick={() => tTarget && edit([{ op: 'set_picture', clip_id: tTarget.clip_id, transition: { type: tr, ms: tTarget.transition?.ms ?? TRANS_MS } }])}>
                {TRANSITION_LABEL[tr]}
              </button>
            ))}
          </div>
          {tTarget?.transition && (
            <button className="btn small" disabled={busy} aria-label="Hapus transisi" onClick={() => edit([{ op: 'set_picture', clip_id: tTarget.clip_id, transition: null }])}>
              Tanpa transisi (potong biasa)
            </button>
          )}
        </div>
      )}

      {tab === 'efek' && (
        <div role="tabpanel" aria-label="Efek" className="libList">
          <b className="small">Zoom (1 dtk di playhead)</b>
          <div className="presetGrid">
            {ZOOMS.map((z) => (
              <button key={z.id} className="presetBtn" disabled={busy} title={z.hint} aria-label={`Tambah ${z.label}`} onClick={() => edit([{ op: 'add_clip', track_kind: 'effects', start_ms: freeOn(project, 'effects', playhead, 1000), duration_ms: 1000, effect: z.effect! }])}>
                {z.label}
              </button>
            ))}
          </div>
          <b className="small">Filter warna {lTarget ? <span className="muted">→ {clipName(lTarget)}</span> : <span className="muted">(pilih / taruh playhead di klip video)</span>}</b>
          <div className="presetGrid">
            {LOOK_IDS.map((id) => (
              <button key={id} className={`presetBtn${lTarget?.look === id ? ' on' : ''}`} disabled={busy || !lTarget} aria-label={`Pasang filter ${LOOKS[id].label}`} onClick={() => lTarget && edit([{ op: 'set_picture', clip_id: lTarget.clip_id, look: id }])}>
                {LOOKS[id].label}
              </button>
            ))}
          </div>
          {lTarget?.look && (
            <button className="btn small" disabled={busy} aria-label="Hapus filter" onClick={() => edit([{ op: 'set_picture', clip_id: lTarget.clip_id, look: null }])}>
              Tanpa filter
            </button>
          )}
        </div>
      )}

      {tab === 'teks' && (
        <div role="tabpanel" aria-label="Teks" className="libList">
          <div className="presetGrid">
            {TEXT_PRESETS.map((p) => (
              <button key={p.id} className="presetBtn" disabled={busy} title={p.hint} aria-label={`Library teks ${p.label}`} onClick={() => edit([presetOp(p, project, playhead)])}>
                <span className="presetSwatch" style={{ color: p.style.color, background: p.style.bg ?? '#2a2f42', fontWeight: p.style.bold ? 800 : 400 }} aria-hidden="true">
                  Aa
                </span>
                {p.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
