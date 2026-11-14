import { useEffect, useState } from 'react';
import type { Api, BrandKit, BrandKitInput } from './api';

/** CSS family names the editor registers for the Brand Kit fonts (X06 title, U1 caption). */
export const BRAND_FONT_FAMILY = 'MotionBrandFont';
export const BRAND_CAPTION_FAMILY = 'MotionBrandCaption';

export interface LoadedBrand {
  kit: BrandKit;
  /** Signed stream URL of the logo image, when the kit has one. */
  logoUrl: string | null;
  /** True once the title font is registered in `document.fonts`. */
  fontReady: boolean;
  captionReady: boolean;
}

async function loadFont(api: Api, family: string, versionId: string): Promise<boolean> {
  if (typeof FontFace === 'undefined') return false;
  try {
    const { url } = await api.streamUrl(versionId);
    const face = new FontFace(family, `url(${JSON.stringify(url)})`);
    await face.load();
    document.fonts.add(face);
    return true;
  } catch {
    return false;
  }
}

/**
 * Load a Brand Kit for the editor (the project's brand, else the workspace default): the logo URL
 * for the preview overlay and the fonts registered as `MotionBrandFont` / `MotionBrandCaption`, so
 * the preview draws brand text in the same face as the render. A missing/unreadable file never
 * breaks the editor: the preview falls back quietly.
 */
export function useBrand(api: Api, opts: { brandId?: string | null; reload?: number } = {}): LoadedBrand | null {
  const [state, setState] = useState<LoadedBrand | null>(null);
  const { brandId = null, reload = 0 } = opts;
  useEffect(() => {
    let live = true;
    (async () => {
      const kit = brandId ? await api.brandById(brandId).catch(() => api.brand()) : await api.brand();
      const logoUrl = kit.logo ? await api.streamUrl(kit.logo.ref.version_id).then((r) => r.url).catch(() => null) : null;
      const fontReady = kit.font ? await loadFont(api, BRAND_FONT_FAMILY, kit.font.version_id) : false;
      const captionReady = kit.font_caption ? await loadFont(api, BRAND_CAPTION_FAMILY, kit.font_caption.version_id) : false;
      if (live) setState({ kit, logoUrl, fontReady, captionReady });
    })().catch(() => live && setState(null));
    return () => {
      live = false;
    };
  }, [api, brandId, reload]);
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

/** An empty sheet for a new brand (same defaults as the server). */
export const emptyKit = (): BrandKitInput => ({
  name: '',
  kode: '',
  handles: {},
  target: '',
  nada: [],
  bahasa: 'id',
  produk: [],
  colors: [],
  text_color: '#ffffff',
  outline: { color: '#000000', px: 0 },
  warna_dilarang: [],
  font: null,
  font_caption: null,
  logo: null,
  logo_light: null,
  outro: { ref: null, detik: 2 },
  gaya: '',
  grading: '',
  filter_bawaan: null,
  cta: {},
  cta_wajib: '',
  disclaimer: null,
  kosakata: [],
  kamus: [],
  kata_kunci: [],
  kapital: 'normal',
  emoji: false,
  guard: { prices: [], banned: [], banned_level: 'block' },
  klaim_boleh: [],
  visual_dilarang: [],
  area_bebas_teks: [],
  aset: [],
  sfx_dilarang: [],
  referensi: [],
  presets: [],
});

/** The editable part of a saved kit. */
export function toInput(k: BrandKit): BrandKitInput {
  const { schema_version: _s, brand_id: _b, revision: _r, updated_at: _u, ...rest } = structuredClone(k);
  void _s;
  void _b;
  void _r;
  void _u;
  return { ...emptyKit(), ...rest };
}
