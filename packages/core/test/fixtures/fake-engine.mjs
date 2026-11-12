// Fake engine CLI for U6 tests: same arguments, exit codes, JSON-lines progress and output files
// as KONTRAK-ENGINE v0.3 (`engine <mode> <job_dir>`). Behaviour is picked by brief.catatan.
import fs from 'node:fs';
import path from 'node:path';

const [mode, jobDir] = process.argv.slice(2);
const job = JSON.parse(fs.readFileSync(path.join(jobDir, 'job.json'), 'utf8'));
const brand = JSON.parse(fs.readFileSync(path.join(jobDir, job.brand_kit), 'utf8'));
const out = path.join(jobDir, 'out');
fs.mkdirSync(out, { recursive: true });
const say = (tahap, persen, pesan = '') => process.stdout.write(`${JSON.stringify({ tahap, persen, pesan })}\n`);
const what = job.brief.catatan;

// The engine only reads its inputs: they must exist.
for (const s of job.sumber) if (!fs.existsSync(s.path)) process.exit(1);

say('cek_input', 5, 'ok');
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
    rows.push({ id, vo: 'F1', hook: `Hook ${i}`, shot: ['F1@0.1'], footage: ['F1'], musik: null, durasi: 1 + i / 10, cta: 'Cek keranjang', status: 'usul', bukan_iklan: i === 3, qc_lulus: true, folder: `out/${id}` });
  }
  fs.writeFileSync(path.join(out, 'batch.json'), JSON.stringify({ schema: 'batch-remix/1', job_id: job.job_id, batch: job.batch, tujuan: job.tujuan, jumlah_diminta: job.jumlah, jumlah_jadi: rows.length, media, varian: rows }));
  say('selesai', 100, `${rows.length} varian`);
  process.exit(0);
}
process.stderr.write('log: mulai\n');
if (what === 'tolak') {
  fs.writeFileSync(path.join(out, 'rencana.json'), JSON.stringify({ schema: 'engine-rencana/1', status: 'ditolak', alasan: 'tidak ada ucapan terdeteksi' }));
  process.exit(2);
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
fs.writeFileSync(path.join(out, 'rencana.json'), JSON.stringify({ schema: 'engine-rencana/1', status: 'siap', durasi: { mentah: 3, akhir: 1.5, target: [15, 30] }, hook: { teks: 'Celana adem', dari: 0, sampai: 1.2, sumber: 'aturan' }, peringatan: [], ragu: [{ detik: 0.6, teks: 'adem', alasan: 'Whisper kurang yakin (0.41)' }], mode_job: mode }));
say('selesai', 100);
process.exit(0);
