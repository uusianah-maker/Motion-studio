import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { audit } from './audit.js';
import { setLeaseStatus } from './deps.js';
import { StorageError, isStorageError } from './errors.js';
import { guard } from './guard.js';
import { checkTools, findFont, runFfmpeg, sourceMetadataMarkers, verifyCleanOutput } from './ffmpeg.js';
import type { Actor } from './permissions.js';
import { MEDIA_AREAS } from './permissions.js';
import { type PreflightResult, finishRender, startRender, verifyRenderSnapshot } from './preflight.js';
import { effectiveStyle, layoutText } from './textStyle.js';
import { type MediaProbe, probeFile } from './probe.js';
import { type CanvasRatio, type Clip, type Timeline, type Track } from './project.js';
import { loadRegistry } from './registry.js';
import { type Workspace, projectRel, readProject } from './workspace.js';

// ------------------------------------------------------------------ settings & geometry

export const RENDER_FPS = [24, 25, 30, 60] as const;
export type RenderFps = (typeof RENDER_FPS)[number];

export interface RenderSettings {
  /** Short side of the output in pixels (1080 = "1080p" for every ratio). */
  short_side: number;
  fps: RenderFps;
  /** x264 quality (lower = better/bigger). */
  crf: number;
  preset: 'ultrafast' | 'superfast' | 'veryfast' | 'faster' | 'fast' | 'medium';
}

const PRESETS: readonly RenderSettings['preset'][] = ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium'];
export const DEFAULT_RENDER: RenderSettings = { short_side: 1080, fps: 30, crf: 20, preset: 'veryfast' };
const AUDIO_RATE = 48_000;

const RATIO_PARTS: Record<CanvasRatio, [number, number]> = { '9:16': [9, 16], '3:4': [3, 4], '1:1': [1, 1], '16:9': [16, 9] };

/** Output size for a canvas ratio; both sides even (H.264 4:2:0 needs it). */
export function canvasSize(ratio: CanvasRatio, shortSide: number): { width: number; height: number } {
  const [a, b] = RATIO_PARTS[ratio];
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  const short = even(shortSide);
  return a <= b ? { width: short, height: even((short * b) / a) } : { width: even((short * a) / b), height: short };
}

/** Same safe area as the preview (apps/web lib `safeInsets`): top, right, bottom, left in %. */
export const safeInsets = (ratio: CanvasRatio): [number, number, number, number] => (ratio === '9:16' ? [12, 14, 20, 6] : [5, 5, 5, 5]);

const clipsOf = (t: Timeline, kind: string): Clip[] => t.tracks.filter((x) => x.kind === kind).flatMap((x) => x.clips);
const clipAt = (clips: readonly Clip[], ms: number): Clip | null => clips.find((c) => ms >= c.start_ms && ms < c.end_ms) ?? null;

export const timelineEnd = (t: Timeline): number => Math.max(0, ...t.tracks.flatMap((x) => x.clips.map((c) => c.end_ms)));

export interface VisualSegment {
  /** Frame range [from, to) on the output frame grid. */
  from_frame: number;
  to_frame: number;
  /** The clip on screen (b-roll over video, like the preview); null = black + silence. */
  clip: Clip | null;
}

/**
 * Split the timeline into runs where the same visual clip is on screen — exactly the preview's
 * rule: b-roll at time t, else the video track at t. The visual clip's own sound plays with it
 * (the preview plays the `<video>` element unmuted). Boundaries snap to the frame grid so audio
 * and video of every run have identical length and never drift.
 */
export function visualSegments(t: Timeline, fps: number): VisualSegment[] {
  const frame = (ms: number) => Math.round((ms * fps) / 1000);
  const total = frame(timelineEnd(t));
  const broll = clipsOf(t, 'broll');
  const video = clipsOf(t, 'video');
  const cuts = new Set<number>([0, total]);
  for (const c of [...broll, ...video]) for (const ms of [c.start_ms, c.end_ms]) cuts.add(Math.min(total, frame(ms)));
  const points = [...cuts].sort((a, b) => a - b);
  const out: VisualSegment[] = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const [a, b] = [points[i]!, points[i + 1]!];
    if (b <= a) continue;
    const mid = ((a + 0.5) * 1000) / fps; // middle of the run's first frame
    const clip = clipAt(broll, mid) ?? clipAt(video, mid);
    const prev = out[out.length - 1];
    if (prev && prev.clip === clip && prev.to_frame === a) prev.to_frame = b;
    else out.push({ from_frame: a, to_frame: b, clip });
  }
  return out;
}

