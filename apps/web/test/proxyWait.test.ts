import { describe, expect, it } from 'vitest';
import { waitingForProxy } from '../src/proxyWait';

const media = (proxy: 'siap' | 'proses' | null, preview: boolean, codec: string | null = 'hevc') => ({
  current_version_id: 'v1',
  proxy,
  versions: [{ version_id: 'v1', preview, probe: { video_codec: codec } }],
});

describe('waitingForProxy (pratinjau HEVC)', () => {
  it('waits while the light copy is being made', () => expect(waitingForProxy([media('proses', false)])).toBe(true));
  it('waits for HEVC with no copy yet', () => expect(waitingForProxy([media(null, false)])).toBe(true));
  it('stops once the copy is ready (server says preview=true)', () => expect(waitingForProxy([media('siap', true)])).toBe(false));
  it('does not wait for playable h264 or audio-only media', () => {
    expect(waitingForProxy([media(null, true, 'h264')])).toBe(false);
    expect(waitingForProxy([media(null, true, null)])).toBe(false);
  });
  it('an empty list never waits', () => expect(waitingForProxy([])).toBe(false));
});
