// Efek 17 glass type: judul hook di atas panel kaca buram. Teks HANYA dari ucapan.
import { interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { clamp, theme } from "../theme";
import { useBrand, useFonts, withAlpha } from "./brand";

const EXIT_FRAMES = 8;
const TOP = 0.3; // posisi atas panel, di bawah 10% atas (safe area) dan di bawah wajah

export const GlassTitle: React.FC<{ text: string; top?: number; minHeight?: number }> = ({
  text,
  top = TOP,
  minHeight,
}) => {
  const frame = useCurrentFrame();
  const { fps, width, height, durationInFrames } = useVideoConfig();
  const brand = useBrand();
  const font = useFonts().title;

  const card = spring({ frame, fps, config: theme.spring.smooth });
  const exit = interpolate(frame, [durationInFrames - EXIT_FRAMES, durationInFrames], [0, 1], {
    ...clamp,
    easing: theme.ease.in,
  });
  const words = text.split(" ");

  return (
    <div
      style={{
        position: "absolute",
        left: 70,
        right: 70 + width * brand.safeRight,
        top: height * top,
        minHeight: minHeight ? height * minHeight : undefined,
        alignContent: "center",
        padding: "52px 40px",
        borderRadius: 36,
        background: withAlpha(brand.outroBg, 0.38),
        backdropFilter: "blur(22px) saturate(1.2)",
        border: `2px solid ${withAlpha(brand.captionColor, 0.35)}`,
        boxShadow: "0 30px 60px -20px rgba(0,0,0,0.45)",
        opacity: card * (1 - exit),
        transform: `translateY(${interpolate(card, [0, 1], [40, 0]) - exit * 40}px) scale(${interpolate(
          card,
          [0, 1],
          [0.92, 1],
        )})`,
        display: "flex",
        flexWrap: "wrap",
        justifyContent: "center",
        columnGap: 18,
        rowGap: 2,
      }}
    >
      {words.map((w, i) => {
        const p = spring({ frame: frame - 4 - i * 3, fps, config: theme.spring.snappy });
        return (
          <span
            key={i}
            style={{
              display: "inline-block",
              fontFamily: font.family,
              fontWeight: font.weight,
              fontSize: 76,
              lineHeight: 1.08,
              letterSpacing: "-0.03em",
              color: brand.captionColor,
              textShadow: "0 4px 18px rgba(0,0,0,0.35)",
              opacity: p,
              transform: `translateY(${interpolate(p, [0, 1], [26, 0])}px)`,
            }}
          >
            {w}
          </span>
        );
      })}
    </div>
  );
};