// ------------------------------------------------------------------ text layout

export { wrapText } from './textStyle.js';

// ------------------------------------------------------------------ FFmpeg plan

export interface PlanInput {
  /** Local path FFmpeg reads (a verified copy for remote backends). */
  path: string;
  probe: MediaProbe;
}

export interface RenderPlan {
  /** Arguments after the binary; the filter graph is read from `graph.txt` in the job folder. */
  args: string[];
  graph: string;
  /** Files to write into the job folder before running (text overlays). */
  files: { name: string; content: string }[];
  width: number;
  height: number;
  total_ms: number;
  total_frames: number;
}

const s6 = (n: number) => (Math.round(n * 1e6) / 1e6).toString();
const AFMT = `aformat=sample_fmts=fltp:sample_rates=${AUDIO_RATE}:channel_layouts=stereo`;

/** Output flags that strip every piece of metadata FFmpeg would copy or add (owner rule, W08). */
export const STRIP_METADATA_ARGS: readonly string[] = [
  '-map_metadata', '-1',
  '-map_chapters', '-1',
  '-fflags', '+bitexact',
  '-flags:v', '+bitexact',
  '-flags:a', '+bitexact',
  '-metadata:s:v', 'handler_name=',
  '-metadata:s:a', 'handler_name=',
  '-metadata:s:v', 'encoder=',
  '-metadata:s:a', 'encoder=',
  // x264 writes its version + full settings into an SEI NAL unit: drop SEI units.
  '-bsf:v', 'filter_units=remove_types=6',
];

/**
 * Timeline → one FFmpeg run. Visual runs (see `visualSegments`) are concatenated with their own
 * audio; audio-track clips are mixed on top at their timeline position; text/subtitle clips are
 * burned in with drawtext (text from files: no escaping, no `%` expansion). Pure function.
 */
/** Upper bound on visual segments per render (Checkpoint E E4). */
export const MAX_RENDER_SEGMENTS = 200;

