import {
  AbsoluteFill,
  interpolate,
  OffthreadVideo,
  Series,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { clamp, theme } from "../theme";
import { resolveSrc, type AdVideoProps, type Segment } from "./schema";

// Tanpa rencana framing: zoom bergantian per potongan menyamarkan jump cut.
const PUNCH_IN = 1.08;
const DRIFT = 0.018; // zoom pelan selama potongan, supaya gambar "bernapas"
const AUDIO_FADE_FRAMES = 1; // cegah bunyi "klik" di sambungan
const SMOOTH_FRAMES = 12; // durasi dorongan framing halus
// Zoom-through: shot lama didorong masuk + blur, shot baru keluar dari zoom.
const ZT_IN = 5;
const ZT_OUT = 9;
const ZT_SCALE = 1.35;
const ZT_BLUR = 12;

type Framing = NonNullable<AdVideoProps["framing"]>;

const Shot: React.FC<{ src: string; seg: Segment; index: number; legacyZoom: boolean }> = ({
  src,
  seg,
  index,
  legacyZoom,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const len = seg.endFrame - seg.startFrame;

  const base = legacyZoom ? (index % 2 === 0 ? 1 : PUNCH_IN) : 1;
  const drift = legacyZoom
    ? interpolate(frame, [0, len], [0, DRIFT], { ...clamp, easing: theme.ease.inOut })
    : 0;
  const hook =
    legacyZoom && index === 0
      ? interpolate(frame, [0, Math.round(fps * 0.5)], [0.1, 0], { ...clamp, easing: theme.ease.out })
      : 0;

  return (
    <AbsoluteFill style={{ overflow: "hidden" }}>
      <OffthreadVideo
        src={src}
        trimBefore={seg.startFrame}
        trimAfter={seg.endFrame}
        volume={(f) =>
          Math.min(
            interpolate(f, [0, AUDIO_FADE_FRAMES], [0, 1], { ...clamp, easing: theme.ease.out }),
            interpolate(f, [len - AUDIO_FADE_FRAMES, len], [1, 0], { ...clamp, easing: theme.ease.in }),
          )
        }
        style={{
          width: "100%",
          height: "100%",
          objectFit: "cover",
          transform: `scale(${base + drift + hook})`,
          transformOrigin: "50% 38%",
          filter: "saturate(1.06) contrast(1.05)",
        }}
      />
    </AbsoluteFill>
  );
};

/** Skala framing (efek 05 digital zoom) di frame tertentu. */
const framingScale = (framing: Framing, frame: number, fps: number) => {
  let scale = 1;
  for (let i = 0; i < framing.length; i++) {
    const k = framing[i];
    const at = (k.atMs / 1000) * fps;
    if (frame < at) break;
    const prev = i === 0 ? k.scale : framing[i - 1].scale;
    scale =
      k.mode === "cut"
        ? k.scale
        : interpolate(frame, [at, at + SMOOTH_FRAMES], [prev, k.scale], {
            ...clamp,
            easing: theme.ease.inOut,
          });
  }
  return scale;
};

/** Dorongan zoom-through (efek 09) di sekitar pergantian shot. */
const zoomThrough = (cuts: number[], frame: number, fps: number) => {
  for (const ms of cuts) {
    const at = Math.round((ms / 1000) * fps);
    if (frame >= at - ZT_IN && frame < at) {
      const p = interpolate(frame, [at - ZT_IN, at], [0, 1], { ...clamp, easing: theme.ease.in });
      return { scale: 1 + (ZT_SCALE - 1) * p, blur: ZT_BLUR * p };
    }
    if (frame >= at && frame < at + ZT_OUT) {
      const p = interpolate(frame, [at, at + ZT_OUT], [1, 0], { ...clamp, easing: theme.ease.out });
      return { scale: 1 + (ZT_SCALE - 1) * p, blur: ZT_BLUR * p };
    }
  }
  return { scale: 1, blur: 0 };
};

export const Footage: React.FC<{
  videoSrc: string;
  segments: Segment[];
  framing?: AdVideoProps["framing"];
  zoomThroughs?: number[];
}> = ({ videoSrc, segments, framing, zoomThroughs = [] }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const src = resolveSrc(videoSrc, staticFile);
  const planned = Boolean(framing && framing.length > 0);
  const scale = planned ? framingScale(framing!, frame, fps) : 1;
  const zt = zoomThrough(zoomThroughs, frame, fps);

  return (
    <AbsoluteFill
      style={{
        transform: `scale(${scale * zt.scale})`,
        transformOrigin: "50% 42%",
        filter: zt.blur > 0.1 ? `blur(${zt.blur}px)` : undefined,
      }}
    >
      <Series>
        {segments.map((seg, i) => (
          <Series.Sequence
            key={`${seg.startFrame}-${seg.endFrame}`}
            name={`Potongan ${i + 1} (${seg.startFrame}-${seg.endFrame})`}
            durationInFrames={seg.endFrame - seg.startFrame}
          >
            <Shot src={src} seg={seg} index={i} legacyZoom={!planned} />
          </Series.Sequence>
        ))}
      </Series>
    </AbsoluteFill>
  );
};

export const footageFrames = (segments: Segment[]) =>
  segments.reduce((sum, s) => sum + (s.endFrame - s.startFrame), 0);
