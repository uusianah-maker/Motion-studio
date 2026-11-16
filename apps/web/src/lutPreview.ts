import { useEffect, useState } from 'react';
import { lutMatrix, lutMatrixValues, parseCube } from '../../../packages/core/dist/storage/lut.js';
import type { Api } from './api';

/**
 * R38b(2): the live preview of a `.cube` LUT — an SVG feColorMatrix fitted to the LUT (exact for
 * linear grades, close for curves). The render applies the real file with FFmpeg lut3d; the swatch in
 * Brand → Aset / the picker shows the exact result. Cached per version (a LUT never changes).
 */
const cache = new Map<string, Promise<string | null>>();

export function lutValues(api: Api, versionId: string): Promise<string | null> {
  let p = cache.get(versionId);
  if (!p) {
    p = (async () => {
      const { url } = await api.streamUrl(versionId);
      return lutMatrixValues(lutMatrix(parseCube(await (await fetch(url)).text())));
    })().catch(() => null);
    cache.set(versionId, p);
  }
  return p;
}

/** feColorMatrix values for the LUT of `versionId` (null while loading / none / unreadable). */
export function useLutValues(api: Api, versionId: string | null | undefined): string | null {
  const [state, setState] = useState<{ id: string; values: string | null } | null>(null);
  useEffect(() => {
    if (!versionId) return;
    let live = true;
    void lutValues(api, versionId).then((values) => live && setState({ id: versionId, values }));
    return () => {
      live = false;
    };
  }, [api, versionId]);
  return versionId && state?.id === versionId ? state.values : null;
}
