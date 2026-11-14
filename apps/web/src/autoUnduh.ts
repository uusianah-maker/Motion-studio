import type { Api, RenderJob } from './api';

/**
 * Unduh otomatis (owner 14 Nov): begitu render yang DIMULAI DI BROWSER INI selesai, videonya langsung
 * diunduh ke komputer ini — aplikasi = pintu input/output, video dikerjakan lanjut di PC masing-masing.
 * Pemantau hidup di modul (bukan di dialog), jadi tetap jalan walau jendela Render ditutup atau pindah menu,
 * selama tab aplikasi masih terbuka. Satu job hanya diunduh sekali.
 */
const dipantau = new Set<string>();
let antrean: Promise<void> = Promise.resolve();
const SELESAI = new Set(['completed', 'failed', 'blocked', 'cancelled']);

function unduh(url: string, name: string) {
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function pantauDanUnduh(api: Api, job: RenderJob, onSelesai?: (j: RenderJob) => void): void {
  if (dipantau.has(job.job_id)) return;
  dipantau.add(job.job_id);
  const cek = async (): Promise<void> => {
    let j: RenderJob;
    try {
      j = await api.renderJob(job.job_id);
    } catch {
      setTimeout(() => void cek(), 5000); // server restart / koneksi putus sebentar: coba lagi
      return;
    }
    if (!SELESAI.has(j.status)) {
      setTimeout(() => void cek(), 1500);
      return;
    }
    if (j.status === 'completed' && j.output) {
      const out = j.output;
      // Berurutan + jeda: browser menolak banyak unduhan sekaligus.
      antrean = antrean.then(async () => {
        try {
          const { url } = await api.outputUrl(j.project_id, out.name, true);
          unduh(url, out.name);
          await new Promise((r) => setTimeout(r, 900));
        } catch {
          /* tetap bisa diunduh manual dari menu Hasil */
        }
      });
    }
    onSelesai?.(j);
  };
  void cek();
}
