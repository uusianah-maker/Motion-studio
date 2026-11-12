// Lapisan akhir: grade -> grain -> vignette (selalu paling atas).
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { useBrand, useFonts, withAlpha } from "./brand";

export const BgMesh: React.FC = () => {
  const frame = useCurrentFrame();
  const brand = useBrand();
  const d1 = Math.sin(frame / 55) * 50;
  const d2 = Math.cos(frame / 70) * 40;
  return (
    <AbsoluteFill style={{ background: brand.outroBg }}>
      <div
        style={{
          position: "absolute", width: 1200, height: 1200, borderRadius: "50%",
          top: -450, left: -300 + d1, filter: "blur(50px)",
          background: `radial-gradient(circle, ${withAlpha(brand.accentColor, 0.16)}, transparent 62%)`,
        }}
      />
      <div
        style={{
          position: "absolute", width: 900, height: 900, borderRadius: "50%",
          bottom: -400, right: -250 - d2, filter: "blur(70px)",
          background: `radial-gradient(circle, ${withAlpha(brand.captionColor, 0.1)}, transparent 65%)`,
        }}
      />
    </AbsoluteFill>
  );
};

// Grade netral: gelapkan atas/bawah supaya caption & UI platform terbaca.
// Tidak diberi tint warna supaya warna kulit & produk tetap jujur.
export const Grade: React.FC = () => (
  <AbsoluteFill
    style={{
      pointerEvents: "none",
      background:
        "linear-gradient(180deg, rgba(0,0,0,0.28), transparent 22%, transparent 52%, rgba(0,0,0,0.38) 100%)",
    }}
  />
);

export const Grain: React.FC = () => {
  const frame = useCurrentFrame();
  const noise = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='220' height='220'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2'/%3E%3C/filter%3E%3Crect width='220' height='220' filter='url(%23n)' opacity='0.5'/%3E%3C/svg%3E")`;
  return (
    <AbsoluteFill
      style={{
        pointerEvents: "none",
        backgroundImage: noise,
        backgroundSize: "220px",
        backgroundPosition: `${(frame * 7) % 220}px ${(frame * 13) % 220}px`,
        opacity: 0.06,
        mixBlendMode: "overlay",
      }}
    />
  );
};

/** Teks kecil wajib dari brand kit (mis. disclaimer warna), tepat di bawah safe area atas.
 * Di atas, bukan di bawah: area bawah sering sudah berisi watermark/caption bawaan video. */
export const Disclaimer: React.FC<{ text: string }> = ({ text }) => {
  const brand = useBrand();
  const font = useFonts().caption;
  const { width, height } = useVideoConfig();
  return (
    <div
      style={{
        position: "absolute",
        left: 60,
        right: 60 + width * brand.safeRight,
        top: height * 0.1 + 8,
        textAlign: "center",
        fontFamily: font.family,
        fontWeight: 500,
        fontSize: 30,
        letterSpacing: "0.01em",
        color: brand.captionColor,
        opacity: 0.85,
        textShadow: "0 2px 8px rgba(0,0,0,0.7)",
      }}
    >
      {text}
    </div>
  );
};

export const Vignette: React.FC = () => (
  <AbsoluteFill
    style={{
      pointerEvents: "none",
      background: "radial-gradient(ellipse at center, transparent 58%, rgba(0,0,0,0.28) 100%)",
    }}
  />
);
