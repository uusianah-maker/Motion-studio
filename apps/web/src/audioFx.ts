import { type PreviewAudioFx, previewAudioFx } from '../../../packages/core/dist/storage/clipAudio.js';

/**
 * R23b: the preview hears a clip's EQ and "Perjelas suara" through Web Audio — the same bands,
 * highpass and compressor numbers as the render's FFmpeg filters (core clipAudio). A media element
 * is routed through a graph only once it first needs one (it can never be "un-routed"), and from
 * then on a clip without effects simply gets neutral settings.
 */
interface Graph {
  hp: BiquadFilterNode;
  bands: BiquadFilterNode[];
  comp: DynamicsCompressorNode;
  makeup: GainNode;
}
const MAX_BANDS = 5;
const graphs = new WeakMap<HTMLMediaElement, Graph>();
let ctx: AudioContext | null = null;

const hasFx = (fx: PreviewAudioFx) => fx.highpass !== null || fx.bands.length > 0 || fx.compressor !== null;

export function applyAudioFx(el: HTMLMediaElement | null, clip: { eq?: { bass: number; mid: number; treble: number }; voice?: boolean } | null): void {
  if (!el) return;
  const fx = previewAudioFx(clip ?? {});
  let g = graphs.get(el);
  if (!g) {
    if (!hasFx(fx) || typeof AudioContext === 'undefined') {
      delete el.dataset.audiofx;
      return;
    }
    try {
      ctx ??= new AudioContext();
      const src = ctx.createMediaElementSource(el);
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      const bands = Array.from({ length: MAX_BANDS }, () => ctx!.createBiquadFilter());
      const comp = ctx.createDynamicsCompressor();
      const makeup = ctx.createGain();
      [src, hp, ...bands, comp, makeup].reduce((a: AudioNode, b) => (a.connect(b), b));
      makeup.connect(ctx.destination);
      g = { hp, bands, comp, makeup };
      graphs.set(el, g);
    } catch {
      return; // no Web Audio: the preview plays the plain sound (the render still has the effects)
    }
  }
  g.hp.frequency.value = fx.highpass ?? 10;
  g.bands.forEach((b, i) => {
    const band = fx.bands[i];
    b.type = band?.type ?? 'peaking';
    b.frequency.value = band?.hz ?? 1000;
    b.gain.value = band?.db ?? 0;
    b.Q.value = band?.q ?? 1;
  });
  const c = fx.compressor;
  g.comp.threshold.value = c ? c.threshold : 0;
  g.comp.ratio.value = c ? c.ratio : 1;
  g.comp.attack.value = c ? c.attack : 0.003;
  g.comp.release.value = c ? c.release : 0.25;
  g.makeup.gain.value = c ? 10 ** (c.makeup / 20) : 1;
  el.dataset.audiofx = hasFx(fx) ? [fx.highpass ? `hp${fx.highpass}` : '', ...fx.bands.map((b) => `${b.type}${b.hz}:${b.db}`), c ? 'comp' : ''].filter(Boolean).join(' ') : '';
}

/** Browsers start an AudioContext suspended until a user gesture (the play button). */
export function resumeAudioFx(): void {
  if (ctx && ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
}
