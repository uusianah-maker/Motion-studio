import type { Clip } from '../api';

/** Frame rate of the timecode / frame steps (the render default, 30 fps). */
export const PLAYER_FPS = 30;
const SPEEDS = [0.5, 1, 1.5, 2];

/** HH:MM:SS:FF at 30 fps. */
export function timecode(ms: number, fps = PLAYER_FPS): string {
  const total = Math.max(0, Math.round((ms * fps) / 1000)); // a step lands on 33 ms = frame 1
  const f = total % fps;
  const s = Math.floor(total / fps);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}:${p(f)}`;
}

/** Playhead of the frame before / after `ms` (frame boundaries at 30 fps). */
export function stepFrame(ms: number, dir: -1 | 1, fps = PLAYER_FPS): number {
  const frame = Math.round((ms * fps) / 1000);
  return Math.max(0, Math.round(((frame + dir) * 1000) / fps));
}

/**
 * 25 Nov (owner: player bar seperti contoh): ⏮/⏭ one frame (Shift = 1 s), timecode, seek bar,
 * speed, loop (whole video / selected clip), volume and "Ringan" (lighter preview). Preview only.
 */
export function PlayerBar(p: {
  t: number;
  end: number;
  playing: boolean;
  onPlay: () => void;
  onSeek: (ms: number) => void;
  muted: boolean;
  setMuted: (m: boolean) => void;
  volume: number;
  setVolume: (v: number) => void;
  speed: number;
  setSpeed: (s: number) => void;
  loop: 'off' | 'semua' | 'klip';
  setLoop: (l: 'off' | 'semua' | 'klip') => void;
  loopClip: Clip | null;
  ringan: boolean;
  setRingan: (r: boolean) => void;
}) {
  const step = (dir: -1 | 1, big: boolean) => p.onSeek(big ? p.t + dir * 1000 : stepFrame(p.t, dir));
  const nextLoop = p.loop === 'off' ? 'semua' : p.loop === 'semua' ? 'klip' : 'off';
  const loopLabel = p.loop === 'off' ? 'Ulang: mati' : p.loop === 'semua' ? 'Ulang: seluruh video' : p.loopClip ? 'Ulang: klip terpilih' : 'Ulang: klip terpilih (pilih klip dulu)';
  return (
    <div className="player playerBar" role="group" aria-label="Kontrol pemutar">
      <button className="tiny" onClick={() => p.onSeek(0)} aria-label="Ke awal" title="Ke awal" disabled={p.end === 0}>
        ⇤
      </button>
      <button className="tiny" onClick={(e) => step(-1, e.shiftKey)} aria-label="Mundur 1 frame" title="Mundur 1 frame (Shift: 1 detik)" disabled={p.end === 0}>
        ⏮
      </button>
      <button className="play" onClick={p.onPlay} aria-label={p.playing ? 'Jeda' : 'Putar'} disabled={p.end === 0}>
        {p.playing ? '❚❚' : '▶'}
      </button>
      <button className="tiny" onClick={(e) => step(1, e.shiftKey)} aria-label="Maju 1 frame" title="Maju 1 frame (Shift: 1 detik)" disabled={p.end === 0}>
        ⏭
      </button>
      <span className="time tc" aria-label="Waktu">
        {timecode(p.t)} / {timecode(p.end)}
      </span>
      <input className="seek" type="range" aria-label="Geser waktu" min={0} max={Math.max(1, p.end)} step={1000 / PLAYER_FPS} value={Math.min(p.t, p.end)} onChange={(e) => p.onSeek(Number(e.target.value))} disabled={p.end === 0} />
      <select className="speed" aria-label="Kecepatan putar" title="Kecepatan pratinjau (render tidak berubah)" value={p.speed} onChange={(e) => p.setSpeed(Number(e.target.value))}>
        {SPEEDS.map((s) => (
          <option key={s} value={s}>
            {String(s).replace('.', ',')}×
          </option>
        ))}
      </select>
      <button className={`tiny${p.loop !== 'off' ? ' on' : ''}`} aria-label={loopLabel} aria-pressed={p.loop !== 'off'} title={`${loopLabel} — klik untuk ganti`} onClick={() => p.setLoop(nextLoop)}>
        🔁{p.loop === 'klip' ? <sup>K</sup> : null}
      </button>
      <button className="tiny" onClick={() => p.setMuted(!p.muted)} aria-label={p.muted ? 'Nyalakan suara' : 'Bisukan'}>
        {p.muted || p.volume === 0 ? '🔇' : '🔊'}
      </button>
      <input className="vol" type="range" aria-label="Volume pratinjau" min={0} max={100} value={Math.round(p.volume * 100)} onChange={(e) => (p.setVolume(Number(e.target.value) / 100), p.muted && p.setMuted(false))} />
      <button className={`chip tiny ringan${p.ringan ? ' on' : ''}`} aria-pressed={p.ringan} onClick={() => p.setRingan(!p.ringan)} title="Pratinjau ringan: efek berat (LUT, blur area, grain) dimatikan sementara supaya lancar di PC/HP lambat. Hasil render tidak berubah.">
        Ringan
      </button>
    </div>
  );
}
