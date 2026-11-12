import { useCallback, useEffect, useState } from 'react';
import type { Api, Project, ReviewInfo, Role } from '../api';
import { formatDuration } from '../lib';
import { ErrorNotice } from '../ui';

/**
 * U7: comments at a timecode (everyone) + review Lulus / Revisi (owner & reviewer). The server
 * enforces the roles; here buttons a role cannot use are simply not offered.
 */
export const REVIEW_STATE: Record<ReviewInfo['state'], string> = { belum: 'Belum direview', lulus: 'Lulus', revisi: 'Perlu revisi', berubah: 'Diubah setelah Lulus' };

export function ReviewPanel({ api, project, role, playheadMs, onSeek }: { api: Api; project: Project; role: Role; playheadMs: number; onSeek: (ms: number) => void }) {
  const [info, setInfo] = useState<ReviewInfo | null>(null);
  const [text, setText] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(async () => {
    try {
      setInfo(await api.review(project.project_id));
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, [api, project.project_id]);
  useEffect(() => {
    void load();
  }, [load, project.revision]);
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await load();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const approver = role !== 'editor';
  const open = info?.comments.filter((c) => !c.resolved_at).length ?? 0;

  return (
    <section className="reviewPanel" aria-label="Review">
      <div className="row" style={{ alignItems: 'center', gap: 8 }}>
        <b>Review</b>
        {info && (
          <span className={`badge ${info.state === 'lulus' ? 'ok' : info.state === 'belum' ? '' : 'warn'}`} data-state={info.state}>
            {REVIEW_STATE[info.state]}
          </span>
        )}
        <span className="spacer" />
        <span className="muted small">{open} terbuka</span>
      </div>
      <ErrorNotice error={error} />
      {info?.decision && (
        <div className="muted small">
          {REVIEW_STATE[info.decision.status === 'lulus' ? 'lulus' : 'revisi']} oleh {info.decision.by.name}
          {info.decision.note ? ` — ${info.decision.note}` : ''}
        </div>
      )}
      <ol className="comments" aria-label="Komentar">
        {info?.comments.map((c) => (
          <li key={c.comment_id} className={c.resolved_at ? 'done' : ''}>
            <button className="linkBtn small" onClick={() => onSeek(c.at_ms)} aria-label={`Ke ${formatDuration(c.at_ms)}`}>
              {formatDuration(c.at_ms)}
            </button>
            <span className="small">
              <b>{c.author.name}</b> {c.text}
            </span>
            <label className="inline small">
              <input type="checkbox" aria-label={`Selesai: ${c.text}`} checked={!!c.resolved_at} disabled={busy} onChange={(e) => void act(() => api.resolveComment(project.project_id, c.comment_id, e.target.checked))} /> selesai
            </label>
          </li>
        ))}
      </ol>
      <div className="row" style={{ gap: 6 }}>
        <input aria-label="Komentar di playhead" placeholder={`Komentar di ${formatDuration(playheadMs)}…`} value={text} maxLength={1000} onChange={(e) => setText(e.target.value)} />
        <button
          className="btn small"
          disabled={busy || !text.trim()}
          onClick={() =>
            void act(async () => {
              await api.addComment(project.project_id, Math.round(playheadMs), text.trim());
              setText('');
            })
          }
        >
          Kirim
        </button>
      </div>
      {approver && (
        <div className="row wrap" style={{ gap: 6 }}>
          <button className="btn small primary" disabled={busy || open > 0} title={open ? 'Selesaikan komentar terbuka dulu' : 'Tandai revisi ini Lulus'} onClick={() => void act(() => api.decideReview(project.project_id, project.revision, 'lulus'))}>
            ✓ Lulus
          </button>
          <input aria-label="Catatan revisi" placeholder="Apa yang perlu direvisi…" value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} />
          <button
            className="btn small"
            disabled={busy || !note.trim()}
            onClick={() =>
              void act(async () => {
                await api.decideReview(project.project_id, project.revision, 'revisi', note.trim());
                setNote('');
              })
            }
          >
            ↺ Revisi
          </button>
        </div>
      )}
    </section>
  );
}