export function buildRenderPlan(t: Timeline, inputs: ReadonlyMap<string, PlanInput>, settings: RenderSettings, font: string | null, regularFont: string | null = font): RenderPlan {
  const fps = settings.fps;
  const ratio = t.canvas?.ratio ?? '9:16';
  const { width: W, height: H } = canvasSize(ratio, settings.short_side);
  const segments = visualSegments(t, fps);
  const total_frames = segments.length ? segments[segments.length - 1]!.to_frame : 0;
  if (total_frames < 1) throw new StorageError('PRECONDITION', 'Linimasa kosong, tidak ada yang dirender');
  // Checkpoint E E4: one FFmpeg input per visual segment; Windows caps a command line at 32,767
  // characters, so a very fragmented timeline is refused up front with a clear reason.
  if (segments.length > MAX_RENDER_SEGMENTS) {
    throw new StorageError('PRECONDITION', `Linimasa terlalu banyak potongan (${segments.length} segmen visual); maksimal ${MAX_RENDER_SEGMENTS} per render. Gabungkan sebagian klip dulu.`, { segments: segments.length });
  }
  const total_ms = Math.round((total_frames * 1000) / fps);
  const samplesPerFrame = AUDIO_RATE / fps;

  const args: string[] = ['-hide_banner', '-nostdin', '-v', 'error', '-progress', 'pipe:1', '-nostats', '-n'];
  const graph: string[] = [];
  let inputCount = 0;
  const input = (src: PlanInput, fromMs: number, durMs: number) => {
    args.push('-ss', s6(Math.max(0, fromMs) / 1000), '-t', s6(durMs / 1000), '-i', src.path);
    return inputCount++;
  };
  const media = (c: Clip | null) => {
    if (!c?.media) return null;
    const src = inputs.get(c.media.version_id);
    if (!src) throw new StorageError('PRECONDITION', 'Media klip tidak tersedia untuk render', { clip_id: c.clip_id });
    return src;
  };

  // X04: sound level per clip (0..1) and muted tracks.
  const trackOf = new Map<string, Track>();
  for (const tr of t.tracks) for (const c of tr.clips) trackOf.set(c.clip_id, tr);
  const gainOf = (c: Clip) => (trackOf.get(c.clip_id)?.muted ? 0 : (c.volume ?? 1));
  const gainFilter = (g: number) => (g === 1 ? '' : `,volume=${g.toFixed(2)}`);

  segments.forEach((seg, k) => {
    const frames = seg.to_frame - seg.from_frame;
    const durMs = (frames * 1000) / fps;
    const samples = frames * samplesPerFrame;
    const src = media(seg.clip);
    const hasV = !!src?.probe.video_codec;
    const hasA = !!src?.probe.audio_codec;
    let idx = -1;
    if (src && seg.clip && (hasV || hasA)) {
      const startMs = (seg.from_frame * 1000) / fps;
      idx = input(src, (seg.clip.in_ms ?? 0) + (startMs - seg.clip.start_ms), durMs);
    }
    graph.push(
      hasV
        ? `[${idx}:v:0]setpts=PTS-STARTPTS,fps=${fps},scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=yuv420p,tpad=stop_mode=clone:stop=${frames},trim=end_frame=${frames},setpts=PTS-STARTPTS[v${k}]`
        : `color=c=black:s=${W}x${H}:r=${fps}:d=${s6(durMs / 1000)},format=yuv420p,setsar=1,trim=end_frame=${frames}[v${k}]`,
    );
    graph.push(
      hasA
        ? `[${idx}:a:0]asetpts=PTS-STARTPTS,${AFMT}${gainFilter(gainOf(seg.clip!))},apad,atrim=end_sample=${samples},asetpts=PTS-STARTPTS[a${k}]`
        : `anullsrc=r=${AUDIO_RATE}:cl=stereo,${AFMT},atrim=end_sample=${samples}[a${k}]`,
    );
  });
  graph.push(`${segments.map((_, k) => `[v${k}][a${k}]`).join('')}concat=n=${segments.length}:v=1:a=1[vcat][acat]`);

  // Audio track: mixed over the visual sound at its timeline position, like the preview.
  const mixes: string[] = [];
  for (const c of clipsOf(t, 'audio')) {
    const src = media(c);
    const startFrame = Math.round((c.start_ms * fps) / 1000);
    const endFrame = Math.min(total_frames, Math.round((c.end_ms * fps) / 1000));
    if (!src?.probe.audio_codec || endFrame <= startFrame || gainOf(c) === 0) continue;
    const durMs = ((endFrame - startFrame) * 1000) / fps;
    const idx = input(src, c.in_ms ?? 0, durMs);
    const delay = Math.round((startFrame * 1000) / fps);
    graph.push(`[${idx}:a:0]asetpts=PTS-STARTPTS,${AFMT}${gainFilter(gainOf(c))},apad,atrim=end_sample=${(endFrame - startFrame) * samplesPerFrame},adelay=delays=${delay}:all=1[m${mixes.length}]`);
    mixes.push(`[m${mixes.length}]`);
  }
  graph.push(mixes.length ? `[acat]${mixes.join('')}amix=inputs=${mixes.length + 1}:duration=first:normalize=0:dropout_transition=0,${AFMT}[aout]` : `[acat]anull[aout]`);

  // Text + subtitles (X01): each clip's own style — the same layout function as the preview
  // (textStyle.ts), so line breaks, size and placement match what the editor shows.
  const files: { name: string; content: string }[] = [];
  const short = Math.min(W, H);
  const draws: string[] = [];
  const hex = (c: string) => `0x${c.slice(1)}`;
  for (const kind of ['text', 'subtitle'] as const) {
    for (const c of clipsOf(t, kind)) {
      if (!c.text?.trim() || c.start_ms >= total_ms) continue;
      if (!font) throw new StorageError('RENDER_UNAVAILABLE', 'Font untuk teks tidak ditemukan (set MOTION_FONT)');
      const s = effectiveStyle(kind, c.style);
      const fs = Math.max(8, Math.round((short * s.size) / 100));
      const name = `t${files.length}.txt`;
      files.push({ name, content: layoutText(c.text, s, ratio) });
      const look = [
        ...(s.bg ? [`box=1:boxcolor=${hex(s.bg)}@${s.bg_opacity}:boxborderw=${Math.round(fs * 0.4)}`] : []),
        ...(s.outline ? [`borderw=${Math.max(2, Math.round(fs * 0.06))}:bordercolor=black@0.8:shadowcolor=black@0.6:shadowy=${Math.round(fs * 0.08)}`] : []),
      ].join(':');
      const face = s.bold || !regularFont ? font : regularFont;
      const fontFile = `${s.bold || !regularFont ? 'fontb' : 'fontr'}${path.extname(face).toLowerCase()}`;
      draws.push(
        `drawtext=fontfile=${fontFile}:textfile=${name}:expansion=none:fontsize=${fs}:fontcolor=${hex(s.color)}:line_spacing=${Math.round(fs * 0.15)}:text_align=${s.align === 'left' ? 'L' : s.align === 'right' ? 'R' : 'C'}:x=${Math.round(s.x * W)}-text_w/2:y=${Math.round(s.y * H)}-text_h/2${look ? `:${look}` : ''}:enable='gte(t,${s6(c.start_ms / 1000)})*lt(t,${s6(c.end_ms / 1000)})'`,
      );
    }
  }
  graph.push(draws.length ? `[vcat]${draws.join(',')}[vout]` : `[vcat]null[vout]`);

  args.push(
    '-/filter_complex', 'graph.txt',
    '-map', '[vout]', '-map', '[aout]',
    '-c:v', 'libx264', '-preset', settings.preset, '-crf', String(settings.crf), '-pix_fmt', 'yuv420p', '-r', String(fps),
    '-c:a', 'aac', '-b:a', '192k', '-ar', String(AUDIO_RATE), '-ac', '2',
    ...STRIP_METADATA_ARGS,
    '-movflags', '+faststart',
    '-f', 'mp4', 'out.mp4',
  );
  return { args, graph: graph.join(';\n'), files, width: W, height: H, total_ms, total_frames };
}

