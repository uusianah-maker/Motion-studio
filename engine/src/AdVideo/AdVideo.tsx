import {
  AbsoluteFill,
  Audio,
  CalculateMetadataFunction,
  interpolate,
  Sequence,
  staticFile,
  useVideoConfig,
} from "remotion";
import { clamp, theme } from "../theme";
import { BrandProvider, defaultStyle } from "./brand";
import { Footage, footageFrames } from "./Footage";
import { Disclaimer, Grade, Grain, Vignette } from "./Finish";
import { GlassTitle } from "./GlassTitle";
import { Outro } from "./Outro";
import { resolveSrc, type AdVideoProps } from "./schema";
import { WordCaptions } from "./WordCaptions";

export const FPS = 30;
const MUSIC_VOLUME = 0.08; // jauh di bawah suara

// Durasi = total potongan + outro. Ekor video TIDAK dipotong walau lewat batas
// (CTA bisa hilang); pipeline yang melaporkan kalau kelebihan.
export const calculateAdMetadata: CalculateMetadataFunction<AdVideoProps> = ({ props }) => ({
  durationInFrames: footageFrames(props.segments) + Math.round(props.outroSeconds * FPS),
});

export const AdVideo: React.FC<AdVideoProps> = (props) => {
  const { fps, durationInFrames } = useVideoConfig();
  const videoFrames = footageFrames(props.segments);
  const outroFrames = Math.round(props.outroSeconds * fps);
  const msToFrame = (ms: number) => Math.round((ms / 1000) * fps);

  return (
    <BrandProvider value={props.style ?? defaultStyle}>
      <AbsoluteFill style={{ backgroundColor: "black" }}>
        {/* Lapisan 2: footage (+ efek 05 digital zoom & 09 zoom-through) */}
        <Sequence name="Footage" durationInFrames={videoFrames}>
          <Footage
            videoSrc={props.videoSrc}
            segments={props.segments}
            framing={props.framing}
            zoomThroughs={props.zoomThroughs}
          />
        </Sequence>
        {/* Grade di atas footage, di bawah teks supaya teks tetap tajam */}
        <Sequence name="Grade" durationInFrames={videoFrames} layout="none">
          <Grade />
        </Sequence>
        {/* Lapisan 3: judul hook (efek 17 glass type) + caption */}
        {props.hook ? (
          <Sequence
            name={`Hook: ${props.hook.text}`}
            from={msToFrame(props.hook.startMs)}
            durationInFrames={Math.max(1, msToFrame(props.hook.endMs - props.hook.startMs))}
            layout="none"
          >
            <GlassTitle text={props.hook.text} top={props.hook.top} minHeight={props.hook.height} />
          </Sequence>
        ) : null}
        <Sequence name="Caption" durationInFrames={videoFrames} layout="none">
          <WordCaptions
            captions={props.captions}
            keywords={props.keywords}
            maxWordsPerPage={props.maxWordsPerPage}
            hideBeforeMs={props.hook?.endMs}
          />
        </Sequence>
        {props.disclaimer ? (
          <Sequence name="Disclaimer" durationInFrames={videoFrames} layout="none">
            <Disclaimer text={props.disclaimer} />
          </Sequence>
        ) : null}
        {/* Outro baru mulai setelah potongan terakhir habis, supaya CTA tidak tertutup */}
        <Sequence name="Outro" from={videoFrames} durationInFrames={outroFrames}>
          <Outro
            logoSrc={props.logoSrc}
            brandName={props.brandName}
            handle={props.handle}
            tagline={props.outroTagline}
          />
        </Sequence>
        {/* Audio: SFX 2-3 frame sebelum visualnya, musik di bawah suara */}
        {(props.sfx ?? []).map((s, i) => (
          <Sequence key={i} name={`SFX ${s.src}`} from={msToFrame(s.atMs)} durationInFrames={fps} layout="none">
            <Audio src={staticFile(s.src)} volume={s.volume} />
          </Sequence>
        ))}
        {props.musicSrc ? (
          <Audio
            src={resolveSrc(props.musicSrc, staticFile)}
            loop
            volume={(f) =>
              MUSIC_VOLUME *
              Math.min(
                interpolate(f, [0, 15], [0, 1], { ...clamp, easing: theme.ease.out }),
                interpolate(f, [durationInFrames - 20, durationInFrames], [1, 0], { ...clamp, easing: theme.ease.in }),
              )
            }
          />
        ) : null}
        {/* Lapisan 5: grain + vignette selalu paling atas */}
        <Grain />
        <Vignette />
      </AbsoluteFill>
    </BrandProvider>
  );
};
