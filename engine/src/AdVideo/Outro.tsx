import {
  AbsoluteFill,
  Img,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { clamp, theme } from "../theme";
import { useBrand, useFonts } from "./brand";
import { BgMesh } from "./Finish";
import { resolveSrc } from "./schema";

const OUTRO_REVEAL_FRAMES = 10;

export const Outro: React.FC<{
  logoSrc: string;
  brandName?: string;
  handle?: string;
  tagline: string;
}> = ({ logoSrc, brandName, handle, tagline }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const brand = useBrand();
  const fonts = useFonts();

  // Masuk: lingkaran membuka dari tengah.
  const reveal = interpolate(frame, [0, OUTRO_REVEAL_FRAMES], [0, 150], {
    ...clamp,
    easing: theme.ease.out,
  });
  const logoIn = spring({ frame: frame - 6, fps, config: theme.spring.bouncy });
  const handleIn = spring({ frame: frame - 12, fps, config: theme.spring.smooth });
  const taglineIn = spring({ frame: frame - 18, fps, config: theme.spring.smooth });
  const breathe = 1 + Math.sin(frame / 22) * 0.015;
  // Keluar lebih cepat dari masuk: fade ke hitam di 8 frame terakhir.
  const exit = interpolate(frame, [durationInFrames - 8, durationInFrames], [0, 1], {
    ...clamp,
    easing: theme.ease.in,
  });
  const rise = (p: number, px: number) => `translateY(${interpolate(p, [0, 1], [px, 0])}px)`;

  return (
    <AbsoluteFill style={{ clipPath: `circle(${reveal}% at 50% 50%)` }}>
      <BgMesh />
      <AbsoluteFill
        style={{
          alignItems: "center",
          justifyContent: "center",
          flexDirection: "column",
          gap: 40,
          opacity: 1 - exit,
          padding: "0 80px",
        }}
      >
        {logoSrc ? (
          <Img
            src={resolveSrc(logoSrc, staticFile)}
            style={{
              width: 520,
              height: 520,
              objectFit: "contain",
              opacity: logoIn,
              transform: `${rise(logoIn, 50)} scale(${interpolate(logoIn, [0, 1], [0.7, 1]) * breathe})`,
            }}
          />
        ) : (
          // Logo belum ada: nama brand sebagai teks.
          <div
            style={{
              fontFamily: fonts.title.family,
              fontWeight: fonts.title.weight,
              fontSize: 120,
              lineHeight: 1.0,
              letterSpacing: "-0.04em",
              textAlign: "center",
              color: brand.captionColor,
              opacity: logoIn,
              transform: `${rise(logoIn, 50)} scale(${interpolate(logoIn, [0, 1], [0.8, 1]) * breathe})`,
            }}
          >
            {brandName}
          </div>
        )}
        {handle ? (
          <div
            style={{
              fontFamily: fonts.caption.family,
              fontWeight: fonts.caption.weight,
              fontSize: 48,
              color: brand.captionColor,
              opacity: handleIn * 0.85,
              transform: rise(handleIn, 20),
            }}
          >
            {handle}
          </div>
        ) : null}
        {tagline ? (
          <div
            style={{
              marginTop: 24,
              padding: "22px 44px",
              borderRadius: 999,
              background: brand.accentColor,
              fontFamily: fonts.title.family,
              fontWeight: fonts.title.weight,
              fontSize: 54,
              letterSpacing: "-0.02em",
              color: brand.outlineColor,
              textAlign: "center",
              boxShadow: `0 0 60px ${brand.accentColor}66`,
              opacity: taglineIn,
              transform: `${rise(taglineIn, 24)} scale(${interpolate(taglineIn, [0, 1], [0.9, 1])})`,
            }}
          >
            {tagline}
          </div>
        ) : null}
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
