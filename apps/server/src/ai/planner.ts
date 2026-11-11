import type { AiPlanner } from '../copilot.js';
import { TEXT_PRESETS } from '../core.js';
import { ApiError } from '../errors.js';
import { AiCallError, completeJson, parseJsonObject } from './adapters.js';
import type { AiRouter } from './router.js';
import type { AiStore } from './store.js';

/**
 * LLM planner for the Copilot (W12, PRD "one-call planning path"): one model call turns the
 * prompt into JSON edit operations; the server then validates them exactly like local plans
 * (checkPlan) and the user approves. The model only sees the prompt and a timeline summary:
 * no media bytes, no file paths, no session (F7).
 */

const PRESET_LINES = TEXT_PRESETS.map((p) => `${p.id}=${JSON.stringify(p.style)}`).join('; ');

export const PLANNER_SYSTEM = `You are the planning engine of a short-video editor. Turn the user's instruction into timeline edit operations.
Answer with ONE JSON object only, no prose: {"operations": [...], "rationale": "<one short sentence in the user's language>", "warnings": ["..."]}.
Allowed operations (times in milliseconds, integers):
- {"op":"add_clip","track_kind":"text"|"subtitle","text":"...","start_ms":N,"duration_ms":N}
- {"op":"move_clip","clip_id":"...","start_ms":N}
- {"op":"trim_clip","clip_id":"...","edge":"start"|"end","to_ms":N}
- {"op":"split_clip","clip_id":"...","at_ms":N}
- {"op":"delete_clip","clip_id":"..."}
- {"op":"set_text","clip_id":"...","text":"..."}
- {"op":"set_canvas","ratio":"9:16"|"3:4"|"1:1"|"16:9"}
- {"op":"set_style","clip_id":"...","style":{...}}  (text/subtitle clips only; add_clip of text may also carry "style")
- {"op":"set_volume","clip_id":"...","volume":0..1}  (video/b-roll/audio clips only; 0 = muted, 1 = full)
- {"op":"set_track_mute","track_kind":"video"|"broll"|"audio","muted":true|false}
Style fields (all optional): x,y = centre 0..1 of canvas; size = % of canvas short side (2-20); width = line width 0.2-1; color/bg = "#rrggbb" (bg null = no box); bg_opacity 0-1; bold, outline = true/false; align = "left"|"center"|"right".
Presets (use their style for hooks, USPs, CTAs, sale/price callouts, subtitles): ${PRESET_LINES}
Rules: use only clip_id values present in the timeline; clips on one track must not overlap; text max 500 characters; at most 60 operations.
Never invent media. If the instruction cannot be done with these operations, return {"operations": [], "rationale": "<why>", "warnings": []}.`;

/** A compact, path-free view of the timeline for the model. */
export function timelineSummary(timeline: unknown): unknown {
  const t = timeline as { tracks?: { kind: string; clips: { clip_id: string; start_ms: number; end_ms: number; text?: string; media?: unknown; in_ms?: number }[] }[]; canvas?: { ratio: string } };
  return {
    canvas: t.canvas?.ratio ?? '9:16',
    tracks: (t.tracks ?? []).map((tr) => ({
      kind: tr.kind,
      clips: tr.clips.map((c) => ({ clip_id: c.clip_id, start_ms: c.start_ms, end_ms: c.end_ms, ...(c.text !== undefined ? { text: c.text } : {}), ...(c.media ? { has_media: true } : {}) })),
    })),
  };
}

/** Conservative token estimate (≈3 chars per token) for the budget gate. */
export const estimateTokens = (s: string) => Math.ceil(s.length / 3);

export function createAiPlanner(store: AiStore, router: AiRouter, fetchImpl: typeof fetch = fetch): AiPlanner {
  return {
    async unavailable() {
      return router.available('planner');
    },
    async plan(input) {
      const user = JSON.stringify({ instruction: input.prompt, timeline: timelineSummary(input.timeline), selected_clip_ids: input.selected_clip_ids, playhead_ms: Math.round(input.playhead_ms) });
      const maxOut = store.settings().max_output_tokens;
      const inTok = estimateTokens(PLANNER_SYSTEM) + estimateTokens(user);
      const r = await router.call(
        'planner',
        { project_id: input.project_id, estimate: (c) => (inTok * c.prices.input_per_mtok + maxOut * c.prices.output_per_mtok) / 1e6 },
        async (target, signal) => {
          const out = await completeJson(target, { system: PLANNER_SYSTEM, user, max_output_tokens: maxOut }, signal, fetchImpl);
          return { value: out.text, usage: out.usage, request_id: out.request_id };
        },
      );
      let obj: Record<string, unknown>;
      try {
        obj = parseJsonObject(r.value);
      } catch (e) {
        throw new ApiError(422, 'AI_OUTPUT_INVALID', `${e instanceof AiCallError ? e.message : 'Jawaban AI tidak valid'} (biaya tetap tercatat: $${r.cost_usd.toFixed(4)})`);
      }
      const ops = obj.operations;
      const rationale = typeof obj.rationale === 'string' ? obj.rationale : '';
      if (Array.isArray(ops) && ops.length === 0) {
        throw new ApiError(422, 'AI_OUTPUT_INVALID', `AI tidak bisa membuat rencana: ${rationale || 'instruksi tidak bisa dipetakan ke operasi editor'}`);
      }
      const warnings = Array.isArray(obj.warnings) ? obj.warnings.filter((w): w is string => typeof w === 'string') : [];
      return { ops, rationale: rationale || 'Rencana dari AI', warnings, provider: { connection_id: r.connection.connection_id, provider: r.connection.provider, model: r.connection.model }, cost_usd: r.cost_usd };
    },
  };
}
