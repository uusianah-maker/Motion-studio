import type { Route } from './app.js';
import { type Workspace, addComment, approvalQueue, decideReview, readReview, resolveComment } from './core.js';
import { ApiError } from './errors.js';
import { readJsonBody } from './http.js';
import { onlyKeys } from './routes.js';

/**
 * U7 routes: comments at a timecode (any role) and the review decision Lulus / Revisi (owner and
 * reviewer — enforced by the role table in roles.ts before these handlers run).
 */
export function reviewRoutes(ws: Workspace): Route[] {
  const author = (user: { email: string; name: string } | null) => (user ? { email: user.email, name: user.name } : { email: null, name: 'Pemilik (PC ini)' });
  const commentId = (x: string | undefined) => {
    if (!x || !/^cm_[0-9a-f]{16}$/.test(x)) throw new ApiError(404, 'NOT_FOUND', 'Komentar tidak ada');
    return x;
  };
  return [
    {
      // R10: the PIC's queue — every rendered video waiting for Lulus / Revisi (one brand or all).
      method: 'GET',
      path: '/api/review/antrean',
      handle: async ({ url }) => {
        const b = url.searchParams.get('brand_id');
        if (b !== null && b !== '' && !/^[A-Za-z0-9_-]{1,64}$/.test(b)) throw new ApiError(400, 'BAD_REQUEST', 'brand_id tidak valid');
        return { items: await approvalQueue(ws, b ? { brand_id: b } : {}) };
      },
    },
    {
      method: 'GET',
      path: '/api/projects/:project_id/review',
      handle: async ({ params }) => ({ review: await readReview(ws, params.project_id!) }),
    },
    {
      method: 'POST',
      path: '/api/projects/:project_id/comments',
      handle: async ({ req, params, user }) => {
        const body = await readJsonBody(req);
        onlyKeys(body, ['at_ms', 'text']);
        return { comment: await addComment(ws, { project_id: params.project_id!, at_ms: body.at_ms, text: body.text, author: author(user) }) };
      },
    },
    {
      method: 'POST',
      path: '/api/projects/:project_id/comments/:comment_id/resolve',
      handle: async ({ req, params, user }) => {
        const body = await readJsonBody(req);
        onlyKeys(body, ['resolved']);
        return { comment: await resolveComment(ws, { project_id: params.project_id!, comment_id: commentId(params.comment_id), resolved: body.resolved, author: author(user) }) };
      },
    },
    {
      method: 'POST',
      path: '/api/projects/:project_id/review',
      handle: async ({ req, params, user }) => {
        const body = await readJsonBody(req);
        onlyKeys(body, ['expected_revision', 'status', 'note']);
        return decideReview(ws, { project_id: params.project_id!, expected_revision: body.expected_revision, status: body.status, note: body.note, author: author(user) });
      },
    },
  ];
}
