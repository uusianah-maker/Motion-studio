// Fake engine CLI for U6 tests: same arguments, exit codes, JSON-lines progress and output files
// as KONTRAK-ENGINE v0.3 (`engine <mode> <job_dir>`). Behaviour is picked by brief.catatan.
import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import path from 'node:path';

const [mode, jobDir] = process.argv.slice(2);
// 1x1 JPEG: an engine-made thumbnail stand-in.
const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==', 'base64');
const konten = path.resolve('konten');

if (mode === 'daftar_batch') {
  // Read-only listing of konten/2-dipisah (pipeline/batch/daftar.py).
  const count = (d, ext) => (fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.toLowerCase().endsWith(ext)).length : 0);
  const root = path.join(konten, '2-dipisah');
  const names = fs.existsSync(root) ? fs.readdirSync(root).filter((n) => fs.statSync(path.join(root, n)).isDirectory()) : [];
  const batch = names.sort().reverse().map((n) => {
    const d = path.join(root, n);
    const footage = count(path.join(d, 'video-bisu'), '.mp4');
    const lib = fs.existsSync(path.join(d, 'shots.json'));
    const shots = lib ? JSON.parse(fs.readFileSync(path.join(d, 'shots.json'), 'utf8')).shots : [];
    return { batch: n, upload: count(path.join(konten, '1-upload', n), '.mp4'), footage, vo: count(path.join(d, 'vokal'), '.wav'), musik: count(path.join(d, 'musik'), '.wav'), dipisah: footage > 0, dipisah_pada: 1763000000000, shot_library: lib, jumlah_shot: shots.length, thumb: shots.length, siap_batch: footage > 0 && lib };
  });
  process.stdout.write(`${JSON.stringify({ schema: 'daftar-batch/1', batch })}
`);
  process.exit(0);
}

const job = JSON.parse(fs.readFileSync(path.join(jobDir, 'job.json'), 'utf8'));
const brand = JSON.parse(fs.readFileSync(path.join(jobDir, job.brand_kit), 'utf8'));
const out = path.join(jobDir, 'out');
fs.mkdirSync(out, { recursive: true });
const say = (tahap, persen, pesan = '') => process.stdout.write(`${JSON.stringify({ tahap, persen, pesan })}\n`);
const what = job.brief.catatan;

// The engine only reads its inputs: they must exist.
for (const s of job.sumber) if (!fs.existsSync(s.path)) process.exit(1);

