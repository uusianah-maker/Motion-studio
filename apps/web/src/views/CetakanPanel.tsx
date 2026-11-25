import { useEffect, useState } from 'react';
import { CETAKAN, CETAKAN_LABEL, type CetakanId, type Kalimat, type Usulan, kataPenting, opsCetakan, pilihCetakan } from '../../../../packages/core/dist/storage/cetakan.js';
import type { AiConnection, Api, BrandAsset, Clip, EditOp, Media, Project } from '../api';
import { formatDuration } from '../lib';

type Ref = { media_id: string; version_id: string };

/** Sentences of the video: subtitle clips (with their word times), else the newest transcript. */
async function bacaKalimat(api: Api, project: Project): Promise<{ kalimat: Kalimat[]; sumber: string }> {
  const subs = project.timeline.tracks.filter((t) => t.kind === 'subtitle').flatMap((t) => t.clips).filter((c) => c.text?.trim()).sort((a, b) => a.start_ms - b.start_ms);
  if (subs.length) return { sumber: 'subtitle', kalimat: subs.map((c) => ({ teks: c.text!.trim(), start_ms: c.start_ms, end_ms: c.end_ms, ...(c.words?.length ? { kata: c.words.map((w) => ({ text: w.text, start_ms: c.start_ms + w.start_ms, end_ms: c.start_ms + w.end_ms })) } : {}) })) };
  const { transcripts } = await api.transcripts(project.project_id);
  const videos = project.timeline.tracks.filter((t) => t.kind === 'video').flatMap((t) => t.clips).filter((c) => c.media);
  const tr = [...transcripts].sort((a, b) => b.updated_at - a.updated_at).find((x) => videos.some((v) => v.media!.version_id === x.version_id));
  if (!tr) return { sumber: 'none', kalimat: [] };
  const full = await api.transcript(project.project_id, tr.transcript_id);
  const out: Kalimat[] = [];
  for (const v of videos.filter((c) => c.media!.version_id === tr.version_id)) {
    const inMs = v.in_ms ?? 0;
    const rate = v.speed ?? 1;
    for (const cue of full.cues) {
      const a = v.start_ms + (cue.start_ms - inMs) / rate;
      const b = v.start_ms + (cue.end_ms - inMs) / rate;
      if (b <= v.start_ms || a >= v.end_ms || !cue.text.trim()) continue;
      out.push({ teks: cue.text.trim(), start_ms: Math.round(Math.max(a, v.start_ms)), end_ms: Math.round(Math.min(b, v.end_ms)) });
    }
  }
  return { sumber: 'transkrip', kalimat: out.sort((x, y) => x.start_ms - y.start_ms) };
}

/** Brand SFX by tag / name (Kenney library tags: klik, teks-muncul, transisi …). */
function sfxBy(aset: readonly BrandAsset[], media: readonly Media[], want: RegExp): (Ref & { durasi_ms?: number }) | undefined {
  const a = aset.find((x) => x.jenis === 'sfx' && (x.tag.some((t) => want.test(t)) || want.test(x.id) || want.test(x.nama ?? '')));
  if (!a) return undefined;
  const d = media.flatMap((m) => m.versions).find((v) => v.version_id === a.ref.version_id)?.probe?.duration_ms;
  return { ...a.ref, ...(d ? { durasi_ms: d } : {}) };
}

/**
 * 25 Nov (owner: Copilot "template visual per kalimat"): read the video's sentences, pair each with
 * a visual template by its shape (rules here; AI may re-pick), let the team change / untick rows,
 * then apply the ticked ones as ordinary clips in ONE edit (one Undo). Quick chips: B-roll at 5 s,
 * highlight important words, zoom + whoosh.
 */
