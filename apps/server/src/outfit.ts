import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { type ImageAiStore, ImageGenError, generateImageEdit } from './ai/imageAi.js';
import type { Route } from './app.js';
import {
  type EngineStatus,
  type Workspace,
  ULANG_MAKS,
  audit,
  engineJobDir,
  isJobId,
  isOutfitSiapkan,
  outfitChangeInput,
  outfitFingerprint,
  outfitRakitInput,
  outfitRequest,
  prepareEngineJob,
  readEngineStatus,
  readKatalog,
  readOutfitImage,
  readOutfitState,
  readOutfitView,
  readProject,
  readSiapkanDoc,
  saveKatalog,
  updateOutfitState,
  validateEngineJob,
} from './core.js';
import { ApiError } from './errors.js';
import { readJsonBody } from './http.js';
import { onlyKeys } from './routes.js';
import { sendBytes } from './stream.js';

/**
 * §29 Beat Spot "Ganti Outfit" (KONTRAK-ENGINE §29, owner 25 Nov 2026: Tahap B, all team members,
 * max 5 footage, looks chosen automatically, sound from the template).
 *
 * The engine prepares (siapkan) and assembles (rakit); this module makes the AI pictures in between
 * with the owner's saved key (R12a "AI gambar"): one picture at a time for the whole server, a
 * monthly budget (estimated price per picture × pictures this month), every attempt in
 * `<stateDir>/ai-gambar-pakai.jsonl`. Nothing is rendered: the draft goes to the editor through the
 * normal plan → approve path.
 */

export interface OutfitDeps {
  engine: { enqueue: (projectId: string, prepare: () => Promise<EngineStatus>) => Promise<EngineStatus>; isActive: (projectId: string, jobId: string) => boolean };
  imageAi: ImageAiStore;
  stateDir: string;
  fetchImpl?: typeof fetch;
  devEndpoints?: boolean;
  onError?: (e: unknown) => void;
  /** Test hook: wait between pictures (default none). */
  now?: () => number;
}

interface Pakai {
  at: number;
  project_id: string;
  job_id: string;
  footage: string;
  model: string | null;
  ok: boolean;
  biaya: number | null;
  mata_uang: 'IDR' | 'USD';
}

const jobParam = (j: string | undefined) => {
  if (!isJobId(j)) throw new ApiError(400, 'BAD_REQUEST', 'job_id tidak valid');
  return j as string;
};
const FID = /^[A-Za-z0-9_-]{1,40}$/;

