import { useCallback, useEffect, useRef, useState } from 'react';
import type { Api } from '../api';

/**
 * Owner 16 Nov: listen to / watch media straight from the Media page. One thing plays at a time
 * (starting another stops the previous one); nothing plays until the user presses ▶. The stream
 * link is the editor's (light h264 copy when there is one).
 */
export function useMediaPlayer(api: Api, onError: (e: unknown) => void) {
  const audio = useRef<HTMLAudioElement | null>(null);
  /** version_id of what is open: audio playing/paused, or the video shown below its row. */
  const [open, setOpen] = useState<{ versionId: string; kind: 'audio' | 'video'; url: string } | null>(null);
  const [paused, setPaused] = useState(true);

  const stop = useCallback(() => {
    audio.current?.pause();
    setOpen(null);
    setPaused(true);
  }, []);
  useEffect(() => () => audio.current?.pause(), []);

  const toggle = useCallback(
    async (versionId: string, kind: 'audio' | 'video') => {
      if (open?.versionId === versionId) {
        if (kind === 'video') return stop(); // ▶ on an open video closes it
        const el = audio.current;
        if (!el) return;
        if (el.paused) await el.play().catch(onError);
        else el.pause();
        return;
      }
      audio.current?.pause();
      try {
        const { url } = await api.streamUrl(versionId);
        setOpen({ versionId, kind, url });
        if (kind === 'audio' && audio.current) {
          audio.current.src = url;
          await audio.current.play();
        }
      } catch (e) {
        setOpen(null);
        onError(e);
      }
    },
    [api, open, stop, onError],
  );

  const audioEl = (
    <audio
      ref={audio}
      preload="none"
      aria-hidden="true"
      onPlay={() => setPaused(false)}
      onPause={() => setPaused(true)}
      onEnded={() => {
        setPaused(true);
        setOpen(null);
      }}
    />
  );
  /** True while this version's audio is actually playing (button shows ⏸). */
  const isPlaying = (versionId: string) => open?.versionId === versionId && (open.kind === 'video' || !paused);
  return { open, toggle, stop, isPlaying, audioEl };
}