/** Rough output size (bytes) for the disk check: generous bits-per-pixel + audio, ×2 for the staging copy. */
export function estimateRenderBytes(totalMs: number, size: { width: number; height: number }, fps: number): number {
  const secs = totalMs / 1000;
  return Math.ceil(2 * secs * ((size.width * size.height * fps * 0.15 + 192_000) / 8)) + 4 * 1024 * 1024;
}

// ------------------------------------------------------------------ job

export type RenderPhase = 'preflight' | 'preparing' | 'encoding' | 'verifying' | 'saving';

export interface RenderOutput {
  rel: string;
  name: string;
  size: number;
  hash: string;
  duration_ms: number;
  width: number;
  height: number;
  /** Always true for a completed render (otherwise it failed). */
  metadata_clean: true;
  kept_tags: string[];
}

export type RenderOutcome = { status: 'blocked'; preflight: PreflightResult } | { status: 'completed'; preflight: PreflightResult; output: RenderOutput };

export interface RenderHooks {
  onPhase?: (p: RenderPhase) => void;
  /** 0..1 while encoding. */
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
  /** Job folder parent (default: OS temp). Outside the workspace; cleaned after every run. */
  tmpRoot?: string;
  settings?: Partial<RenderSettings>;
  /** Pid stored on the lease so a crashed worker's lease is released at next start. */
  worker_pid?: number;
  /** Test seam: runs on the encoded temp file right before verification. */
  afterEncode?: (file: string) => Promise<void>;
}

export const RENDER_TMP_PREFIX = 'motion-render-';

/** Nested `withLocalFile` for several blobs (Drive in W10: verified cache copies). */
async function withLocalFiles<T>(ws: Workspace, rels: string[], fn: (abs: string[]) => Promise<T>, acc: string[] = []): Promise<T> {
  if (acc.length === rels.length) return fn(acc);
  return ws.blobs.withLocalFile(rels[acc.length]!, (abs) => withLocalFiles(ws, rels, fn, [...acc, abs]));
}

function settingsFrom(partial: Partial<RenderSettings> | undefined): RenderSettings {
  const s = { ...DEFAULT_RENDER, ...partial };
  if (!Number.isInteger(s.short_side) || s.short_side < 144 || s.short_side > 2160) throw new StorageError('PRECONDITION', 'Resolusi render tidak valid (144–2160)');
  if (!RENDER_FPS.includes(s.fps)) throw new StorageError('PRECONDITION', 'FPS render tidak valid');
  if (!Number.isInteger(s.crf) || s.crf < 0 || s.crf > 51) throw new StorageError('PRECONDITION', 'CRF tidak valid');
  if (!PRESETS.includes(s.preset)) throw new StorageError('PRECONDITION', 'Preset render tidak valid');
  return s;
}

/**
 * Render a project to MP4 (W08):
 * tools check → preflight + lease (T15, one lock) → re-verify leased bytes → FFmpeg into a private
 * temp folder → **metadata verification (owner rule: failed = render failed)** → upload/commit into
 * 05_OUTPUT under the reserved versioned name (never overwrites) → audit → release lease.
 * Originals are only ever read.
 */