export function CetakanPanel({ api, project, media, aset, selectedClip, playheadMs, busy, edit, videoAi }: { api: Api; project: Project; media: readonly Media[]; aset: readonly BrandAsset[]; selectedClip: Clip | null; playheadMs: number; busy: boolean; edit: (ops: EditOp[]) => Promise<void>; videoAi?: (b: Parameters<Api['videoAiStart']>[1]) => Promise<void> }) {
  const [cakupan, setCakupan] = useState<'semua' | 'klip'>('semua');
  const [model, setModel] = useState<string>('lokal');
  const [conns, setConns] = useState<AiConnection[]>([]);
  const [rows, setRows] = useState<{ k: Kalimat; u: Usulan; on: boolean }[] | null>(null);
  const [sumber, setSumber] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [sorot, setSorot] = useState<string[]>([]);
  useEffect(() => {
    void api.aiProviders().then((r) => setConns(r.connections.filter((c) => c.enabled && c.has_key && c.capabilities.includes('planner'))), () => setConns([]));
  }, [api]);
  const used = new Set(project.timeline.tracks.flatMap((t) => t.clips.flatMap((c) => (c.media ? [c.media.version_id] : []))));
  const brolls = media.flatMap((m) => {
    const v = m.versions.find((x) => x.version_id === m.current_version_id) ?? m.versions[0];
    return v && !used.has(v.version_id) && v.probe?.video_codec && (v.probe.duration_ms ?? 0) > 500 ? [{ ref: { media_id: m.media_id, version_id: v.version_id }, durasi_ms: v.probe.duration_ms }] : [];
  });
  const ctx = () => ({ timeline: project.timeline, sfx: { klik: sfxBy(aset, media, /klik|click/i), whoosh: sfxBy(aset, media, /whoosh|transisi|swoosh/i), muncul: sfxBy(aset, media, /teks-muncul|pop|muncul/i) }, broll: brolls });

  const baca = async () => {
    setError(null);
    setNote(null);
    setWorking(true);
    try {
      const r = await bacaKalimat(api, project);
      let kal = r.kalimat;
      if (cakupan === 'klip' && selectedClip) kal = kal.filter((k) => k.end_ms > selectedClip.start_ms && k.start_ms < selectedClip.end_ms);
      if (!kal.length) {
        setRows([]);
        setNote(r.sumber === 'none' ? 'Belum ada kalimat. Buat subtitle dulu (tombol CC di Media / Transkrip), lalu baca lagi.' : 'Tidak ada kalimat di cakupan ini.');
        return;
      }
      let us = pilihCetakan(kal);
      if (model !== 'lokal') {
        const ai = await api.copilotCetakanAi(project.project_id, { kalimat: kal.map((k) => k.teks), usulan: us.map((u) => u.cetakan), connection_id: model });
        if (ai.ai) {
          us = us.map((u, i) => (ai.ai!.pilihan[i] && ai.ai!.pilihan[i] !== u.cetakan ? { cetakan: ai.ai!.pilihan[i] as CetakanId, alasan: `dipilih AI (${ai.ai!.provider.model})` } : u));
          setSorot(ai.ai.sorot);
          setNote(`AI ${ai.ai.provider.model} ikut memilih · biaya $${ai.ai.cost_usd.toFixed(4)}`);
        } else setNote(`AI tidak dipakai: ${ai.alasan ?? 'tidak tersedia'} — memakai aturan lokal.`);
      }
      setSumber(r.sumber);
      setRows(kal.map((k, i) => ({ k, u: us[i]!, on: us[i]!.cetakan !== 'polos' })));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(false);
    }
  };
  const terapkan = async () => {
    if (!rows) return;
    const { ops, catatan } = opsCetakan(rows.map((r) => r.k), rows.map((r) => (r.on ? r.u : null)), ctx());
    if (!ops.length) return setNote(catatan.length ? catatan.join(' · ') : 'Tidak ada yang diterapkan.');
    setWorking(true);
    try {
      await edit(ops);
      setNote(`${ops.length} klip ditambahkan (1 langkah Undo).${catatan.length ? ` ${catatan.join(' · ')}` : ''}`);
      setRows(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(false);
    }
  };
  // quick chips
  const chipBroll = async () => {
    const pick = brolls[0];
    if (!pick) return setNote('Tidak ada video lain di Media untuk b-roll. Upload dulu.');
    const { ops, catatan } = opsCetakan([{ teks: 'b-roll', start_ms: 5000, end_ms: 5000 + Math.min(3000, pick.durasi_ms) }], [{ cetakan: 'broll', alasan: '' }], { timeline: project.timeline, broll: [pick] });
    if (!ops.length) return setNote(catatan.join(' · '));
    await edit(ops).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };
  const chipHighlight = async () => {
    const subs = project.timeline.tracks.filter((t) => t.kind === 'subtitle' || t.kind === 'text').flatMap((t) => t.clips).filter((c) => c.text?.trim());
    if (!subs.length) return setNote('Belum ada teks/subtitle untuk di-highlight.');
    const kal = subs.map((c) => ({ teks: c.text!, start_ms: c.start_ms, end_ms: c.end_ms }));
    const words = (sorot.length ? sorot : kataPenting(kal)).slice(0, 8);
    if (!words.length) return setNote('Tidak ketemu kata penting.');
    const target = subs.filter((c) => words.some((w) => c.text!.toLowerCase().includes(w.toLowerCase())));
    await edit(target.map((c) => ({ op: 'set_style', clip_id: c.clip_id, style: { highlight: { words, color: '#ffd23f', scale: 1.2, current: false, box: false } } }) as EditOp)).then(
      () => setNote(`Highlight: ${words.join(', ')} di ${target.length} teks.`),
      (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
    );
  };
  const chipZoom = async () => {
    const at = Math.round(playheadMs / 100) * 100;
    const hit = (kind: string, a: number, b: number) => project.timeline.tracks.some((t) => t.kind === kind && t.clips.some((c) => a < c.end_ms && c.start_ms < b));
    const w = ctx().sfx.whoosh;
    const ops: EditOp[] = [];
    if (!hit('effects', at, at + 1200)) ops.push({ op: 'add_clip', track_kind: 'effects', start_ms: at, duration_ms: 1200, effect: { type: 'zoom', scale: 1.2, mode: 'smooth', x: 0.5, y: 0.5, ramp_ms: 500 } } as EditOp);
    if (w && !hit('sfx', at, at + (w.durasi_ms ?? 800))) ops.push({ op: 'add_clip', track_kind: 'sfx', media: { media_id: w.media_id, version_id: w.version_id }, start_ms: at, duration_ms: Math.max(100, Math.min(w.durasi_ms ?? 800, 3000)) } as EditOp);
    if (!ops.length) return setNote('Di playhead sudah ada zoom / SFX.');
    await edit(ops).then(
      () => setNote(`Zoom${w ? ' + whoosh' : ' (belum ada SFX whoosh di Aset brand)'} di ${formatDuration(at)}.`),
      (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
    );
  };

  return (
    <div className="cetakanPanel" role="group" aria-label="Cetakan visual per kalimat">
      <div className="row wrap" style={{ gap: 6, alignItems: 'center' }}>
        <b className="small">Cetakan per kalimat</b>
        <select aria-label="Cakupan cetakan" value={cakupan} onChange={(e) => setCakupan(e.target.value as 'semua' | 'klip')}>
          <option value="semua">Seluruh video</option>
          <option value="klip" disabled={!selectedClip}>
            Klip terpilih
          </option>
        </select>
        <select aria-label="Model AI cetakan" value={model} onChange={(e) => setModel(e.target.value)} title={conns.length ? 'Model AI dari menu AI' : 'Belum ada koneksi AI — sambungkan di menu AI'}>
          <option value="lokal">Aturan lokal (tanpa AI)</option>
          {conns.map((c) => (
            <option key={c.connection_id} value={c.connection_id}>
              {c.label || c.provider} · {c.model}
            </option>
          ))}
        </select>
        <button className="btn small" disabled={busy || working} onClick={() => void baca()}>
          ▤ Baca kalimat
        </button>
      </div>
      <div className="row wrap" style={{ gap: 4, marginTop: 6 }}>
        <button className="chip tiny" disabled={busy || working} onClick={() => void chipBroll()}>
          B-roll di detik 5
        </button>
        <button className="chip tiny" disabled={busy || working} onClick={() => void chipHighlight()}>
          Highlight kata penting
        </button>
        <button className="chip tiny" disabled={busy || working} onClick={() => void chipZoom()}>
          Zoom + whoosh
        </button>
      </div>
      {rows && rows.length > 0 && (
        <>
          <div className="muted small" style={{ marginTop: 6 }}>
            {rows.length} kalimat dari {sumber}. Tiap kalimat dibaca bentuknya; ganti cetakan atau hapus centang sebelum diterapkan.
          </div>
          <div className="cetakanList" role="list">
            {rows.map((r, i) => (
              <div key={i} className="cetakanRow" role="listitem" aria-label={`Kalimat ${i + 1}`}>
                <input type="checkbox" aria-label={`Pakai cetakan kalimat ${i + 1}`} checked={r.on} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, on: e.target.checked } : x)))} />
                <span className="muted small">{formatDuration(r.k.start_ms)}</span>
                <span className="cetakanText" title={r.k.teks}>
                  {r.k.teks}
                </span>
                <select aria-label={`Cetakan kalimat ${i + 1}`} value={r.u.cetakan} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, u: { cetakan: e.target.value as CetakanId, alasan: 'dipilih tim' }, on: e.target.value !== 'polos' } : x)))}>
                  {CETAKAN.map((c) => (
                    <option key={c} value={c}>
                      {CETAKAN_LABEL[c]}
                    </option>
                  ))}
                </select>
                <span className="muted small cetakanWhy">
                  {r.u.alasan}
                  {r.u.cetakan === 'broll' && videoAi && (
                    <button
                      className="linkBtn small"
                      disabled={busy || working}
                      title="Buat klip B-roll baru dari kalimat ini dengan Video AI (OMNI FLASH 1.2). Otomatis dipasang di waktu kalimat saat selesai."
                      onClick={() =>
                        void videoAi({ prompt: `${r.k.teks.replace(/[.!?]+$/, '')}. Video produk fashion untuk iklan, realistis, gerak kamera halus.`, ratio: project.timeline.canvas?.ratio === '16:9' ? '16:9' : '9:16', tempat: { start_ms: r.k.start_ms, max_ms: Math.max(1000, r.k.end_ms - r.k.start_ms), asal: 'cetakan' } }).then(
                          () => {
                            setRows(rows.map((x, j) => (j === i ? { ...x, on: false } : x)));
                            setNote(`B-roll AI untuk kalimat ${i + 1} sedang dibuat (bergiliran). Otomatis dipasang di ${formatDuration(r.k.start_ms)} saat selesai.`);
                          },
                          (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
                        )
                      }
                    >
                      {' '}✨ Buat B-roll AI
                    </button>
                  )}
                </span>
              </div>
            ))}
          </div>
          <button className="btn primary small" disabled={busy || working || !rows.some((r) => r.on)} onClick={() => void terapkan()}>
            ✓ Terapkan {rows.filter((r) => r.on).length} cetakan
          </button>
        </>
      )}
      {note && <div className="notice small">{note}</div>}
      {error && <div className="notice warn small">{error}</div>}
    </div>
  );
}
