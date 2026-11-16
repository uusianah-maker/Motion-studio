import { useCallback, useEffect, useRef, useState } from 'react';
import type { Api } from './api';

/**
 * R27: "▶ dengar" for library sounds (SFX / music / VO). One shared player: starting a sound stops
 * the one before; pressing the same button again stops it. Bytes come through the signed stream URL.
 */
export function useSoundPreview(api: Api): { playing: string | null; toggle: (versionId: string) => void } {
  const audio = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const stop = useCallback(() => {
    audio.current?.pause();
    setPlaying(null);
  }, []);
  useEffect(() => () => audio.current?.pause(), []);
  const toggle = useCallback(
    (versionId: string) => {
      if (playing === versionId) return stop();
      audio.current?.pause();
      setPlaying(versionId);
      void api.streamUrl(versionId).then(
        ({ url }) => {
          const el = audio.current ?? new Audio();
          audio.current = el;
          el.onended = () => setPlaying((p) => (p === versionId ? null : p));
          el.onerror = () => setPlaying((p) => (p === versionId ? null : p));
          el.src = url;
          el.dataset.vid = versionId;
          void el.play().catch(() => setPlaying((p) => (p === versionId ? null : p)));
        },
        () => setPlaying(null),
      );
    },
    [api, playing, stop],
  );
  return { playing, toggle };
}
