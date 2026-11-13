import { createContext, useContext } from "react";
import { fontFamilies, theme, type FontName } from "../theme";
import type { BrandStyle } from "./schema";

// Gaya default (tanpa brand kit) diambil dari theme. Brand kit menimpa lewat props.style.
export const defaultStyle: BrandStyle = {
  captionColor: theme.colors.text,
  outlineColor: theme.colors.stroke,
  accentColor: theme.colors.primary,
  outroBg: theme.colors.bg,
  captionCenterY: theme.caption.centerY,
  keywordScale: theme.caption.keywordSize / theme.caption.size,
  uppercaseAll: true,
  safeRight: 0,
};

const BrandContext = createContext<BrandStyle>(defaultStyle);

export const BrandProvider = BrandContext.Provider;
export const useBrand = () => useContext(BrandContext);

/** Font judul/caption dari brand kit (default Montserrat). */
export const useFonts = () => {
  const b = useBrand();
  const pick = (name?: FontName) => fontFamilies[name ?? "Montserrat"];
  return { title: pick(b.titleFont), caption: pick(b.captionFont) };
};

/** "#RRGGBB" -> "rgba(r,g,b,a)" untuk glow/kaca. */
export const withAlpha = (hex: string, alpha: number) => {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.replace(/(.)/g, "$1$1") : h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
};
