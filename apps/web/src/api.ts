/**
 * Typed client for the server API (apps/server). Local mode: URL token (memory/sessionStorage only).
 * Google mode (W09): no token at all; the HttpOnly session cookie travels by itself, and every call
 * carries `x-motion-request: 1`, which the server requires (a cross-site page cannot send it).
 */

export interface ProjectSummary {
  project_id: string;
  name?: string;
  status?: 'active' | 'archived';
  revision?: number;
  created_at?: number;
  updated_at?: number;
  error?: string;
}

export interface Clip {
  clip_id: string;
  start_ms: number;
  end_ms: number;
  in_ms?: number;
  media?: { media_id: string; version_id: string };
  text?: string;
}

export type EditOp =
  | { op: 'add_clip'; track_kind: Track['kind']; media?: { media_id: string; version_id: string }; text?: string; start_ms: number; duration_ms: number; in_ms?: number }
  | { op: 'move_clip'; clip_id: string; start_ms: number }
  | { op: 'trim_clip'; clip_id: string; edge: 'start' | 'end'; to_ms: number }
  | { op: 'split_clip'; clip_id: string; at_ms: number }
  | { op: 'delete_clip'; clip_id: string }
  | { op: 'set_text'; clip_id: string; text: string }
  | { op: 'set_canvas'; ratio: '9:16' | '3:4' | '1:1' | '16:9' };
export interface Track {
  track_id: string;
  kind: 'video' | 'broll' | 'text' | 'subtitle' | 'audio' | 'effects';
  clips: Clip[];
}
export interface Project extends Required<Omit<ProjectSummary, 'error'>> {
  timeline: { tracks: Track[]; canvas?: { ratio: '9:16' | '3:4' | '1:1' | '16:9' } };
  history: { undo: number; redo: number; undo_label: string | null; redo_label: string | null };
}

export interface Version {
  version_id: string;
  original_name: string;
  size: number;
  content_hash: string;
  imported_at: number;
  lifecycle: 'active' | 'trashed' | 'purged';
  integrity: 'ok' | 'missing' | 'changed';
  ever_referenced: boolean;
  keep: boolean;
  pin: boolean;
  legal_hold: boolean;
  trashed_at: number | null;
  probe?: { duration_ms: number; width: number | null; height: number | null; video_codec: string | null; audio_codec: string | null } | null;
  /** Browser can preview this codec. */
  preview?: boolean;
}

export interface Media {
  media_id: string;
  display_name: string;
  scope: { kind: 'shared' } | { kind: 'project'; project_id: string };
  created_at: number;
  current_version_id: string;
  versions: Version[];
}

export interface TrashItem extends Version {
  media_id: string;
  display_name: string;
  original_rel_path: string;
}

export interface PurgePlan {
  request_id: string;
  confirmation_token: string;
  required_phrase: string;
  expires_at: number;
  irreversible: true;
  total_bytes: number;
  items: {
    version_id: string;
    media_id: string;
    filename: string;
    size: number;
    trashed_at: number | null;
    referenced_by: ({ kind: 'project'; project_id: string; source: string } | { kind: 'lease'; lease_id: string; job: string })[];
    protected_by: string[];
    backup: { status: 'verified' | 'unverified'; location?: string };
    purgeable: boolean;
    blockers: string[];
  }[];
}

export interface Dashboard {
  stats: {
    usage: Record<string, number>;
    media_bytes: number;
    disk: { free_bytes: number; total_bytes: number } | null;
    warnings: { code: string; advice: string }[];
  };
  gc: { ok: boolean; errors: string[]; summary: Record<string, number>; candidates: number; next_eligible: { version_id: string; eligible_at: number }[] };
  trash: { version_id: string; filename: string; size: number; trashed_at: number }[];
  pending_operations: number;
  corrupt_journal: number;
  backup: { verified: number; active_versions: number };
}

export type RenderStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'blocked';
export type RenderPhase = 'preflight' | 'preparing' | 'encoding' | 'verifying' | 'saving';

