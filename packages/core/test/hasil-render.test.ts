import { describe, expect, it } from 'vitest';
import { namaAman } from '../src/storage/hasilRender.js';

describe('HASIL RENDER: nama file aman untuk Windows', () => {
  it('membuang karakter terlarang & kontrol, memendekkan, menjaga ekstensi', () => {
    expect(namaAman('Batch KORSET · varian-002: "hook"?.mp4')).toBe('Batch KORSET · varian-002 hook.mp4');
    expect(namaAman('a\u0001b\tc.mp4')).toBe('a b c.mp4');
    expect(namaAman(`${'x'.repeat(300)}.mp4`).length).toBe(180);
    expect(namaAman('...mp4'.slice(0, 0) + '?.mp4')).toBe('video.mp4');
  });
});
