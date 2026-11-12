import { useCallback, useEffect, useState } from 'react';
import type { Api, Project, VariantRow } from '../api';
import { ErrorNotice, Modal } from '../ui';

type Brief = { label: string; ratio: '' | '9:16' | '1:1' | '3:4' | '16:9'; hook: string; cta: string };
const EMPTY: Brief = { label: '', ratio: '', hook: '', cta: '' };
const MAX = 8;
const STATE: Record<VariantRow['state'], { text: string; cls: string }> = {
  draft: { text: 'Belum disetujui', cls: '' },
  approved: { text: 'Disetujui', cls: 'ok' },
  changed: { text: 'Diubah setelah disetujui', cls: 'warn' },
};
const RENDER: Record<string, string> = { queued: 'Antre', running: 'Merender', completed: 'Selesai', failed: 'Gagal', blocked: 'Diblokir', cancelled: 'Dibatalkan' };

/**
 * Ad variants (X09, PRD workflow C): from this master, write briefs (ratio / hook / CTA), create one
 * project per brief, approve each one, then queue renders for the approved ones. The master is
 * never changed. Approval belongs to a revision: editing a variant later needs a new approval.
 */
export function VariantsDialog({ api, project, onClose, onOpen, onCreated }: { api: Api; project: Project; onClose: () => void; onOpen: (id: string) => void; onCreated: () => void }) {
  const [briefs, setBriefs] = useState<Brief[]>([{ ...EMPTY }, { ...EMPTY }]);
  const [rows, setRows] = useState<VariantRow[] | null>(null);
  const [short, setShort] = useState<720 | 1080>(1080);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [skipped, setSkipped] = useState<{ project_id: string; reason: string }[]>([]);

  const load = useCallback(async () => {
    try {
      setRows(await api.variants(project.project_id));
    } catch (e) {
      setError(e);
    }
  }, [api, project.project_id]);
  useEffect(() => void load(), [load]);
  const rendering = (rows ?? []).some((r) => r.render && (r.render.status === 'queued' || r.render.status === 'running'));
  useEffect(() => {
    if (!rendering) return;
    const id = setInterval(() => void load(), 1000);
    return () => clearInterval(id);
  }, [rendering, load]);

  const filled = briefs.filter((b) => b.ratio || b.hook.trim() || b.cta.trim());
  const set = (i: number, patch: Partial<Brief>) => setBriefs(briefs.map((b, j) => (j === i ? { ...b, ...patch } : b)));
  const act = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };

  const create = () =>
    act('create', async () => {
      await api.createVariants(
        project.project_id,
        filled.map((b) => ({ ...(b.label.trim() ? { label: b.label.trim() } : {}), ...(b.ratio ? { ratio: b.ratio } : {}), ...(b.hook.trim() ? { hook: b.hook.trim() } : {}), ...(b.cta.trim() ? { cta: b.cta.trim() } : {}) })),
      );
      setBriefs([{ ...EMPTY }]);
      await load();
      onCreated();
    });
  const approve = (r: VariantRow, approved: boolean) =>
    act(`ap-${r.project_id}`, async () => {
      await api.setVariantApproval(r.project_id, r.revision, approved);
      await load();
      onCreated();
    });
  const approvedCount = (rows ?? []).filter((r) => r.state === 'approved' && !(r.render && (r.render.status === 'queued' || r.render.status === 'running'))).length;
  const renderAll = () =>
    act('render', async () => {
      const res = await api.renderVariants(project.project_id, { short_side: short });
      setSkipped(res.skipped);
      await load();
    });
  const nameOf = (id: string) => rows?.find((r) => r.project_id === id)?.label ?? id;

  return (
    <Modal title="Varian iklan" onClose={onClose} busy={busy === 'create'}>
      <div className="muted small">
        Dari master <b>{project.name}</b>: tiap brief jadi proyek baru (master tidak berubah). Setujui satu per satu, lalu render yang disetujui. Render lokal: tanpa biaya AI.
      </div>
      {error ? <ErrorNotice error={error} /> : null}

      <section aria-label="Brief varian" className="variantBriefs">
        <b>Brief baru</b>
        {briefs.map((b, i) => (
          <div key={i} className="briefRow">
            <span className="muted small">#{i + 1}</span>
            <input aria-label={`Nama varian ${i + 1}`} placeholder="Nama (opsional)" maxLength={60} value={b.label} onChange={(e) => set(i, { label: e.target.value })} />
            <select aria-label={`Rasio varian ${i + 1}`} value={b.ratio} onChange={(e) => set(i, { ratio: e.target.value as Brief['ratio'] })}>
              <option value="">Rasio master</option>
              {(['9:16', '1:1', '3:4', '16:9'] as const).map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
            <input aria-label={`Hook varian ${i + 1}`} placeholder="Hook (teks pembuka)" maxLength={500} value={b.hook} onChange={(e) => set(i, { hook: e.target.value })} />
            <input aria-label={`CTA varian ${i + 1}`} placeholder="CTA (penutup)" maxLength={500} value={b.cta} onChange={(e) => set(i, { cta: e.target.value })} />
            <button className="tiny" aria-label={`Hapus brief ${i + 1}`} onClick={() => setBriefs(briefs.filter((_, j) => j !== i))} disabled={briefs.length === 1}>
              ×
            </button>
          </div>
        ))}
        <div className="row" style={{ gap: 8 }}>
          <button className="btn small" disabled={briefs.length >= MAX} onClick={() => setBriefs([...briefs, { ...EMPTY }])}>
            ＋ Brief
          </button>
          <button className="btn primary small" disabled={!!busy || filled.length === 0} onClick={() => void create()}>
            {busy === 'create' ? 'Membuat…' : `Buat ${filled.length} varian`}
          </button>
          <span className="muted small">Hook mengganti teks pertama (≤ 3 dtk), CTA mengganti teks di akhir; kalau belum ada, ditambah dengan preset.</span>
        </div>
      </section>

      <section aria-label="Daftar varian" className="variantList">
        <b>Varian ({rows?.length ?? '…'})</b>
        {rows?.length === 0 && <div className="muted small">Belum ada varian dari master ini.</div>}
        {rows?.map((r) => (
          <div key={r.project_id} className="variantRow" data-variant={r.number}>
            <span className="badge vio">V{r.number}</span>
            <span className="variantInfo">
              <b>{r.label}</b>
              <small className="muted">
                {r.ratio}
                {r.brief.hook ? ` · Hook “${r.brief.hook}”` : ''}
                {r.brief.cta ? ` · CTA “${r.brief.cta}”` : ''}
              </small>
            </span>
            <span className={`badge ${STATE[r.state].cls}`}>{STATE[r.state].text}</span>
            <span className="variantRender muted small">
              {r.render ? `${RENDER[r.render.status] ?? r.render.status}${r.render.status === 'running' ? ` ${Math.round(r.render.progress * 100)}%` : ''}${r.render.status === 'completed' ? ` · ${r.render.output_name}` : ''}${r.render.error ? ` · ${r.render.error.message}` : ''}${r.render.problems.length ? ` · ${r.render.problems.map((p) => p.code).join(', ')}` : ''}` : r.outputs ? `${r.outputs} file` : '—'}
            </span>
            {r.state === 'approved' ? (
              <button className="btn small" disabled={!!busy} aria-label={`Batalkan persetujuan V${r.number}`} onClick={() => void approve(r, false)}>
                Batalkan
              </button>
            ) : (
              <button className="btn small primary" disabled={!!busy} aria-label={`Setujui V${r.number}`} onClick={() => void approve(r, true)}>
                {r.state === 'changed' ? 'Setujui ulang' : 'Setujui'}
              </button>
            )}
            <button className="btn small" aria-label={`Buka V${r.number}`} onClick={() => onOpen(r.project_id)}>
              Buka
            </button>
          </div>
        ))}
      </section>

      <div className="row" style={{ gap: 8, alignItems: 'center' }}>
        <select aria-label="Resolusi render varian" value={short} onChange={(e) => setShort(Number(e.target.value) as 720 | 1080)}>
          <option value={1080}>1080p</option>
          <option value={720}>720p</option>
        </select>
        <button className="btn primary" disabled={!!busy || approvedCount === 0} onClick={() => void renderAll()}>
          {busy === 'render' ? 'Mengantre…' : `↧ Render yang disetujui (${approvedCount})`}
        </button>
        {rendering && <span className="muted small">Merender… dialog boleh ditutup; render jalan terus di server.</span>}
      </div>
      {skipped.length > 0 && (
        <div className="notice warn small" role="status">
          Dilewati: {skipped.map((s) => `${nameOf(s.project_id)} (${s.reason})`).join(', ')}
        </div>
      )}

      <div className="modalActions">
        <button className="btn" onClick={onClose} disabled={busy === 'create'}>
          Tutup
        </button>
      </div>
    </Modal>
  );
}