say('cek_input', 5, 'ok');
if (mode === 'pisah') {
  // Pisah Audio + Shot Library: uploads in <job>/masuk/ → konten/1-upload + konten/2-dipisah/<batch>.
  if (job.batch === 'gagal') {
    // Technical failure (exit 1) with a reason in the result file (contract v0.3.2a).
    process.stderr.write(`Traceback: demucs crash di ${path.join(jobDir, 'masuk')}\n`);
    fs.writeFileSync(path.join(out, 'pisah.json'), JSON.stringify({ schema: 'pisah/1', status: 'gagal', alasan: `GPU kehabisan memori saat membuka ${path.join(jobDir, 'masuk')}` }));
    process.exit(1);
  }
  if (job.batch === 'gagal-polos') {
    process.stderr.write(`Traceback: File "D:\\VIBECODING\\remotion\\pipeline\\pisah.py", line 1\n`);
    process.exit(1);
  }
  if (job.batch === 'tolak') {
    fs.writeFileSync(path.join(out, 'pisah.json'), JSON.stringify({ schema: 'pisah/1', status: 'ditolak', alasan: 'tidak ada video yang bisa dibaca' }));
    process.exit(2);
  }
  const up = path.join(konten, '1-upload', job.batch);
  const dp = path.join(konten, '2-dipisah', job.batch);
  for (const d of [up, ...['video-bisu', 'vokal', 'musik', 'audio-asli', 'thumb'].map((x) => path.join(dp, x))]) fs.mkdirSync(d, { recursive: true });
  const hasil = [];
  const footage = {};
  const shots = [];
  const fileDitolak = [];
  for (const f of fs.readdirSync(path.join(jobDir, 'masuk'))) {
    const name = path.parse(f).name;
    // A "broken" upload is skipped, not fatal (contract v0.3.2a: file_ditolak).
    if (name.startsWith('RUSAK')) {
      fileDitolak.push({ file: path.join(jobDir, 'masuk', f).replace(/\\/g, '/'), alasan: `ffprobe gagal membaca ${path.join(jobDir, 'masuk', f)}` });
      continue;
    }
    fs.copyFileSync(path.join(jobDir, 'masuk', f), path.join(up, f));
    fs.copyFileSync(path.join(jobDir, 'masuk', f), path.join(dp, 'video-bisu', `${name}.mp4`));
    if (!job.video_saja) for (const k of ['vokal', 'musik']) fs.writeFileSync(path.join(dp, k, `${name}.wav`), 'RIFF');
    hasil.push({ file: path.join(up, f), video: path.join(dp, 'video-bisu', `${name}.mp4`), vokal: job.video_saja ? null : path.join(dp, 'vokal', `${name}.wav`), musik: job.video_saja ? null : path.join(dp, 'musik', `${name}.wav`) });
    footage[name] = { video: `konten/2-dipisah/${job.batch}/video-bisu/${name}.mp4`, durasi: 3 };
    for (let i = 0; i < 2; i++) {
      const id = `${name}#0${i}`;
      const thumb = path.join(dp, 'thumb', `${name}__0${i}.jpg`);
      fs.writeFileSync(thumb, JPEG);
      shots.push({ id, footage: name, dari: i * 1.5, sampai: i * 1.5 + 1.5, framing: i ? 'dekat' : 'medium', wajah_bicara: i === 0, teks_bawaan: i === 1, buram: false, tag: i ? ['produk'] : [], teks: i ? [{ teks: 'Loosepants', kotak: [0, 0, 1, 1] }] : [], ucapan: i ? null : 'celananya adem banget', thumb: thumb.replace(/\\/g, '/'), ...(i ? { koreksi: { buram: true } } : {}) });
    }
    say('pisah', 50, name);
  }
  // A thumbnail path that points outside the batch folder must never be served.
  shots.push({ id: 'X#99', footage: 'X', dari: 0, sampai: 1, thumb: 'C:/Windows/win.ini' });
  fs.writeFileSync(path.join(dp, 'shots.json'), JSON.stringify({ schema: 'shots/1', batch: job.batch, footage, shots }));
  fs.writeFileSync(path.join(out, 'pisah.json'), JSON.stringify({ schema: 'pisah/1', status: 'siap', batch: job.batch, video_saja: !!job.video_saja, hasil, file_ditolak: fileDitolak, shot_library: true, jumlah_shot: shots.length }));
  say('selesai', 100, `${hasil.length} file`);
  process.exit(0);
}
if (mode === 'batch') {
  // Footage + vocals live in the engine's own folder (konten/), referenced through batch.json media.
  const media = { '$sumber:F1': 'konten/f1.mp4', '$vokal:F1': 'konten/f1-vokal.wav' };
  const rows = [];
  for (let i = 1; i <= job.jumlah; i++) {
    const id = `varian-${String(i).padStart(3, '0')}`;
    fs.mkdirSync(path.join(out, id), { recursive: true });
    const ops = [
      { op: 'set_canvas', ratio: '9:16' },
      { op: 'add_clip', track_kind: 'video', media: '$sumber:F1', start_ms: 0, duration_ms: 1000 + i * 100, in_ms: i * 100, volume: 0, crop: { x: 0, y: 0.1, w: 1, h: 0.8 }, blur: [{ x: 0.7, y: 0.85, w: 0.25, h: 0.1, dari_ms: 0, sampai_ms: 3000, radius: 20 }] },
      { op: 'add_clip', track_kind: 'audio', media: '$vokal:F1', start_ms: 0, duration_ms: 1000 + i * 100 },
      { op: 'add_clip', track_kind: 'subtitle', text: `Hook ${i}`, start_ms: 0, duration_ms: 800 },
    ];
    fs.writeFileSync(path.join(out, id, 'ops.json'), JSON.stringify({ schema: 'ms-ops/1', mode: 'u3', aset_lokal: [], ops }));
    fs.writeFileSync(path.join(out, id, 'rencana.json'), JSON.stringify({ schema: 'engine-rencana/1', status: 'siap', hook: { teks: `Hook ${i}` } }));
    const kalimat = i === 2 ? undefined : [{ teks: `Hook ${i}`, dari: 0, sampai: 0.8, shot: ['F1#00'] }, { teks: 'Cek keranjang', dari: 0.8, sampai: 1.1, shot: ['F1#01', 'F1#00', 'F1＠1.5'] }];
    rows.push({ id, ...(kalimat ? { kalimat } : {}), vo: 'F1', hook: `Hook ${i}`, shot: ['F1@0.1'], footage: ['F1'], musik: null, durasi: 1 + i / 10, cta: 'Cek keranjang', status: 'usul', bukan_iklan: i === 3, qc_lulus: true, folder: `out/${id}` });
  }
  fs.writeFileSync(path.join(out, 'batch.json'), JSON.stringify({ schema: 'batch-remix/1', job_id: job.job_id, batch: job.batch, tujuan: job.tujuan, jumlah_diminta: job.jumlah, jumlah_jadi: rows.length, media, varian: rows, kecualikan_diterima: job.kecualikan_shot ?? [], vo_batch: job.vo_batch ?? null }));
  say('selesai', 100, `${rows.length} varian`);
  process.exit(0);
}
process.stderr.write('log: mulai\n');
if (what === 'tolak') {
  fs.writeFileSync(path.join(out, 'rencana.json'), JSON.stringify({ schema: 'engine-rencana/1', status: 'ditolak', alasan: 'tidak ada ucapan terdeteksi' }));
  process.exit(2);
}
if (what === 'tolak0') {
  fs.writeFileSync(path.join(out, 'rencana.json'), JSON.stringify({ schema: 'engine-rencana/1', status: 'ditolak', alasan: 'durasi di luar target' }));
  process.exit(0);
}
if (what === 'gagal') {
  process.stderr.write('Traceback: whisper model tidak ada\n');
  process.exit(1);
}
if (what === 'lambat') await new Promise((r) => setTimeout(r, 20_000));
say('transkrip', 40, '12 kata');
say('rencana', 80);
const sfxKey = brand.aset.find((a) => a.jenis === 'sfx')?.kunci ?? null;
const ops = [
  { op: 'set_canvas', ratio: '9:16' },
  { op: 'add_clip', track_kind: 'video', media: '$sumber', start_ms: 0, duration_ms: 1500, in_ms: 500 },
  { op: 'add_clip', track_kind: 'subtitle', text: 'x', words: [{ text: 'Celana', start_ms: 0, end_ms: 500 }, { text: 'adem', start_ms: 500, end_ms: 1000 }], style: { anim: 'pop', highlight: { words: ['adem'], color: '#ffd23f', scale: 1.4, current: false } }, start_ms: 0, duration_ms: 1200 },
  ...(sfxKey ? [{ op: 'add_clip', track_kind: 'sfx', media: sfxKey, start_ms: 100, duration_ms: 200, volume: 0.8 }] : []),
  { op: 'add_clip', track_kind: 'music', media: '$musik:lokal-01', start_ms: 0, duration_ms: 1500, volume: 0.12 },
  ...(what === 'asing' ? [{ op: 'add_clip', track_kind: 'sfx', media: '$sfx:tidak-ada', start_ms: 1300, duration_ms: 100 }] : []),
];
const lokalPath = what === 'kabur' ? 'C:/Windows/win.ini' : 'aset/musik-lokal.wav';
fs.writeFileSync(path.join(out, 'ops.json'), JSON.stringify({ schema: 'ms-ops/1', mode: job.mode_ops ?? 'kompat', ops, aset_lokal: [{ kunci: '$musik:lokal-01', path: lokalPath }] }));
fs.writeFileSync(path.join(out, 'qc_rencana.json'), JSON.stringify({ butir: [{ butir: 'durasi sesuai target', lulus: false, nilai: 1.5 }, { butir: 'hook di 3 detik pertama', lulus: true }] }));
fs.writeFileSync(path.join(out, 'rencana.json'), JSON.stringify({ schema: 'engine-rencana/1', status: 'siap', posisi_caption: 0.72, audio: { sfx: 1, musik: '$musik:lokal-01', lisensi_musik: 'milik_sendiri' }, durasi: { mentah: 3, akhir: 1.5, target: null, saran: [15, 30] }, hook: { teks: 'Celana adem', dari: 0, sampai: 1.2, sumber: 'aturan' }, peringatan: [], ragu: [{ detik: 0.6, teks: 'adem', alasan: 'Whisper kurang yakin (0.41)' }], mode_job: mode }));
say('selesai', 100);
process.exit(0);
