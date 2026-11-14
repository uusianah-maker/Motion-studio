import type { Route } from './app.js';
import type { Copilot } from './copilot.js';
import { type MediaVisuals, type Workspace, analyzeMedia, audit, cutOps, mediaVisuals, readProject } from './core.js';
import { ApiError } from './errors.js';
import { readJsonBody } from './http.js';
import { onlyKeys } from './routes.js';

/**
 * X07 routes: analyse a media version for silences + scene changes (FFmpeg, read-only, no AI),
 * then turn the user's chosen cuts into a normal reviewed plan (diff → approve → one undo step).
 */
export function cutRoutes(ws: Workspace, opts: { copilot: Copilot }): Route[] {
  // One analysis at a time per server: it is CPU-heavy on long footage.
  let running = false;
  // Timeline visuals: one FFmpeg pass per version, shared by concurrent requests, then cached on disk.
  const visuals = new Map<string, Promise<MediaVisuals>>();
  return [
    {
      method: 'GET',
      path: '/api/media/:version_id/visuals',
      handle: async ({ params }) => {
        const id = params.version_id!;
        let p = visuals.get(id);
        if (!p) {
          p = mediaVisuals(ws, { version_id: id })
            .then(({ cached: _cached, ...v }) => v)
            .finally(() => visuals.delete(id));
          visuals.set(id, p);
        }
        return { visuals: await p };
      },
    },
    {
      method: 'POST',
      path: '/api/media/:version_id/analyze',
      handle: async ({ req, params, actor }) => {
        const body = await readJsonBody(req);
        onlyKeys(body, ['params']);
        if (running) throw new ApiError(409, 'BUSY', 'Analisis lain sedang berjalan; tunggu sampai selesai');
        running = true;
        const ac = new AbortController();
        const onClose = () => ac.abort(); // the browser left: stop FFmpeg
        req.socket.once('close', onClose);
        try {
          const a = await analyzeMedia(ws, { version_id: params.version_id!, params: body.params, signal: ac.signal });
          await audit(ws, { op: 'media.analyze', actor, outcome: 'ok', version_id: a.version_id, cached: a.cached, silences: a.silences.length, scenes: a.scenes.length });
          return { analysis: a };
        } finally {
          req.socket.off('close', onClose);
          running = false;
        }
      },
    },
    {
      method: 'POST',
      path: '/api/projects/:project_id/cuts/plan',
      handle: async ({ req, params }) => {
        const body = await readJsonBody(req, 2 * 1024 * 1024);
        const project = await readProject(ws, params.project_id!);
        const r = cutOps(project.timeline, body);
        const cuts = r.ops.filter((o) => o.op === 'remove_range').length;
        const splits = r.ops.length - cuts;
        return opts.copilot.propose({
          project_id: project.project_id,
          source: 'analysis',
          prompt: `Potong ${cuts} jeda${splits ? ` + ${splits} adegan` : ''} (deteksi otomatis)`,
          ops: r.ops,
          rationale: `${cuts ? `Menghapus ${(r.removed_ms / 1000).toFixed(1).replace('.', ',')} dtk jeda di semua track (teks & subtitle ikut bergeser)` : 'Tanpa hapus jeda'}${splits ? `; potong ${splits}× di pergantian adegan` : ''}.`,
          warnings: r.warnings,
        });
      },
    },
  ];
}
