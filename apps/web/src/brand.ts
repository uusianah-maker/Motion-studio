import { useEffect, useState } from 'react';
import type { Api, BrandKit } from './api';

/** CSS family name the editor registers for the Brand Kit font (X06). */
export const BRAND_FONT_FAMILY = 'MotionBrandFont';

export interface LoadedBrand {
  kit: BrandKit;
  /** Signed stream URL of the logo image, when the kit has one. */
  logoUrl: string | null;
  /** True once the brand font is registered in `document.fonts`. */
  fontReady: boolean;
}

/**
 * Load the workspace Brand Kit for the editor: the logo URL for the preview overlay and the font
 * registered as `MotionBrandFont`, so the preview draws brand text in the same face as the render.
 * A missing/unreadable font or logo never breaks the editor: the preview falls back quietly.
 */
export function useBrand(api: Api, reload = 0): LoadedBrand | null {
  const [state, setState] = useState<LoadedBrand | null>(null);
  useEffect(() => {
    let live = true;
    (async () => {
      const kit = await api.brand();
      let logoUrl: string | null = null;
      let fontReady = false;
      if (kit.logo) logoUrl = await api.streamUrl(kit.logo.ref.version_id).then((r) => r.url).catch(() => null);
      if (kit.font && typeof FontFace !== 'undefined') {
        try {
          const { url } = await api.streamUrl(kit.font.version_id);
          const face = new FontFace(BRAND_FONT_FAMILY, `url(${JSON.stringify(url)})`);
          await face.load();
          document.fonts.add(face);
          fontReady = true;
        } catch {
          fontReady = false;
        }
      }
      if (live) setState({ kit, logoUrl, fontReady });
    })().catch(() => live && setState(null));
    return () => {
      live = false;
    };
  }, [api, reload]);
  return state;
}

/** Brand preset look for new text (X06): main colour box, brand text colour, brand font if any. */
export const brandStyle = (kit: BrandKit) => ({
  bg: kit.colors[0] ?? '#000000',
  bg_opacity: 1,
  color: kit.text_color,
  bold: true,
  outline: false,
  font: kit.font ? ('brand' as const) : ('default' as const),
});