export function createOutfit(ws: Workspace, deps: OutfitDeps) {
  const now = deps.now ?? Date.now;
  const ledgerFile = path.join(deps.stateDir, 'ai-gambar-pakai.jsonl');
  const queue: { p: string; j: string; fid: string }[] = [];
  let busy: { p: string; j: string; fid: string } | null = null;
  let stopped = false;
  let worker: Promise<void> | null = null;

  const readLedger = async (): Promise<Pakai[]> => {
    const raw = await fsp.readFile(ledgerFile, 'utf8').catch(() => '');
    return raw
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l) as Pakai;
        } catch {
          return null;
        }
      })
      .filter((x): x is Pakai => !!x);
  };
  const monthOf = (t: number) => new Date(t).toISOString().slice(0, 7);
  const usage = async () => {
    const bulan = monthOf(now());
    const ini = (await readLedger()).filter((x) => monthOf(x.at) === bulan && x.ok);
    const cfg = deps.imageAi.raw();
    return { bulan, gambar: ini.length, biaya: ini.reduce((a, x) => a + (x.biaya ?? 0), 0), batas: cfg.budget.amount, mata_uang: cfg.budget.currency, harga_per_gambar: cfg.harga_per_gambar };
  };
  /** Budget gate before every picture (blocks, never bills past the limit). */
  const checkBudget = async () => {
    const u = await usage();
    if (u.batas === null) return;
    if (u.harga_per_gambar === null) throw new ImageGenError('Batas biaya AI gambar aktif: isi "perkiraan harga per gambar" dulu (menu AI → AI gambar)', 'config');
    if (u.biaya + u.harga_per_gambar > u.batas) throw new ImageGenError(`Batas biaya AI gambar bulan ini tercapai (${u.biaya} dari ${u.batas} ${u.mata_uang}, ${u.gambar} gambar)`, 'quota');
  };

  const queued = (p: string, j: string, fid: string) => queue.some((q) => q.p === p && q.j === j && q.fid === fid) || (busy?.p === p && busy.j === j && busy.fid === fid);

  /** All pictures ready → (re)assemble once; a changed picture cleared `rakit_job`. */
  const rakitLock = new Map<string, Promise<void>>();
  const maybeRakit = (p: string, j: string): Promise<void> => {
    const k = `${p}/${j}`;
    const next = (rakitLock.get(k) ?? Promise.resolve()).then(() => maybeRakitOnce(p, j));
    const tail = next.catch(() => undefined);
    rakitLock.set(k, tail);
    void tail.then(() => {
      if (rakitLock.get(k) === tail) rakitLock.delete(k);
    });
    return next;
  };
  const maybeRakitOnce = async (p: string, j: string) => {
    const doc = await readSiapkanDoc(ws, p, j);
    if (!doc) return;
    const st = await readOutfitState(ws, p, j);
    if (st.berhenti || !doc.items.every((it) => st.gambar[it.footage]?.status === 'siap')) return;
    if (st.rakit_job) {
      const r = await readEngineStatus(ws, p, st.rakit_job).catch(() => null);
      if (r && (r.state !== 'gagal' || deps.engine.isActive(p, st.rakit_job))) return;
    }
    const input = await outfitRakitInput(ws, p, j);
    const s = await deps.engine.enqueue(p, () => prepareEngineJob(ws, input));
    await updateOutfitState(ws, p, j, (x) => {
      x.rakit_job = s.job_id;
    });
  };

  const pump = () => {
    if (worker || stopped) return;
    worker = (async () => {
      while (!stopped && queue.length) {
        const t = queue.shift()!;
        busy = t;
        try {
          await makeOne(t.p, t.j, t.fid);
          await maybeRakit(t.p, t.j);
        } catch (e) {
          deps.onError?.(e);
        } finally {
          busy = null;
        }
      }
    })().finally(() => {
      worker = null;
      if (queue.length && !stopped) pump();
    });
  };

  const makeOne = async (p: string, j: string, fid: string) => {
    const st = await readOutfitState(ws, p, j);
    if (st.berhenti) return;
    await updateOutfitState(ws, p, j, (x) => {
      x.gambar[fid] = { ...(x.gambar[fid] ?? { ulang: 0, model: null }), status: 'membuat', alasan: null, at: now() };
    });
    const cfg = deps.imageAi.raw();
    let model: string | null = null;
    try {
      await checkBudget();
      const req = await outfitRequest(ws, p, j, fid);
      const r = await generateImageEdit(deps.imageAi, { images: req.images, prompt: req.prompt, size: req.size }, deps.fetchImpl ?? fetch, { devEndpoints: deps.devEndpoints === true });
      model = r.model;
      await fsp.writeFile(req.hasil, r.bytes);
      await appendLedger({ at: now(), project_id: p, job_id: j, footage: fid, model, ok: true, biaya: cfg.harga_per_gambar, mata_uang: cfg.budget.currency });
      await updateOutfitState(ws, p, j, (x) => {
        x.gambar[fid] = { ...(x.gambar[fid] ?? { ulang: 0 }), status: 'siap', alasan: null, model, at: now(), dipakai_ulang: false };
      });
      await audit(ws, { op: 'outfit.gambar', actor: 'system', outcome: 'ok', project_id: p, job_id: j, footage: fid, model });
    } catch (e) {
      const alasan = e instanceof ImageGenError ? e.message : `Gagal membuat gambar: ${e instanceof Error ? e.message : String(e)}`;
      if (!(e instanceof ImageGenError && e.kind === 'config')) await appendLedger({ at: now(), project_id: p, job_id: j, footage: fid, model, ok: false, biaya: null, mata_uang: cfg.budget.currency });
      await updateOutfitState(ws, p, j, (x) => {
        x.gambar[fid] = { ...(x.gambar[fid] ?? { ulang: 0, model: null }), status: 'gagal', alasan, at: now() };
      });
      await audit(ws, { op: 'outfit.gambar', actor: 'system', outcome: 'failed', project_id: p, job_id: j, footage: fid, alasan: alasan.slice(0, 200) });
    }
  };
  const appendLedger = async (x: Pakai) => {
    await fsp.mkdir(deps.stateDir, { recursive: true, mode: 0o700 });
    await fsp.appendFile(ledgerFile, JSON.stringify(x) + '\n', { mode: 0o600 });
  };

  /**
   * Make sure every picture of a finished siapkan job is made, reused or queued (also after a server
   * restart: called when the page asks for the run).
   */
  // One ensure at a time per run: the engine hook and the page may ask at the same moment, and two
  // passes must never queue the same (paid) picture twice.
  const ensuring = new Map<string, Promise<void>>();
  const ensure = (p: string, j: string): Promise<void> => {
    const k = `${p}/${j}`;
    const next = (ensuring.get(k) ?? Promise.resolve()).then(() => ensureOnce(p, j));
    const tail = next.catch(() => undefined);
    ensuring.set(k, tail);
    void tail.then(() => {
      if (ensuring.get(k) === tail) ensuring.delete(k);
    });
    return next;
  };
  const ensureOnce = async (p: string, j: string) => {
    const doc = await readSiapkanDoc(ws, p, j);
    if (!doc) return;
    const st = await readOutfitState(ws, p, j);
    if (st.berhenti) return;
    const jdir = engineJobDir(ws, p, j);
    for (const it of doc.items) {
      const g = st.gambar[it.footage];
      const ada = await fsp.stat(path.join(jdir, 'out', it.hasil)).then(() => true, () => false);
      if (g?.status === 'siap' && ada) continue;
      if (g?.status === 'gagal') continue; // the team decides (Ulang) — no silent retries that cost money
      if (g?.status === 'membuat' && queued(p, j, it.footage)) continue;
      if (queued(p, j, it.footage)) continue;
      // A look change: the same frame + prompt + catalog photos in the earlier run → reuse its picture.
      if (st.salin_dari && !g) {
        const lama = await readSiapkanDoc(ws, p, st.salin_dari).catch(() => null);
        const li = lama?.items.find((x) => x.footage === it.footage);
        const fpBaru = await outfitFingerprint(ws, p, j, it.footage);
        const fpLama = li ? await outfitFingerprint(ws, p, st.salin_dari, it.footage) : null;
        const fileLama = li ? path.join(engineJobDir(ws, p, st.salin_dari), 'out', li.hasil) : null;
        if (fpBaru && fpBaru === fpLama && fileLama && (await fsp.stat(fileLama).then(() => true, () => false))) {
          await fsp.copyFile(fileLama, path.join(jdir, 'out', it.hasil));
          const lst = await readOutfitState(ws, p, st.salin_dari);
          await updateOutfitState(ws, p, j, (x) => {
            x.gambar[it.footage] = { status: 'siap', ulang: lst.gambar[it.footage]?.ulang ?? 0, alasan: null, model: lst.gambar[it.footage]?.model ?? null, at: now(), dipakai_ulang: true };
          });
          continue;
        }
      }
      await updateOutfitState(ws, p, j, (x) => {
        x.gambar[it.footage] = { ...(x.gambar[it.footage] ?? { ulang: 0, model: null, alasan: null }), status: 'menunggu', at: now() };
      });
      queue.push({ p, j, fid: it.footage });
    }
    pump();
    await maybeRakit(p, j);
  };

  const onSettled = (s: EngineStatus) => {
    if (s.mode !== 'outfit' || s.state !== 'siap') return;
    void (async () => {
      if (await isOutfitSiapkan(ws, s.project_id, s.job_id)) await ensure(s.project_id, s.job_id);
    })().catch((e: unknown) => deps.onError?.(e));
  };

  const needSiapkan = async (p: string, j: string) => {
    await readProject(ws, p);
    if (!(await isOutfitSiapkan(ws, p, j))) throw new ApiError(400, 'BAD_REQUEST', 'Job ini bukan Ganti Outfit (tahap siapkan)');
  };

  const routes: Route[] = [
    {
      method: 'GET',
      path: '/api/katalog/:brand_id',
      handle: async ({ params }) => ({ katalog: await readKatalog(ws, params.brand_id!) }),
    },
    {
      method: 'POST',
      path: '/api/katalog/:brand_id',
      handle: async ({ req, params, actor }) => {
        if (actor !== 'user') throw new ApiError(403, 'FORBIDDEN', 'Hanya pengguna yang boleh mengubah katalog');
        const body = await readJsonBody(req);
        onlyKeys(body, ['produk', 'expected_revision']);
        const k = await saveKatalog(ws, params.brand_id!, { produk: body.produk }, body.expected_revision);
        await audit(ws, { op: 'katalog.save', actor, outcome: 'ok', brand_id: params.brand_id!, produk: k.produk.length });
        return { katalog: k };
      },
    },
    {
      method: 'GET',
      path: '/api/ai/gambar/pakai',
      handle: async () => ({ pakai: await usage() }),
    },
    {
      method: 'POST',
      path: '/api/projects/:project_id/outfit',
      handle: async ({ req, params, actor }) => {
        if (actor !== 'user') throw new ApiError(403, 'FORBIDDEN', 'Hanya pengguna yang boleh menjalankan mesin');
        const body = await readJsonBody(req);
        onlyKeys(body, ['sources', 'outfit']);
        const input = validateEngineJob({ mode: 'outfit', project_id: params.project_id, sources: body.sources, outfit: { ...((body.outfit as object) ?? {}), tahap: 'siapkan' } });
        if (!deps.imageAi.raw().sealed_key) throw new ApiError(409, 'NOT_READY', 'API key AI gambar belum disimpan owner (menu AI → AI gambar)');
        const job = await deps.engine.enqueue(input.project_id, () => prepareEngineJob(ws, input));
        return { job };
      },
    },
    {
      method: 'GET',
      path: '/api/projects/:project_id/outfit/:job_id',
      handle: async ({ params }) => {
        const p = params.project_id!;
        const j = jobParam(params.job_id);
        await needSiapkan(p, j);
        const s = await readEngineStatus(ws, p, j);
        if (s.state === 'siap') await ensure(p, j).catch((e: unknown) => deps.onError?.(e));
        return { outfit: await readOutfitView(ws, p, j), ulang_maks: ULANG_MAKS };
      },
    },
    {
      method: 'GET',
      path: '/api/projects/:project_id/outfit/:job_id/gambar/:footage/:jenis',
      handle: async ({ req, res, params }) => {
        const j = jobParam(params.job_id);
        await needSiapkan(params.project_id!, j);
        const img = await readOutfitImage(ws, params.project_id!, j, params.footage ?? '', params.jenis ?? '');
        await sendBytes(req, res, { size: img.bytes.length, mime: img.mime, open: async (r) => Readable.from(r ? img.bytes.subarray(r.start, r.end + 1) : img.bytes) });
        return undefined;
      },
    },
    {
      // Make one picture again (same look). Max ULANG_MAKS per footage; a failed picture may always be retried.
      method: 'POST',
      path: '/api/projects/:project_id/outfit/:job_id/ulang',
      handle: async ({ req, params, actor }) => {
        if (actor !== 'user') throw new ApiError(403, 'FORBIDDEN', 'Hanya pengguna yang boleh menjalankan mesin');
        const p = params.project_id!;
        const j = jobParam(params.job_id);
        await needSiapkan(p, j);
        const body = await readJsonBody(req);
        onlyKeys(body, ['footage']);
        const fid = typeof body.footage === 'string' && FID.test(body.footage) ? body.footage : null;
        const doc = await readSiapkanDoc(ws, p, j);
        if (!fid || !doc?.items.some((i) => i.footage === fid)) throw new ApiError(400, 'BAD_REQUEST', 'footage tidak ada di job ini');
        const st = await readOutfitState(ws, p, j);
        const g = st.gambar[fid];
        if (g?.status === 'membuat' || g?.status === 'menunggu') throw new ApiError(409, 'BUSY', 'Gambar ini sedang dibuat');
        const hitung = g?.status === 'siap';
        if (hitung && (g?.ulang ?? 0) >= ULANG_MAKS) throw new ApiError(409, 'BUSY', `Gambar ini sudah dibuat ulang ${ULANG_MAKS}x; ganti look kalau masih kurang pas`);
        await updateOutfitState(ws, p, j, (x) => {
          x.berhenti = false;
          x.rakit_job = null;
          x.gambar[fid] = { ...(x.gambar[fid] ?? { model: null }), status: 'menunggu', ulang: (x.gambar[fid]?.ulang ?? 0) + (hitung ? 1 : 0), alasan: null, at: now(), dipakai_ulang: false };
        });
        queue.push({ p, j, fid });
        pump();
        await audit(ws, { op: 'outfit.ulang', actor, outcome: 'ok', project_id: p, job_id: j, footage: fid });
        return { outfit: await readOutfitView(ws, p, j) };
      },
    },
    {
      // Change looks / whose clothes / texts: a new siapkan job; unchanged pictures are reused.
      method: 'POST',
      path: '/api/projects/:project_id/outfit/:job_id/ubah',
      handle: async ({ req, params, actor }) => {
        if (actor !== 'user') throw new ApiError(403, 'FORBIDDEN', 'Hanya pengguna yang boleh menjalankan mesin');
        const p = params.project_id!;
        const j = jobParam(params.job_id);
        await needSiapkan(p, j);
        const body = await readJsonBody(req);
        onlyKeys(body, ['look', 'target', 'teks_atas', 'judul_akhir', 'sub_akhir']);
        const input = await outfitChangeInput(ws, p, j, body);
        const job = await deps.engine.enqueue(p, () =>
          prepareEngineJob(ws, input).then(async (s) => {
            await updateOutfitState(ws, p, s.job_id, (x) => {
              x.salin_dari = j;
            });
            return s;
          }),
        );
        return { job };
      },
    },
    {
      method: 'POST',
      path: '/api/projects/:project_id/outfit/:job_id/berhenti',
      handle: async ({ params, actor }) => {
        if (actor !== 'user') throw new ApiError(403, 'FORBIDDEN', 'Hanya pengguna yang boleh menjalankan mesin');
        const p = params.project_id!;
        const j = jobParam(params.job_id);
        await needSiapkan(p, j);
        for (let i = queue.length - 1; i >= 0; i--) if (queue[i]!.p === p && queue[i]!.j === j) queue.splice(i, 1);
        await updateOutfitState(ws, p, j, (x) => {
          x.berhenti = true;
          for (const g of Object.values(x.gambar)) {
            if (g.status !== 'menunggu') continue;
            g.status = 'gagal';
            g.alasan = 'Dihentikan tim';
          }
        });
        return { outfit: await readOutfitView(ws, p, j) };
      },
    },
  ];

  return {
    routes,
    onSettled,
    /** Server stop: no new picture starts; the one in flight finishes (or times out). */
    stop: async () => {
      stopped = true;
      queue.length = 0;
      await worker;
    },
    /** Test helper: wait until the picture queue is empty. */
    idle: async () => {
      while (worker) await worker;
    },
  };
}
export type Outfit = ReturnType<typeof createOutfit>;