export async function renderProject(ws: Workspace, input: { project_id: string; output_name: string; actor: Actor }, hooks: RenderHooks = {}): Promise<RenderOutcome> {
  await guard(ws, input.actor, 'render_preflight', { project_id: input.project_id }); // never AI (T15 matrix)
  const settings = settingsFrom(hooks.settings);
  hooks.onPhase?.('preflight');
  const tools = await checkTools();
  if (!tools.ok) {
    await audit(ws, { op: 'render.blocked', actor: input.actor, outcome: 'blocked', project_id: input.project_id, reason: tools.problems });
    throw new StorageError('RENDER_UNAVAILABLE', `Alat render belum siap: ${tools.problems.join(', ')}`, { problems: tools.problems });
  }
  const before = await readProject(ws, input.project_id);
  const hasText = [...clipsOf(before.timeline, 'text'), ...clipsOf(before.timeline, 'subtitle')].some((c) => c.text?.trim());
  const font = hasText ? findFont() : null;
  const regularFont = hasText ? findFont('regular') : null;
  if (hasText && !font) throw new StorageError('RENDER_UNAVAILABLE', 'Font untuk teks tidak ditemukan (set MOTION_FONT)');
  const size = canvasSize(before.timeline.canvas?.ratio ?? '9:16', settings.short_side);

  const { preflight, lease } = await startRender(ws, {
    project_id: input.project_id,
    output_name: input.output_name,
    estimated_bytes: estimateRenderBytes(timelineEnd(before.timeline), size, settings.fps),
    actor: input.actor,
    ...(hooks.worker_pid !== undefined ? { worker_pid: hooks.worker_pid } : {}),
  });
  if (!lease) return { status: 'blocked', preflight };

  let outcome: 'completed' | 'failed' | 'cancelled' = 'failed';
  let tmp: string | null = null;
  try {
    await setLeaseStatus(ws, { lease_id: lease.lease_id, status: 'running', actor: input.actor });
    hooks.onPhase?.('preparing');
    // The timeline rendered is exactly the revision preflight checked.
    const project = await readProject(ws, input.project_id);
    if (project.revision !== preflight.project_revision) throw new StorageError('CONFLICT', 'Proyek berubah saat render dimulai; ulangi render');
    const check = await verifyRenderSnapshot(ws, lease.lease_id);
    if (!check.ok) throw new StorageError('INTEGRITY', 'Media berubah setelah preflight; render dibatalkan', { problems: check.problems });

    const reg = await loadRegistry(ws);
    const versions = lease.media.map((m) => reg.versions[m.version_id]!);
    const rels = await Promise.all(versions.map((v) => ws.blobs.resolve(v.rel_path, MEDIA_AREAS)));
    tmp = await fsp.mkdtemp(path.join(hooks.tmpRoot ?? os.tmpdir(), RENDER_TMP_PREFIX));
    const jobDir = tmp;

    const result = await withLocalFiles(ws, rels, async (abs) => {
      const inputs = new Map<string, PlanInput>();
      const markers = new Set<string>();
      for (let i = 0; i < versions.length; i++) {
        const v = versions[i]!;
        const probe = v.probe ?? (await probeFile(abs[i]!));
        if (!probe) throw new StorageError('PRECONDITION', `Media "${v.original_name}" tidak bisa dibaca sebagai video/audio`, { version_id: v.version_id });
        inputs.set(v.version_id, { path: abs[i]!, probe });
        for (const m of await sourceMetadataMarkers(abs[i]!)) markers.add(m);
      }
      const plan = buildRenderPlan(project.timeline, inputs, settings, font, regularFont);
      await fsp.writeFile(path.join(jobDir, 'graph.txt'), plan.graph, 'utf8');
      for (const f of plan.files) await fsp.writeFile(path.join(jobDir, f.name), f.content, 'utf8');
      if (font) await fsp.copyFile(font, path.join(jobDir, `fontb${path.extname(font).toLowerCase()}`));
      if (regularFont) await fsp.copyFile(regularFont, path.join(jobDir, `fontr${path.extname(regularFont).toLowerCase()}`));

      hooks.onPhase?.('encoding');
      hooks.onProgress?.(0);
      await runFfmpeg(plan.args, {
        cwd: jobDir,
        ...(hooks.signal ? { signal: hooks.signal } : {}),
        onTime: (ms) => hooks.onProgress?.(Math.min(0.999, Math.max(0, ms / plan.total_ms))),
      });
      return { plan, markers: [...markers] };
    });

    hooks.onPhase?.('verifying');
    if (hooks.signal?.aborted) throw new StorageError('CANCELLED', 'Render dibatalkan');
    const out = path.join(jobDir, 'out.mp4');
    await hooks.afterEncode?.(out);
    const clean = await verifyCleanOutput(out, { width: result.plan.width, height: result.plan.height, duration_ms: result.plan.total_ms, source_markers: result.markers });
    if (!clean.ok) {
      await audit(ws, { op: 'render.verify', actor: input.actor, outcome: 'failed', project_id: project.project_id, output_rel: preflight.output_rel, problems: clean.problems });
      throw new StorageError('RENDER_FAILED', 'Hasil render tidak lolos verifikasi metadata; output tidak disimpan', { stage: 'verify', problems: clean.problems });
    }
    await audit(ws, { op: 'render.verify', actor: input.actor, outcome: 'ok', project_id: project.project_id, output_rel: preflight.output_rel, kept_tags: clean.kept_tags, hash: clean.hash });

    hooks.onPhase?.('saving');
    if (hooks.signal?.aborted) throw new StorageError('CANCELLED', 'Render dibatalkan');
    const staged = await ws.blobs.stage(projectRel(project.project_id, '05_OUTPUT'), out);
    if (staged.hash !== clean.hash) {
      await ws.blobs.discard(staged);
      throw new StorageError('INTEGRITY', 'Byte output berubah antara verifikasi dan penyimpanan', { stage: 'save' });
    }
    // Checkpoint E E5: a cancel that arrives while staging still wins — nothing is saved.
    if (hooks.signal?.aborted) {
      await ws.blobs.discard(staged);
      throw new StorageError('CANCELLED', 'Render dibatalkan');
    }
    let rel: string;
    try {
      rel = await ws.blobs.commit(staged, preflight.output_rel);
    } catch (e) {
      await ws.blobs.discard(staged);
      throw e;
    }
    const output: RenderOutput = {
      rel,
      name: path.posix.basename(rel),
      size: clean.size,
      hash: clean.hash,
      duration_ms: clean.duration_ms ?? result.plan.total_ms,
      width: result.plan.width,
      height: result.plan.height,
      metadata_clean: true,
      kept_tags: clean.kept_tags,
    };
    await audit(ws, { op: 'render.complete', actor: input.actor, outcome: 'ok', project_id: project.project_id, revision: project.revision, output, settings, lease_id: lease.lease_id });
    outcome = 'completed';
    return { status: 'completed', preflight, output };
  } catch (e) {
    if (isStorageError(e, 'CANCELLED')) outcome = 'cancelled';
    await audit(ws, {
      op: 'render.failed',
      actor: input.actor,
      outcome: 'failed',
      project_id: input.project_id,
      output_rel: preflight.output_rel,
      result: outcome,
      code: isStorageError(e) ? e.code : 'INTERNAL',
      message: e instanceof Error ? e.message : String(e),
      details: isStorageError(e) ? e.details : undefined,
    }).catch(() => undefined);
    throw e;
  } finally {
    if (tmp) await fsp.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    // Checkpoint E E11: retry the lease release (a transient lock/EPERM must not pin media).
    for (let i = 0; i < 4; i++) {
      try {
        await finishRender(ws, { lease_id: lease.lease_id, outcome, actor: input.actor });
        break;
      } catch (e) {
        if (isStorageError(e, 'NOT_FOUND')) break;
        await new Promise((r) => setTimeout(r, 100 * (i + 1)));
      }
    }
  }
}

/** Finished renders of a project (newest first). */
export async function listOutputs(ws: Workspace, projectId: string): Promise<{ name: string; rel: string; size: number; mtime_ms: number }[]> {
  await readProject(ws, projectId);
  const files = await ws.blobs.listFiles(projectRel(projectId, '05_OUTPUT'), 1);
  return files
    .filter((f) => !f.name.startsWith('.') && path.posix.dirname(f.rel) === projectRel(projectId, '05_OUTPUT'))
    .map((f) => ({ name: f.name, rel: f.rel, size: f.size, mtime_ms: f.mtimeMs }))
    .sort((a, b) => b.mtime_ms - a.mtime_ms);
}