export interface RenderJob {
  job_id: string;
  project_id: string;
  output_name: string;
  status: RenderStatus;
  phase: RenderPhase | null;
  progress: number;
  created_at: number;
  finished_at: number | null;
  output: { name: string; size: number; hash: string; duration_ms: number; width: number; height: number; metadata_clean: true; kept_tags: string[] } | null;
  problems: { code: string; media_id?: string; version_id?: string }[];
  error: { code: string; message: string } | null;
}

export interface RenderOutputFile {
  name: string;
  size: number;
  mtime_ms: number;
}

export interface RenderTools {
  ok: boolean;
  version: string | null;
  problems: string[];
  font: boolean;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface Session {
  actor: string;
  workspace_id: string;
  storage_backend: string;
  auth: 'local' | 'google';
  user: { email: string; name: string } | null;
}

/** Public: which login the server uses. */
export async function authMode(base = ''): Promise<'local' | 'google'> {
  const r = await fetch(`${base}/api/auth/mode`);
  if (!r.ok) throw new ApiError(r.status, 'UNKNOWN', `HTTP ${r.status}`);
  const data = (await r.json()) as { mode?: string };
  return data.mode === 'google' ? 'google' : 'local';
}

export function createApi(token: string | null, base = '') {
  const authHeaders = (): Record<string, string> => ({ 'x-motion-request': '1', ...(token ? { authorization: `Bearer ${token}` } : {}) });
  async function call<T>(method: string, path: string, init: { json?: unknown; body?: Blob | File; headers?: Record<string, string> } = {}): Promise<T> {
    const headers: Record<string, string> = { ...authHeaders(), ...init.headers };
    let body: BodyInit | undefined;
    if (init.json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(init.json);
    } else if (init.body) body = init.body;
    let res: Response;
    try {
      res = await fetch(`${base}${path}`, { method, headers, ...(body !== undefined ? { body } : {}) });
    } catch {
      throw new ApiError(0, 'NETWORK', 'Server tidak bisa dihubungi. Pastikan server masih jalan.');
    }
    const data = (await res.json().catch(() => ({}))) as { error?: { code: string; message: string } } & T;
    if (!res.ok) throw new ApiError(res.status, data.error?.code ?? 'UNKNOWN', data.error?.message ?? `HTTP ${res.status}`);
    return data;
  }

  return {
    session: () => call<Session>('GET', '/api/session'),
    logout: () => call<{ ok: true }>('POST', '/api/auth/logout', { json: {} }),
    projects: () => call<{ projects: ProjectSummary[] }>('GET', '/api/projects').then((r) => r.projects),
    createProject: (name: string) => call<{ project: ProjectSummary }>('POST', '/api/projects', { json: { name } }).then((r) => r.project),
    project: (id: string) => call<{ project: Project }>('GET', `/api/projects/${encodeURIComponent(id)}`).then((r) => r.project),
    /** Server applies the ops atomically and returns the new revision (409 CONFLICT if stale). */
    editProject: (id: string, expected_revision: number, ops: EditOp[]) =>
      call<{ project: Project }>('POST', `/api/projects/${encodeURIComponent(id)}/edit`, { json: { expected_revision, ops } }).then((r) => r.project),
    stepHistory: (id: string, expected_revision: number, direction: 'undo' | 'redo') =>
      call<{ project: Project }>('POST', `/api/projects/${encodeURIComponent(id)}/${direction}`, { json: { expected_revision } }).then((r) => r.project),
    media: (q: { scope?: 'all' | 'shared' | 'project'; project_id?: string } = {}) => {
      const p = new URLSearchParams();
      if (q.scope) p.set('scope', q.scope);
      if (q.project_id) p.set('project_id', q.project_id);
      return call<{ media: Media[] }>('GET', `/api/media?${p}`).then((r) => r.media);
    },
    /** Upload with progress (XHR: fetch has no upload progress). Bytes go raw; the server hashes them. */
    importFile: (file: File, scope: { kind: 'shared' } | { kind: 'project'; project_id: string }, onProgress?: (fraction: number) => void) => {
      const p = new URLSearchParams({ scope: scope.kind });
      if (scope.kind === 'project') p.set('project_id', scope.project_id);
      return new Promise<{ media_id: string; version: Version; duplicate: boolean }>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `${base}/api/media/import?${p}`);
        for (const [k, v] of Object.entries(authHeaders())) xhr.setRequestHeader(k, v);
        xhr.setRequestHeader('content-type', 'application/octet-stream');
        xhr.setRequestHeader('x-file-name', encodeURIComponent(file.name));
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) onProgress?.(e.loaded / e.total);
        };
        xhr.onerror = () => reject(new ApiError(0, 'NETWORK', 'Upload terputus. Pastikan server masih jalan.'));
        xhr.onload = () => {
          let data: { error?: { code: string; message: string } } = {};
          try {
            data = JSON.parse(xhr.responseText || '{}');
          } catch {
            /* non-JSON reply */
          }
          if (xhr.status >= 200 && xhr.status < 300) resolve(data as { media_id: string; version: Version; duplicate: boolean });
          else reject(new ApiError(xhr.status, data.error?.code ?? 'UNKNOWN', data.error?.message ?? `HTTP ${xhr.status}`));
        };
        xhr.send(file);
      });
    },
    trash: () => call<{ items: TrashItem[] }>('GET', '/api/trash').then((r) => r.items),
    restore: (versionId: string, opts: { on_conflict?: 'ask' | 'alternate' } = {}) =>
      call<{ result: { status: 'restored' | 'conflict' | 'failed'; reason?: string; wanted?: string; suggested?: string } }>('POST', `/api/trash/${encodeURIComponent(versionId)}/restore`, { json: opts }).then((r) => r.result),
    preparePurge: (versionIds: string[]) => call<{ plan: PurgePlan }>('POST', '/api/purge/prepare', { json: { version_ids: versionIds } }).then((r) => r.plan),
    executePurge: (plan: PurgePlan, typedPhrase: string) =>
      call<{ result: { purged: string[]; blocked: { version_id: string; reasons: string[] }[]; freed_bytes: number } }>('POST', '/api/purge/execute', {
        json: { request_id: plan.request_id, confirmation_token: plan.confirmation_token, typed_phrase: typedPhrase },
      }).then((r) => r.result),
    /** Short-lived signed playback URL for one media version (W07). */
    streamUrl: (versionId: string) => call<{ url: string; expires_at: number; mime: string }>('GET', `/api/media/${encodeURIComponent(versionId)}/stream-url`),
    dashboard: () => call<{ dashboard: Dashboard }>('GET', '/api/dashboard').then((r) => r.dashboard),
    // Render MP4 (W08)
    renderTools: () => call<RenderTools>('GET', '/api/render/tools'),
    startRender: (id: string, opts: { output_name?: string; short_side?: 720 | 1080 }) =>
      call<{ job: RenderJob }>('POST', `/api/projects/${encodeURIComponent(id)}/render`, { json: opts }).then((r) => r.job),
    renders: (id: string) => call<{ jobs: RenderJob[]; outputs: RenderOutputFile[] }>('GET', `/api/projects/${encodeURIComponent(id)}/renders`),
    cancelRender: (jobId: string) => call<{ job: RenderJob }>('POST', `/api/render/jobs/${encodeURIComponent(jobId)}/cancel`, { json: {} }).then((r) => r.job),
    /** Short-lived signed link to play (or download) one finished output. */
    outputUrl: (id: string, name: string, download = false) =>
      call<{ url: string; expires_at: number }>('GET', `/api/projects/${encodeURIComponent(id)}/output-url?${new URLSearchParams({ name, ...(download ? { download: '1' } : {}) })}`),
  };
}

export type Api = ReturnType<typeof createApi>;
