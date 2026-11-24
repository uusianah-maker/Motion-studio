/**
 * R17 (owner: "Ya, rapikan"): one door for making a video. Four ways, each card says WHEN to use it
 * and WHAT to prepare; opening a card shows that feature's page inside "Buat video" (tab bar on top),
 * and every draft ends with "Buka di Edit".
 */
export type BuatFitur = 'generate' | 'batch' | 'beatspot' | 'transfer' | 'suara';

export const FITUR: { id: BuatFitur; nama: string; sym: string; kapan: string; bahan: string[]; hasil: string }[] = [
  {
    id: 'generate',
    nama: 'Video iklan',
    sym: '⚡',
    kapan: 'Satu video orang bicara ke kamera (review / jualan) mau dijadikan iklan siap tayang.',
    bahan: ['1 video bicara (talking head)', 'Brand + produk di Brand Kit', 'Harga & catatan (opsional)'],
    hasil: 'Draf edit (potong jeda, hook, caption, musik) → Edit → render → Hasil.',
  },
  {
    id: 'batch',
    nama: 'Batch Remix',
    sym: '▦',
    kapan: 'Banyak footage lama/winning mau dijadikan puluhan varian sekaligus untuk uji iklan.',
    bahan: ['Footage yang sudah dipisah (Pisah Audio ada di halaman Batch Remix)', 'Voice over (opsional)', 'Jumlah varian & tujuan'],
    hasil: 'Tabel varian → pilih / buang → render massal.',
  },
  {
    id: 'beatspot',
    nama: 'Beat Spot',
    sym: '♪',
    kapan: 'Video awareness: orang-orang memakai produk (mis. di mall) dipotong tepat di ketukan sound.',
    bahan: ['Beberapa footage orang memakai produk', 'Sound tim (opsional; tanpa sound pakai BPM)', 'Logo + end card di Brand Kit'],
    hasil: 'Potongan di ketukan → Edit → render → Hasil.',
  },
  {
    id: 'transfer',
    nama: 'Motion Transfer',
    sym: '⇄',
    kapan: 'Ada video orang lain yang konsepnya mau ditiru dengan produk sendiri (lewat alat AI gambar/video).',
    bahan: ['1 video referensi', 'Produk di Brand Kit (+ foto produk untuk alat AI)'],
    hasil: 'Adegan + gambar + prompt siap salin (tanpa biaya API).',
  },
  {
    id: 'suara',
    nama: 'Suara dari Teks',
    sym: '🔊',
    kapan: 'Butuh voice over dari tulisan (tanpa rekam suara): naskah iklan, CTA, penjelasan produk.',
    bahan: ['Teks / naskah (paragraf)', 'Ketik teks atau upload rekaman VO, lalu pilih suara (Andika / Ayu / Grace / Julia / Niar), gaya bicara, dan model pembaca', 'Pelafalan kata sulit di Brand Kit (opsional)'],
    hasil: 'VO per kalimat + lengkap → tersimpan di Aset (VO) → linimasa + subtitle dari teks (tanpa Whisper).',
  },
];

export function BuatVideoView({ onOpen }: { onOpen: (f: BuatFitur) => void }) {
  return (
    <>
      <header className="top">
        <h1>Buat video</h1>
        <div className="spacer" />
        <span className="muted small hideNarrow">Pilih cara membuat video; drafnya selalu bisa diubah lagi di Edit</span>
      </header>
      <div className="body">
        <div className="buatGrid">
          {FITUR.map((f) => (
            <section key={f.id} className="card buatCard" aria-label={f.nama}>
              <h2>
                <span aria-hidden="true">{f.sym}</span> {f.nama}
              </h2>
              <p className="small">
                <b>Kapan dipakai:</b> {f.kapan}
              </p>
              <div className="small">
                <b>Siapkan:</b>
                <ul className="buatBahan">
                  {f.bahan.map((b) => (
                    <li key={b}>{b}</li>
                  ))}
                </ul>
              </div>
              <p className="muted small">{f.hasil}</p>
              <button className="btn primary" onClick={() => onOpen(f.id)}>
                Buka {f.nama} →
              </button>
            </section>
          ))}
        </div>
      </div>
    </>
  );
}

/** Tab bar above a feature page: the other ways one click away, and back to the overview. */
export function BuatTabs({ current, onOpen, onHub }: { current: BuatFitur; onOpen: (f: BuatFitur) => void; onHub: () => void }) {
  return (
    <nav className="buatTabs" aria-label="Cara membuat video">
      <button className="btn small" onClick={onHub}>
        ← Buat video
      </button>
      {FITUR.map((f) => (
        <button key={f.id} className={`btn small${f.id === current ? ' sel' : ''}`} aria-current={f.id === current ? 'page' : undefined} onClick={() => onOpen(f.id)}>
          <span aria-hidden="true">{f.sym}</span> {f.nama}
        </button>
      ))}
    </nav>
  );
}
