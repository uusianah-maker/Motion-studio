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

if (mode === 'tts') {
  // R34 / contract §21: voices, or one WAV per sentence + the joined take with pauses, word times.
  const tj = JSON.parse(fs.readFileSync(path.join(jobDir, 'job.json'), 'utf8'));
  const outDir = path.join(jobDir, 'out');
  fs.mkdirSync(path.join(outDir, 'vo'), { recursive: true });
  if (tj.tts?.daftar_suara) {
    fs.writeFileSync(path.join(outDir, 'tts.json'), JSON.stringify({ schema: 'tts/1', status: 'selesai', suara: [{ id: 'windows:Andika', nama: 'Microsoft Andika', bahasa: 'id-ID', gender: 'Male', backend: 'windows' }, { id: 'windows:Zira', nama: 'Microsoft Zira', bahasa: 'en-US', gender: 'Female', backend: 'windows' }] }));
    process.exit(0);
  }
  const kit = tj.brand_kit ? JSON.parse(fs.readFileSync(path.join(jobDir, tj.brand_kit), 'utf8')) : {};
  const ucap = kit.teks?.pelafalan ?? {};
  const rate = 48000;
  const wav = (samples) => {
    const b = Buffer.alloc(44 + samples.length * 2);
    b.write('RIFF', 0); b.writeUInt32LE(36 + samples.length * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12);
    b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
    b.write('data', 36); b.writeUInt32LE(samples.length * 2, 40);
    samples.forEach((v, i) => b.writeInt16LE(Math.round(v * 12000), 44 + i * 2));
    return b;
  };
  const wordDur = 0.3 / (tj.tts.kecepatan ?? 1);
  const gap = (tj.tts.jeda_ms ?? 300) / 1000;
  const all = [];
  const file = [];
  let t = 0;
  tj.tts.kalimat.forEach((k, i) => {
    process.stdout.write(`${JSON.stringify({ tahap: 'suara', persen: Math.round((i / tj.tts.kalimat.length) * 90), pesan: `kalimat ${i + 1}` })}\n`);
    const kata = k.split(/\s+/).filter(Boolean);
    const n = Math.round(kata.length * wordDur * rate);
    const s = Array.from({ length: n }, (_, j) => Math.sin((2 * Math.PI * 220 * (1 + i * 0.25) * j) / rate));
    const name = `${String(i + 1).padStart(2, '0')}.wav`;
    fs.writeFileSync(path.join(outDir, 'vo', name), wav(s));
    let diucapkan = k;
    for (const [w, u] of Object.entries(ucap)) diucapkan = diucapkan.replace(new RegExp(w, 'gi'), u);
    file.push({ no: i + 1, teks: k, diucapkan, file: `out/vo/${name}`, durasi: n / rate, mulai: t, akhir: t + n / rate, kata: kata.map((w, j) => ({ teks: w, mulai: j * wordDur, akhir: (j + 1) * wordDur })) });
    all.push(...s);
    t += n / rate;
    if (i < tj.tts.kalimat.length - 1) {
      all.push(...new Array(Math.round(gap * rate)).fill(0));
      t += gap;
    }
  });
  fs.writeFileSync(path.join(outDir, 'vo', 'gabungan.wav'), wav(all));
  fs.writeFileSync(path.join(outDir, 'tts.json'), JSON.stringify({ schema: 'tts/1', status: 'selesai', suara: tj.tts.suara, backend: 'windows', kecepatan: tj.tts.kecepatan, jeda_ms: tj.tts.jeda_ms, lufs: -16, usulan: true, gabungan: { file: 'out/vo/gabungan.wav', durasi: t }, file, total_durasi: t }));
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
if (mode === 'transfer') {
  // Motion Transfer tahap 1 (contract §15): scenes + best frame + copy-ready prompts.
  if (job.brief.deskripsi_produk === 'tolak') {
    fs.writeFileSync(path.join(out, 'rencana.json'), JSON.stringify({ schema: 'engine-rencana/1', status: 'ditolak', alasan: 'tidak ada gambar video di file' }));
    process.exit(2);
  }
  fs.mkdirSync(path.join(out, 'adegan'), { recursive: true });
  const produk = job.brief.produk || brand.produk?.[0]?.nama || 'produk kami';
  const batas = [[0, 1.2], [1.2, 2.5], [2.5, 4.1], [4.1, 6]];
  const adegan = batas.map(([a, b], i) => {
    const nama = `adegan/${String(i + 1).padStart(2, '0')}.jpg`;
    fs.writeFileSync(path.join(out, nama), JPEG);
    say('gambar', 20 + Math.round((75 * (i + 1)) / batas.length), `adegan ${i + 1}/${batas.length}`);
    return { no: i + 1, dari: a, sampai: b, durasi: Math.round((b - a) * 100) / 100, detik_gambar: Math.round((a + (b - a) / 2) * 100) / 100, gambar: nama, prompt_gambar: `Ganti produk di gambar ini dengan ${produk}.${job.brief.deskripsi_produk ? ` Produk: ${job.brief.deskripsi_produk}.` : ''} Rasio 9:16.`, prompt_gerak: `Gerakkan gambar ini selama ${(b - a).toFixed(1)} detik meniru gerakan adegan ${i + 1}/${batas.length} video referensi.`, sumber: 'aturan' };
  });
  fs.writeFileSync(path.join(out, 'transfer.json'), JSON.stringify({ schema: 'engine-transfer/1', status: 'siap', referensi: path.basename(job.sumber[0].path), durasi: 6, produk, adegan, catatan: 'Tahap 2-3 masih manual.' }));
  say('selesai', 100, `siap · ${adegan.length} adegan`);
  process.exit(0);
}
if (mode === 'beatspot') {
  // Beat Spot tahap 1 (contract §16): cuts on the beat, the team's order / exclusions / people kept.
  const bs = job.beatspot ?? {};
  if (bs.tagline === 'tolak') {
    fs.writeFileSync(path.join(out, 'rencana.json'), JSON.stringify({ schema: 'engine-rencana/1', status: 'ditolak', alasan: 'tidak ada shot orang yang layak (semua buram/beku/tanpa orang)' }));
    process.exit(2);
  }
  const audio = (p) => /\.(wav|mp3|m4a|aac)$/i.test(p);
  const sound = bs.sound ?? job.sumber.filter((s) => audio(s.path)).map((s) => s.kunci).find((_, i, a) => a.length === 1) ?? null;
  const footage = job.sumber.filter((s) => s.kunci !== sound && !audio(s.path)).map((s) => s.kunci.slice(8));
  const bpm = sound ? 128 : (bs.bpm ?? 120);
  const so = bs.sumber_orang ?? {};
  const who = (sid, fid) => (so[sid] ?? so[fid]) === 'kreator' ? 'kreator' : 'umum';
  const shots = footage.flatMap((f, i) => [0, 1].map((n) => ({ id: `${f}#${String(n).padStart(2, '0')}`, footage: f, dari: n * 1.5, sampai: n * 1.5 + 1.5, orang: 1, framing: 'badan', skor: 0.9 - i * 0.1 - n * 0.05 })));
  const kecuali = new Set(bs.kecualikan_shot ?? []);
  const layak = shots.filter((s) => !kecuali.has(s.id));
  const urut = [...(bs.urutan_shot ?? []).map((id) => layak.find((s) => s.id === id)).filter(Boolean), ...layak.filter((s) => !(bs.urutan_shot ?? []).includes(s.id))];
  const beat = 60 / bpm;
  const per = 2 * beat;
  const potongan = urut.slice(0, 4).map((s, i) => ({ no: i + 1, mulai: Math.round(i * per * 1000) / 1000, durasi: Math.round(per * 1000) / 1000, shot: s.id, footage: s.footage, in: s.dari, skor: s.skor, alasan: 'orang berganti', sumber_orang: who(s.id, s.footage) }));
  const total = potongan.length * per;
  const ops = [
    { op: 'set_canvas', ratio: '9:16' },
    ...potongan.map((p, i) => ({ op: 'add_clip', track_kind: 'video', media: `$sumber:${p.footage}`, start_ms: Math.round(i * per * 1000), duration_ms: Math.round((i + 1) * per * 1000) - Math.round(i * per * 1000), in_ms: Math.round(p.in * 1000), volume: 0 })),
    ...(sound ? [{ op: 'add_clip', track_kind: 'music', media: sound, start_ms: 0, duration_ms: Math.round(total * 1000), volume: 1 }] : []),
  ];
  say('susun', 70, `${bpm} BPM`);
  fs.writeFileSync(path.join(out, 'ops.json'), JSON.stringify({ schema: 'ms-ops/1', mode: 'u3', aset_lokal: [], ops }));
  fs.writeFileSync(path.join(out, 'qc_rencana.json'), JSON.stringify({ butir: [{ butir: 'potong_di_ketukan', lulus: true }, { butir: 'durasi', lulus: false, nilai: Math.round(total * 10) / 10 }] }));
  fs.writeFileSync(path.join(out, 'rencana.json'), JSON.stringify({ schema: 'engine-rencana/1', status: 'siap', durasi: { mentah: footage.length * 3, akhir: Math.round(total * 100) / 100, target: bs.durasi ?? [15, 20] }, hook: null, audio: { sfx: 0, musik: sound, musik_bpm: bpm }, peringatan: sound ? [] : [{ level: 'warn', jenis: 'ketukan', teks: 'tanpa sound: pola BPM' }], ragu: [], menunggu_u3: [], beatspot: { bpm, sumber_ketukan: sound ? 'sound' : 'bpm', ketukan_per_potong: 2, potongan: potongan.length, end_card_dtk: 0 } }));
  fs.writeFileSync(path.join(out, 'beatspot.json'), JSON.stringify({ schema: 'beatspot/1', job_id: job.job_id, bpm, sumber_ketukan: sound ? 'sound' : 'bpm', ketukan_per_potong: 2, potongan, durasi: Math.round(total * 100) / 100, end_card_dtk: 0, kandidat: layak.map((s) => ({ ...s, dipakai: potongan.some((p) => p.shot === s.id), sumber_orang: who(s.id, s.footage) })), dibuang: [...kecuali].map((id) => ({ id, alasan: 'dikecualikan tim' })) }));
  say('selesai', 100, `${potongan.length} potongan · ${bpm} BPM`);
  process.exit(0);
}
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
      { op: 'add_clip', track_kind: 'video', media: '$sumber:F1', start_ms: 0, duration_ms: 1000 + i * 100, in_ms: (job.batch === 'satu-rusak' || (job.akun_sendiri ?? []).includes('@rusakuji')) && i === 2 ? 60_000 : i * 100, volume: 0, crop: { x: 0, y: 0.1, w: 1, h: 0.8 }, blur: [{ x: 0.7, y: 0.85, w: 0.25, h: 0.1, dari_ms: 0, sampai_ms: 3000, radius: 20 }] },
      { op: 'add_clip', track_kind: 'audio', media: '$vokal:F1', start_ms: 0, duration_ms: 1000 + i * 100 },
      { op: 'add_clip', track_kind: 'subtitle', text: `Hook ${i}`, start_ms: 0, duration_ms: 800 },
    ];
    fs.writeFileSync(path.join(out, id, 'ops.json'), JSON.stringify({ schema: 'ms-ops/1', mode: 'u3', aset_lokal: [], ops }));
    fs.writeFileSync(path.join(out, id, 'rencana.json'), JSON.stringify({ schema: 'engine-rencana/1', status: 'siap', hook: { teks: `Hook ${i}` } }));
    const kalimat = i === 2 ? undefined : [{ teks: `Hook ${i}`, dari: 0, sampai: 0.8, shot: ['F1#00'] }, { teks: 'Cek keranjang', dari: 0.8, sampai: 1.1, shot: ['F1#01', 'F1#00', 'F1＠1.5'] }];
    // Contract v0.3.3 §10: a row the engine itself found invalid carries `rusak` (+ qc_lulus false).
    const rusakMesin = (job.akun_sendiri ?? []).includes('@rusakmesin') && i === 1 ? { rusak: 'Durasi VO melebihi footage yang tersedia', qc_lulus: false } : {};
    rows.push({ id, ...(kalimat ? { kalimat } : {}), vo: 'F1', hook: `Hook ${i}`, shot: ['F1@0.1'], footage: ['F1'], musik: null, durasi: 1 + i / 10, cta: 'Cek keranjang', status: 'usul', bukan_iklan: i === 3, qc_lulus: true, folder: `out/${id}`, ...rusakMesin });
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
if (what === 'lagu' && !job.abaikan_cek_ucapan) {
  // R1 (engine 5f91dfb): audio that sounds like a song is refused unless the team says "tetap lanjut".
  fs.writeFileSync(path.join(out, 'rencana.json'), JSON.stringify({ schema: 'engine-rencana/1', status: 'ditolak', alasan: 'Audio terdengar seperti lirik lagu (78% kata Inggris). Generate butuh orang bicara. Kalau yakin ini ucapan, jalankan ulang dengan "tetap lanjut".' }));
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
fs.writeFileSync(path.join(out, 'qc_rencana.json'), JSON.stringify({ butir: [{ butir: 'durasi sesuai target', lulus: false, nilai: 1.5 }, { butir: 'hook di 3 detik pertama', lulus: true }] }));
fs.writeFileSync(path.join(out, 'rencana.json'), JSON.stringify({ schema: 'engine-rencana/1', status: 'siap', posisi_caption: 0.72, audio: { sfx: 1, musik: '$musik:lokal-01', lisensi_musik: 'milik_sendiri' }, durasi: { mentah: 3, akhir: 1.5, target: null, saran: [15, 30] }, hook: { teks: 'Celana adem', dari: 0, sampai: 1.2, sumber: 'aturan' }, peringatan: [], ragu: [{ detik: 0.6, teks: 'adem', alasan: 'Whisper kurang yakin (0.41)' }], mode_job: mode }));
say('selesai', 100);
process.exit(0);
