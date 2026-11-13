// theme.ts — satu-satunya sumber warna, font, easing, dan spring.
// Jangan menulis hex/easing langsung di komponen.
import { loadFont as loadAnton } from "@remotion/google-fonts/Anton";
import { loadFont } from "@remotion/google-fonts/Montserrat";
import { loadFont as loadOswald } from "@remotion/google-fonts/Oswald";
import { Easing } from "remotion";

const { fontFamily: montserrat } = loadFont("normal", {
  weights: ["700", "800", "900"],
  subsets: ["latin"],
});
const { fontFamily: anton } = loadAnton("normal", { weights: ["400"], subsets: ["latin"] });
const { fontFamily: oswald } = loadOswald("normal", { weights: ["500", "700"], subsets: ["latin"] });

/** Font yang bisa dipilih brand kit, + lebar rata-rata huruf kapital (em) untuk auto-fit. */
export const fontFamilies = {
  Montserrat: { family: montserrat, charEm: 0.68, weight: 900 },
  Anton: { family: anton, charEm: 0.5, weight: 400 },
  Oswald: { family: oswald, charEm: 0.52, weight: 700 },
} as const;
export type FontName = keyof typeof fontFamilies;

export const theme = {
  colors: {
    bg: "#0B0B0F",
    bgAlt: "#16161D",
    // Warna hero: hanya untuk kata kunci, maks satu elemen per frame.
    primary: "#FFD60A",
    accent: "#3A86FF",
    text: "#FFFFFF",
    textDim: "rgba(255,255,255,0.72)",
    stroke: "#000000",
    glow: "rgba(255, 214, 10, 0.45)",
  },
  fonts: {
    display: montserrat,
    body: montserrat,
  },
  ease: {
    out: Easing.bezier(0.16, 1, 0.3, 1),
    inOut: Easing.bezier(0.83, 0, 0.17, 1),
    in: Easing.bezier(0.7, 0, 0.84, 0),
  },
  spring: {
    snappy: { damping: 14, stiffness: 160, mass: 0.6 },
    smooth: { damping: 20, stiffness: 90, mass: 1 },
    bouncy: { damping: 11, stiffness: 170, mass: 0.7 },
  },
  caption: {
    size: 92,
    keywordSize: 118,
    // Pusat caption di ~65% tinggi frame (zona aman 9:16).
    centerY: 0.65,
  },
} as const;

export const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
