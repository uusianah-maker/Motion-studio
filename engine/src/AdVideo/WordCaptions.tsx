import { useMemo } from "react";
import {
  AbsoluteFill,
  interpolate,
  Sequence,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { clamp, theme } from "../theme";
import { useBrand, useFonts, withAlpha } from "./brand";
import { displayText, makeKeywordTest } from "./keywords";
import { buildPages, type CaptionPage } from "./pages";

const EXIT_FRAMES = 5;
// Lebar huruf per font ada di theme.fontFamilies (charEm), dipakai untuk
// mengecilkan kata panjang supaya tidak keluar layar.
const SIDE_PAD = 60;
const MIN_VISIBLE_MS = 300;

const Word: React.FC<{
  text: string;
  isKeyword: boolean;
  enterFrame: number;
  activeUntilFrame: number;
  maxWidth: number;
}> = ({ text, isKeyword, enterFrame, activeUntilFrame, maxWidth }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const brand = useBrand();
  const p = spring({
    frame: frame - enterFrame,
    fps,
    // Kata kunci: pop cepat (~0,1 dtk) dengan pantulan.
    config: isKeyword ? theme.spring.bouncy : theme.spring.snappy,
  });
  const visible = frame >= enterFrame;
  // Kata yang sedang diucapkan menyala; yang sudah lewat sedikit redup.
  const active = frame >= enterFrame && frame < activeUntilFrame;
  const font = useFonts().caption;
  const box = isKeyword && brand.keywordStyle === "box";
  const boxPadX = 18;
  const size = Math.min(
    theme.caption.size * (isKeyword ? brand.keywordScale : 1),
    (maxWidth - (box ? boxPadX * 2 : 0)) / (Math.max(1, text.length) * font.charEm),
  );
  const uppercase = brand.uppercaseAll || isKeyword;
  const stroke = brand.outlinePx ?? Math.round(size * 0.13);

  return (
    <span
      style={{
        display: "inline-block",
        whiteSpace: "pre",
        fontFamily: font.family,
        fontWeight: font.weight,
        fontSize: size,
        lineHeight: 1.08,
        letterSpacing: "-0.01em",
        textTransform: uppercase ? "uppercase" : "none",
        // Kotak: teks warna outline (hitam) di atas kotak warna aksen (cream).
        color: box ? brand.outlineColor : isKeyword ? brand.accentColor : brand.captionColor,
        background: box ? brand.accentColor : undefined,
        padding: box ? `2px ${boxPadX}px` : undefined,
        borderRadius: box ? 16 : undefined,
        WebkitTextStroke: box ? undefined : `${stroke}px ${brand.outlineColor}`,
        paintOrder: "stroke fill",
        textShadow: box
          ? undefined
          : isKeyword
            ? `0 0 40px ${withAlpha(brand.accentColor, 0.45)}, 0 10px 30px rgba(0,0,0,0.55)`
            : "0 10px 30px rgba(0,0,0,0.55)",
        boxShadow: box ? "0 10px 30px rgba(0,0,0,0.35)" : undefined,
        opacity: visible ? p * (active || isKeyword ? 1 : 0.82) : 0,
        transform: `translateY(${interpolate(p, [0, 1], [28, 0])}px) scale(${
          interpolate(p, [0, 1], [isKeyword ? 0.55 : 0.85, 1]) * (active && !isKeyword ? 1.05 : 1)
        })`,
        transformOrigin: "50% 80%",
      }}
    >
      {text}
    </span>
  );
};

const Page: React.FC<{ page: CaptionPage; isKeyword: (w: CaptionPage["words"][number]) => boolean }> = ({
  page,
  isKeyword,
}) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames, height, width } = useVideoConfig();
  const brand = useBrand();

  const exit = interpolate(frame, [durationInFrames - EXIT_FRAMES, durationInFrames], [0, 1], {
    ...clamp,
    easing: theme.ease.in,
  });
  const breathe = 1 + Math.sin(frame / 22) * 0.012;
  const toFrame = (ms: number) => Math.max(0, Math.round(((ms - page.startMs) / 1000) * fps));

  return (
    <AbsoluteFill>
      <div
        style={{
          position: "absolute",
          left: SIDE_PAD,
          right: SIDE_PAD + width * brand.safeRight,
          top: height * brand.captionCenterY,
          transform: `translateY(-50%) translateY(${-exit * 30}px) scale(${breathe})`,
          opacity: 1 - exit,
          display: "flex",
          flexWrap: "wrap",
          justifyContent: "center",
          alignItems: "baseline",
          columnGap: 26, // px, bukan em (lihat aturan spacing)
          rowGap: 4,
          textAlign: "center",
        }}
      >
        {page.words.map((w, i) => (
          <Word
            key={w.startMs}
            text={displayText(w.text)}
            isKeyword={isKeyword(w)}
            enterFrame={toFrame(w.startMs)}
            activeUntilFrame={i + 1 < page.words.length ? toFrame(page.words[i + 1].startMs) : durationInFrames}
            maxWidth={width - SIDE_PAD * 2 - width * brand.safeRight}
          />
        ))}
      </div>
    </AbsoluteFill>
  );
};

export const WordCaptions: React.FC<{
  captions: CaptionPage["words"];
  keywords: string[];
  maxWordsPerPage: number;
  /** Caption disembunyikan sampai waktu ini (judul hook sudah menampilkan kata yang sama). */
  hideBeforeMs?: number;
}> = ({ captions, keywords, maxWordsPerPage, hideBeforeMs = 0 }) => {
  const { fps } = useVideoConfig();
  const pages = useMemo(
    () =>
      buildPages(captions, maxWordsPerPage).flatMap((p) => {
        if (p.startMs >= hideBeforeMs) return [p];
        // Halaman yang mulai di bawah judul hook: tampilkan begitu judul hilang,
        // kecuali sisanya terlalu pendek untuk terbaca.
        return p.endMs - hideBeforeMs >= MIN_VISIBLE_MS ? [{ ...p, startMs: hideBeforeMs }] : [];
      }),
    [captions, maxWordsPerPage, hideBeforeMs],
  );
  const isKeyword = useMemo(() => {
    // Kalau pipeline sudah memilih kata kunci (edit.py), pakai pilihannya.
    if (captions.some((c) => c.emphasis !== undefined)) {
      return (w: CaptionPage["words"][number]) => Boolean(w.emphasis);
    }
    const test = makeKeywordTest(keywords);
    return (w: CaptionPage["words"][number]) => test(w.text);
  }, [captions, keywords]);

  return (
    <>
      {pages.map((page) => {
        const from = Math.round((page.startMs / 1000) * fps);
        const to = Math.round((page.endMs / 1000) * fps);
        return (
          <Sequence
            key={page.startMs}
            name={`Caption: ${page.words.map((w) => w.text).join(" ")}`}
            from={from}
            durationInFrames={Math.max(1, to - from)}
            layout="none"
          >
            <Page page={page} isKeyword={isKeyword} />
          </Sequence>
        );
      })}
    </>
  );
};
