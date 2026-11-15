// R13: a new brand fast — duplicate a Brand Kit (with presets) under a new name and code.
import { describe, expect, it } from 'vitest';
import { listBrands, readBrand } from '../src/storage/brand.js';
import { isStorageError } from '../src/storage/errors.js';
import { StorageService } from '../src/storage/service.js';
import { fixtureWorkspace } from './fixtures.js';

const code = async (fn: () => unknown) => {
  try {
    await fn();
    return 'OK';
  } catch (e) {
    return isStorageError(e) ? e.code : `RAW:${String(e)}`;
  }
};

describe('R13 duplicate brand', () => {
  it('copies the Brand Kit and presets under a new name and code; the source is untouched', async () => {
    const { ws } = await fixtureWorkspace();
    const svc = new StorageService(ws);
    const src = (
      await svc.createBrand({
        kit: { name: 'Aysilla Factory', kode: 'AYS', colors: ['#111111', '#ffd23f'], produk: [{ nama: 'Loose Pants', varian: ['Espresso'] }], presets: [{ id: 'preset-1', nama: 'Konversi Aysilla', tujuan: 'konversi' }] },
        actor: 'user',
      })
    ).result;
    const dup = (await svc.duplicateBrand({ brand_id: src.brand_id, name: 'Korset Nusantara', kode: 'KSN', actor: 'user' })).result;
    expect(dup.brand_id).not.toBe(src.brand_id);
    expect(dup).toMatchObject({ name: 'Korset Nusantara', kode: 'KSN', revision: 1, colors: ['#111111', '#ffd23f'] });
    expect(dup.presets.map((p) => p.nama)).toEqual(['Konversi Aysilla']);
    expect(dup.produk).toEqual(src.produk);
    expect(await readBrand(ws, src.brand_id)).toMatchObject({ name: 'Aysilla Factory', kode: 'AYS', revision: src.revision });
    // Without a code: made from the new name.
    const auto = (await svc.duplicateBrand({ brand_id: src.brand_id, name: 'Batik Sentosa', actor: 'user' })).result;
    expect(auto.kode).toMatch(/^[A-Z0-9]{2,5}$/);
    expect(new Set((await listBrands(ws)).map((b) => b.kode)).size).toBe(3);
    // Refused: no name, the same name, a code already used.
    expect(await code(() => svc.duplicateBrand({ brand_id: src.brand_id, name: '', actor: 'user' }))).toBe('EDIT_INVALID');
    expect(await code(() => svc.duplicateBrand({ brand_id: src.brand_id, name: 'aysilla factory', actor: 'user' }))).toBe('EDIT_INVALID');
    expect(await code(() => svc.duplicateBrand({ brand_id: src.brand_id, name: 'Lain Lagi', kode: 'AYS', actor: 'user' }))).toBe('EDIT_INVALID');
    expect(await code(() => svc.duplicateBrand({ brand_id: 'b-tidakada', name: 'X Baru', actor: 'user' }))).toBe('NOT_FOUND');
  });
});
