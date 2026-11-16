import { useEffect, useState } from 'react';
import { OVERLAY_DEFAULT, validateOverlay } from '../../../../packages/core/dist/storage/overlay.js';
import { fontOfRef } from '../../../../packages/core/dist/storage/textStyle.js';
import { asetFontFamily, ensureAsetFont } from '../brand';
import { LOOKS, LOOK_IDS, TRANSITIONS, TRANSITION_LABEL, type TransitionType } from '../../../../packages/core/dist/storage/clipLook.js';
import { TEXT_PRESETS } from '../../../../packages/core/dist/storage/textPresets.js';
import { voSubtitleOps } from '../../../../packages/core/dist/storage/voText.js';
import type { Api, BrandAsset, BrandKit, BrandTextPreset, Clip, EditOp, Media, Project, Track } from '../api';
import { useSoundPreview } from '../audioPreview';
import { presetOp } from './PresetPanel';

type Tab = 'sfx' | 'musik' | 'vo' | 'transisi' | 'efek' | 'teks' | 'font';
const TABS: { id: Tab; label: string }[] = [
  { id: 'sfx', label: 'SFX' },
  { id: 'musik', label: 'Musik' },
  { id: 'vo', label: 'VO' },
  { id: 'transisi', label: 'Transisi' },
  { id: 'efek', label: 'Efek' },
  { id: 'teks', label: 'Teks' },
  { id: 'font', label: 'Font' },
];
/**
 * R38a ↔ R38b (ucok): video effect clips (overlay `blend`) and stingers (`place_stinger`) are
 * rendered by R38b. Until that core is here, their "＋" stays off — detected from the core itself,
 * so the buttons switch on by themselves when R38b lands.
 */
const CAN_BLEND = (() => {
  try {
    validateOverlay({ ...OVERLAY_DEFAULT, blend: 'screen' });
    return true;
  } catch {
    return false;
  }
})();
// `overlay.stinger` arrives in the same R38b core as the `place_stinger` op (core/timeline is not
// browser-safe, overlay.ts is).
const CAN_STINGER = (() => {
  try {
    validateOverlay({ ...OVERLAY_DEFAULT, stinger: true });
    return true;
  } catch {
    return false;
  }
})();
const match = (needle: string) => (a: { id: string; nama: string; tag: string[] }) => !needle || a.tag.some((t) => t.includes(needle)) || a.id.includes(needle) || a.nama.toLowerCase().includes(needle);

/** R38a: ▶ for a video asset — a small looping muted preview under the row. */
function VideoPeek({ api, versionId }: { api: Api; versionId: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api.streamUrl(versionId).then((r) => live && setUrl(r.url), () => undefined);
    return () => {
      live = false;
    };
  }, [api, versionId]);
  return <span className="libPeek">{url && <video src={url} muted autoPlay loop playsInline aria-label="Pratinjau video aset" />}</span>;
}

