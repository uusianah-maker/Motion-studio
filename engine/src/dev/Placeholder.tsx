import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";

// Generator video dummy "orang ngomong" untuk tes, dirender ke public/sample-talking.mp4.
export const Placeholder: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  const bob = Math.sin(t * 6) * 6;

  return (
    <AbsoluteFill
      className="items-center justify-center"
      style={{ background: "linear-gradient(180deg, #4a5a6a 0%, #2b3540 100%)" }}
    >
      {/* Siluet kepala + badan */}
      <div style={{ position: "absolute", top: 560 + bob, width: 380, height: 460, borderRadius: "50%", background: "#c9a88a" }} />
      <div style={{ position: "absolute", top: 1000, width: 820, height: 1100, borderRadius: "300px 300px 0 0", background: "#1f6f8b" }} />
      <div
        className="font-mono text-white"
        style={{ position: "absolute", top: 120, fontSize: 48, opacity: 0.8 }}
      >
        VIDEO MENTAH (DUMMY) · {t.toFixed(1)}s
      </div>
    </AbsoluteFill>
  );
};
