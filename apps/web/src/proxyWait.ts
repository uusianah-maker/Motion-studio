/** Pure helper (no DOM, no network) so it can be unit-tested in Node. */

type MediaLike = {
  current_version_id: string;
  proxy?: 'siap' | 'proses' | null;
  versions: { version_id: string; preview?: boolean; probe?: { video_codec?: string | null } | null }[];
};

/**
 * True while some video still waits for its light (h264) preview copy: one is being made, or the
 * browser cannot play the original (HEVC from DJI/iPhone) and no copy exists yet. The editor
 * re-reads the media list meanwhile so the video shows without a page reload.
 */
export function waitingForProxy(media: readonly MediaLike[]): boolean {
  return media.some(
    (m) =>
      m.proxy === 'proses' ||
      ((m.proxy === null || m.proxy === undefined) && m.versions.some((v) => v.version_id === m.current_version_id && v.preview === false && !!v.probe?.video_codec)),
  );
}