/** R38a: a font's own letters (the file is registered as @font-face like in the preview). */
export function FontSample({ api, versionId, text = 'Aa Bb 123 — Diskon!' }: { api: Api; versionId: string; text?: string }) {
  const [ok, setOk] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    void ensureAsetFont(api, versionId).then((r) => live && setOk(r));
    return () => {
      live = false;
    };
  }, [api, versionId]);
  return (
    <span className="fontSample" data-font-ready={ok ? '1' : '0'} style={{ fontFamily: `'${asetFontFamily(versionId)}', sans-serif` }}>
      {ok === false ? 'font tidak terbaca' : text}
    </span>
  );
}
const TRANS_MS = 500;
const ZOOMS: { id: string; label: string; hint: string; effect: Extract<EditOp, { op: 'add_clip' }>['effect'] }[] = [
  { id: 'zoom-halus', label: 'Zoom halus 1,2×', hint: 'Punch-in pelan (penekanan)', effect: { type: 'zoom', scale: 1.2, mode: 'smooth', x: 0.5, y: 0.5 } },
  { id: 'zoom-kuat', label: 'Zoom kuat 1,5×', hint: 'Punch-in besar ke tengah', effect: { type: 'zoom', scale: 1.5, mode: 'smooth', x: 0.5, y: 0.5 } },
  { id: 'zoom-cut', label: 'Zoom langsung 1,3×', hint: 'Lompat zoom (cut) tanpa gerak', effect: { type: 'zoom', scale: 1.3, mode: 'cut', x: 0.5, y: 0.5 } },
  { id: 'zoom-through', label: 'Zoom-through', hint: 'Zoom tembus untuk ganti adegan', effect: { type: 'zoom_through', scale: 1.4, x: 0.5, y: 0.5 } },
];
/** R38b: a pixel format with an alpha channel → the stinger is drawn as is; else Screen (black = see-through). */
export const hasAlpha = (pixFmt: string | null | undefined) => !!pixFmt && /^(yuva|rgba|bgra|argb|abgr|gbrap|ya[81])/.test(pixFmt);
const STINGER_MAX = 10_000;
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
export function LibraryPanel({ api, project, media, kit, library = null, playhead, selected, busy, edit, clipName }: { api: Api; project: Project; media: readonly Media[]; kit: BrandKit | null; library?: { aset: BrandAsset[]; preset_teks: BrandTextPreset[] } | null; playhead: number; selected: (Clip & { kind: Track['kind'] }) | null; busy: boolean; edit: (ops: EditOp[]) => void; clipName: (c: Clip) => string }) {
  const [tab, setTab] = useState<Tab>('sfx');
  const [q, setQ] = useState('');
  const [peek, setPeek] = useState<string | null>(null);
  const sound = useSoundPreview(api);
  // R38a: the brand's own library + what other brands share with every brand.
  const all = library?.aset ?? kit?.aset ?? [];
  const of = (j: BrandAsset['jenis']) => all.filter((a) => a.jenis === j);
  const [q2, setQ2] = useState('');
  const n2 = q2.trim().toLowerCase();
  const sfx = of('sfx');
  const tags = [...new Set(sfx.flatMap((a) => a.tag))].sort();
  const needle = q.trim().toLowerCase();
  const shown = sfx.filter((a) => !needle || a.tag.some((t) => t.includes(needle)) || a.id.includes(needle) || a.nama.toLowerCase().includes(needle));
  const durOf = (vid: string) => media.flatMap((m) => m.versions).find((v) => v.version_id === vid)?.probe?.duration_ms;
  const addSfx = (ref: { media_id: string; version_id: string }) => {
    const len = Math.max(100, Math.min(durOf(ref.version_id) ?? 1000, 30_000));
    edit([{ op: 'add_clip', track_kind: 'sfx', media: ref, start_ms: freeOn(project, 'sfx', playhead, len), duration_ms: len }]);
  };
  // R37: VO from the library (Brand → Aset jenis VO, made with "Suara dari Teks").
  const vos = of('vo');
  const musik = of('musik').filter(match(n2));
  const efekVideo = of('video_efek').filter(match(n2));
  const fonts = of('font').filter(match(n2));
  const presets = (library?.preset_teks ?? kit?.preset_teks ?? []).filter(match(n2));
  const textSel = selected && (selected.kind === 'text' || selected.kind === 'subtitle') ? selected : null;
  const search = <input aria-label="Cari aset" placeholder="Cari tag / nama" value={q2} onChange={(e) => setQ2(e.target.value)} />;
  const peekBtn = (a: BrandAsset) => (
    <button className="tiny" aria-label={`${peek === a.ref.version_id ? 'Tutup' : 'Lihat'} ${a.id}`} aria-pressed={peek === a.ref.version_id} onClick={() => setPeek(peek === a.ref.version_id ? null : a.ref.version_id)}>
      {peek === a.ref.version_id ? '■' : '▶'}
    </button>
  );
  const from = (a: { dari?: string }) => (a.dari ? <span className="muted small"> · dari {a.dari}</span> : null);
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
  // R38b: stingers = video assets of the brand tagged "stinger"/"transisi" (or an asset kind "transisi").
  // R38b rule over the R38a library (own + shared): kind Transisi, or a video tagged stinger / transisi.
  const stingers = all.filter((a) => a.jenis === 'transisi' || a.tag.some((t) => t === 'stinger' || t === 'transisi')).filter((a) => a.jenis !== 'sfx' && a.jenis !== 'musik' && a.jenis !== 'vo').filter(match(n2));
  const versionOf = (vid: string) => media.flatMap((m) => m.versions).find((v) => v.version_id === vid);
  const placeStinger = (ref: { media_id: string; version_id: string }) => {
    const v = versionOf(ref.version_id);
    const len = Math.max(100, Math.min(v?.probe?.duration_ms ?? 1000, STINGER_MAX));
    edit([{ op: 'place_stinger', media: ref, at_ms: tTarget?.start_ms ?? playhead, duration_ms: len, ...(hasAlpha(v?.probe?.pix_fmt) ? { alpha: true } : {}) }]);
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

      {tab === 'musik' && (
        <div role="tabpanel" aria-label="Musik" className="libList">
          {search}
          {!of('musik').length && <div className="muted small">Belum ada musik di Aset brand. Tambah di Brand → Aset (＋ Tambah aset → Musik).</div>}
          {musik.map((a) => (
            <div key={a.id} className="libRow" role="group" aria-label={`Musik ${a.id}`}>
              <button className="tiny" aria-label={`${sound.playing === a.ref.version_id ? 'Hentikan' : 'Dengar'} ${a.id}`} aria-pressed={sound.playing === a.ref.version_id} onClick={() => sound.toggle(a.ref.version_id)}>
                {sound.playing === a.ref.version_id ? '■' : '▶'}
              </button>
              <span className="libName">
                {a.nama || a.id}
                {!a.lisensi.iklan && <span className="badge warn"> bukan untuk iklan</span>}
                {from(a)}
              </span>
              <button
                className="btn small"
                disabled={busy}
                aria-label={`Tambah ${a.id} ke musik`}
                onClick={() => {
                  const len = Math.max(100, durOf(a.ref.version_id) ?? 10_000);
                  edit([{ op: 'add_clip', track_kind: 'music', media: a.ref, start_ms: freeOn(project, 'music', playhead, len), duration_ms: len }]);
                }}
              >
                ＋
              </button>
            </div>
          ))}
        </div>
      )}

      {tab === 'font' && (
        <div role="tabpanel" aria-label="Font" className="libList">
          {search}
          <div className="muted small">{textSel ? `Klik "Pakai" untuk mengganti font teks terpilih.` : 'Pilih klip teks/subtitle untuk memakai font.'}</div>
          {!of('font').length && <div className="muted small">Belum ada font di Aset. Tambah .ttf / .otf di Brand → Aset (＋ Tambah aset → Font).</div>}
          {fonts.map((a) => (
            <div key={a.id} className="libRow" role="group" aria-label={`Font ${a.id}`}>
              <span className="libName">
                <FontSample api={api} versionId={a.ref.version_id} />
                <span className="muted small"> {a.nama || a.id}</span>
                {from(a)}
              </span>
              <button className="btn small" disabled={busy || !textSel} aria-label={`Pakai font ${a.id}`} onClick={() => textSel && edit([{ op: 'set_style', clip_id: textSel.clip_id, style: { font: fontOfRef(a.ref) } }])}>
                Pakai
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
          <b className="small">Stinger (video transisi) dari Aset</b>
          {stingers.length > 0 && search}
          {!stingers.length && <div className="muted small">Belum ada stinger. Tambah video di Brand → Aset (jenis Transisi, atau tag "stinger"); tanpa alpha dipasang dengan mode Screen (hitam = tembus).</div>}
          {stingers.map((a) => {
            const v = versionOf(a.ref.version_id);
            return (
              <div key={a.id} className="libRow libRowCol" role="group" aria-label={`Stinger ${a.id}`}>
                <div className="row" style={{ gap: 6, alignItems: 'center' }}>
                  {peekBtn(a)}
                  <span className="libName">
                    {a.nama || a.id}
                    <span className="muted small"> · {hasAlpha(v?.probe?.pix_fmt) ? 'alpha' : 'Screen'}</span>
                    {from(a)}
                  </span>
                  {v?.probe?.duration_ms !== undefined && <span className="muted small">{ms(Math.min(v.probe.duration_ms, STINGER_MAX))}</span>}
                  <button className="btn small" disabled={busy || !tTarget || !CAN_STINGER} aria-label={`Pasang stinger ${a.id}`} title="Di tengah potongan terdekat (track Overlay)" onClick={() => placeStinger(a.ref)}>
                    ＋
                  </button>
                </div>
                {peek === a.ref.version_id && <VideoPeek api={api} versionId={a.ref.version_id} />}
              </div>
            );
          })}
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
          <b className="small">Video efek dari Aset (light leak, debu, partikel)</b>
          {of('video_efek').length > 0 && search}
          {!of('video_efek').length && <div className="muted small">Belum ada video efek. Tambah MP4 / WebM / MOV di Brand → Aset (jenis Video efek).</div>}
          {!CAN_BLEND && of('video_efek').length > 0 && <div className="muted small">Menaruh video efek di atas video: segera (R38b). Sekarang bisa dilihat dulu.</div>}
          {efekVideo.map((a) => (
            <div key={a.id} className="libRow libRowCol" role="group" aria-label={`Video efek ${a.id}`}>
              <div className="row" style={{ gap: 6, alignItems: 'center' }}>
                {peekBtn(a)}
                <span className="libName">
                  {a.nama || a.id}
                  {from(a)}
                </span>
                <button
                  className="btn small"
                  disabled={busy || !CAN_BLEND}
                  title={CAN_BLEND ? 'Di atas video mulai playhead (blend screen)' : 'Segera (R38b)'}
                  aria-label={`Tambah video efek ${a.id}`}
                  onClick={() => edit([{ op: 'add_clip', track_kind: 'overlay', media: a.ref, start_ms: Math.round(playhead / 100) * 100, duration_ms: Math.max(100, durOf(a.ref.version_id) ?? 3000), overlay: { pos: 'c', dx: 0, dy: 0, skala: 100, opasitas: 1, margin: 0, layer: 0, blend: 'screen' } as unknown as typeof OVERLAY_DEFAULT }])}
                >
                  ＋
                </button>
              </div>
              {peek === a.ref.version_id && <VideoPeek api={api} versionId={a.ref.version_id} />}
            </div>
          ))}
        </div>
      )}

      {tab === 'teks' && (
        <div role="tabpanel" aria-label="Teks" className="libList">
          {presets.length > 0 || (library?.preset_teks ?? kit?.preset_teks ?? []).length > 0 ? (
            <>
              <b className="small">Preset brand</b>
              {search}
              <div className="presetGrid">
                {presets.map((p) => (
                  <button
                    key={`${p.dari ?? ''}${p.id}`}
                    className="presetBtn"
                    disabled={busy}
                    title={`${p.teks}${p.dari ? ` (dari ${p.dari})` : ''}`}
                    aria-label={`Preset brand ${p.nama}`}
                    onClick={() => edit([{ op: 'add_clip', track_kind: p.track, text: p.teks, style: { ...p.style }, start_ms: freeOn(project, p.track, playhead, p.durasi_ms), duration_ms: p.durasi_ms }])}
                  >
                    <span className="presetSwatch" style={{ color: p.style.color ?? '#fff', background: p.style.bg ?? '#2a2f42', fontWeight: p.style.bold === false ? 400 : 800 }} aria-hidden="true">
                      Aa
                    </span>
                    {p.nama}
                  </button>
                ))}
              </div>
              <b className="small">Preset bawaan</b>
            </>
          ) : (
            <div className="muted small">Simpan gaya teks sendiri: pilih klip teks → Inspector → "☆ Simpan sebagai preset".</div>
          )}
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
