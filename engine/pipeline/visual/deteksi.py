"""R24a Face tracking + auto subject detection (MediaPipe Tasks, Apache 2.0) -> jalur-posisi/1.

Jalan di visual-venv (MOTION_VISUAL_PY):
  python pipeline/visual/deteksi.py <video> <keluar.json> [--jenis wajah,objek] [--hz 10] [--label person,...]

- Wajah: FaceDetector blaze_face_short_range (model di <TOOLS>/models, path eksplisit).
- Objek: ObjectDetector efficientdet_lite0 int8 (label COCO, mis. person, handbag, bottle).
- Mode VIDEO (MediaPipe memakai urutan waktu), sampel `hz` per detik; deteksi per frame digabung jadi jalur ber-id
  (jalur_posisi.gabung_deteksi). Hasil = USULAN (hybrid): app menampilkan jalur, user boleh hapus/ubah.
- Aturan beban §18.0: kunci AI global, Idle, 4 thread, tunggu RAM >= 3 GB, progres JSON-lines UTF-8.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import beban  # noqa: E402

beban.siapkan_env()  # sebelum import cv2/mediapipe (thread + prioritas + cache)

import json  # noqa: E402

from jalur_posisi import SCHEMA, gabung_deteksi, validasi  # noqa: E402

MODEL_WAJAH = "blaze_face_short_range.tflite"
MODEL_OBJEK = "efficientdet_lite0_int8.tflite"
SKOR_WAJAH = 0.5
SKOR_OBJEK = 0.4
LABEL_BAWAAN = ("person",)


def relatif_data(p: Path) -> str:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "batch"))
    from jalur import relatif  # noqa: E402  (relatif ke folder DATA, R20)
    return relatif(p)


def _nms(kotak: list[tuple], iou_maks: float = 0.3) -> list[tuple]:
    from jalur_posisi import iou
    simpan = []
    for k in sorted(kotak, key=lambda k: -k[4]):
        a = {"x": k[0], "y": k[1], "w": k[2], "h": k[3]}
        if all(iou(a, {"x": b[0], "y": b[1], "w": b[2], "h": b[3]}) <= iou_maks for b in simpan):
            simpan.append(k)
    return simpan


def potongan_kepala(orang: tuple, W: int, H: int) -> tuple[int, int, int, int] | None:
    """Kotak persegi (piksel) di bagian atas kotak orang: wajah jadi besar untuk model short-range."""
    x, y, w, h = orang[0] * W, orang[1] * H, orang[2] * W, orang[3] * H
    sisi = min(max(w, 0.35 * h), H, W)
    if sisi < 24:
        return None
    x0 = int(max(0, min(W - sisi, x + w / 2 - sisi / 2)))
    y0 = int(max(0, min(H - sisi, y - 0.05 * sisi)))
    return x0, y0, int(sisi), int(sisi)


def deteksi(video: Path, jenis: tuple[str, ...] = ("wajah", "objek"), hz: float = 10.0,
            label: tuple[str, ...] = LABEL_BAWAAN, progres=beban.progres) -> dict:
    """Wajah = deteksi seluruh frame + deteksi di potongan kepala tiap orang (lebih akurat untuk orang yang
    tidak terlalu dekat kamera), digabung NMS. Objek = efficientdet (label diminta)."""
    import cv2
    import mediapipe as mp
    from mediapipe.tasks.python import BaseOptions, vision

    cap = cv2.VideoCapture(str(video))
    if not cap.isOpened():
        raise beban.Ditolak(f"video tidak bisa dibuka: {video.name}")
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    n = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    W, H = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    durasi = n / fps if n else 0.0
    tiap = max(1, int(round(fps / hz)))
    beban.perkiraan("deteksi", durasi * hz * 0.06 + 3)

    M = beban.FOLDER_MODEL
    pakai_wajah, pakai_objek = "wajah" in jenis, "objek" in jenis
    label_objek = tuple(label) if pakai_objek else ()
    izin = sorted(set(label_objek) | ({"person"} if pakai_wajah else set()))
    det_w = vision.FaceDetector.create_from_options(vision.FaceDetectorOptions(
        base_options=BaseOptions(model_asset_path=str(M / MODEL_WAJAH)),
        running_mode=vision.RunningMode.IMAGE, min_detection_confidence=SKOR_WAJAH)) if pakai_wajah else None
    det_o = vision.ObjectDetector.create_from_options(vision.ObjectDetectorOptions(
        base_options=BaseOptions(model_asset_path=str(M / MODEL_OBJEK)),
        running_mode=vision.RunningMode.VIDEO, score_threshold=SKOR_OBJEK, max_results=5,
        category_allowlist=izin)) if izin else None

    def wajah_di(rgb, ox: int, oy: int) -> list[tuple]:
        h, w = rgb.shape[:2]
        img = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
        return [((d.bounding_box.origin_x + ox) / W, (d.bounding_box.origin_y + oy) / H, d.bounding_box.width / W,
                 d.bounding_box.height / H, d.categories[0].score if d.categories else 1.0)
                for d in det_w.detect(img).detections]

    wajah, objek = [], {}
    i = 0
    try:
        while cap.grab():
            if i % tiap == 0:
                ok, frame = cap.retrieve()
                if not ok:
                    break
                t = i / fps
                rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                per: dict[str, list[tuple]] = {}
                if det_o:
                    img = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
                    for d in det_o.detect_for_video(img, int(round(t * 1000))).detections:
                        c = d.categories[0]
                        per.setdefault(c.category_name, []).append(
                            (d.bounding_box.origin_x / W, d.bounding_box.origin_y / H, d.bounding_box.width / W,
                             d.bounding_box.height / H, c.score))
                if det_w:
                    k = wajah_di(rgb, 0, 0)
                    for o in per.get("person", []):
                        pk = potongan_kepala(o, W, H)
                        if pk:
                            x0, y0, sw, sh = pk
                            k += wajah_di(rgb[y0:y0 + sh, x0:x0 + sw].copy(), x0, y0)
                    wajah.append((t, _nms(k)))
                if pakai_objek:
                    for lb in set(label_objek) & (set(per) | set(objek)):
                        objek.setdefault(lb, []).append((t, per.get(lb, [])))
                if n and (i // tiap) % 20 == 0:
                    progres("deteksi", 5 + int(90 * i / n), f"{t:.1f}/{durasi:.1f} dtk")
            i += 1
    finally:
        cap.release()
        for d in (det_w, det_o):
            if d:
                d.close()

    jalur = gabung_deteksi(wajah, "wajah", "face", "wajah") if wajah else []
    for lb, per in sorted(objek.items()):
        jalur += gabung_deteksi(per, "objek", lb, lb)
    jalur = [j for j in jalur if len(j["titik"]) >= 2]  # kedipan 1 sampel = derau
    sumber = "mediapipe-" + "+".join(jenis)
    return {"schema": SCHEMA, "video": relatif_data(video), "lebar": W, "tinggi": H, "fps": round(fps, 3),
            "durasi": round(durasi, 3), "sumber": sumber, "usulan": True, "hz": hz, "jalur": jalur}


def main() -> int:
    import argparse
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser(description="video -> jalur-posisi/1 (wajah + objek, MediaPipe)")
    ap.add_argument("video")
    ap.add_argument("keluar")
    ap.add_argument("--jenis", default="wajah,objek")
    ap.add_argument("--hz", type=float, default=10.0)
    ap.add_argument("--label", default=",".join(LABEL_BAWAAN), help="label COCO objek, dipisah koma")
    a = ap.parse_args()
    jenis = tuple(x for x in a.jenis.split(",") if x in ("wajah", "objek"))
    try:
        if not jenis:
            raise beban.Ditolak("--jenis harus wajah dan/atau objek")
        if not 0.05 <= a.hz <= 30:
            raise beban.Ditolak("--hz harus 0,05..30")
        beban.tunggu_ram()
        with beban.kunci_ai("deteksi"):
            doc = deteksi(Path(a.video).resolve(), jenis, a.hz, tuple(x for x in a.label.split(",") if x))
        salah = validasi(doc)
        if salah:
            raise RuntimeError("hasil tidak sah: " + "; ".join(salah[:3]))
        Path(a.keluar).write_text(json.dumps(doc, ensure_ascii=False), encoding="utf-8")
        beban.progres("selesai", 100, f"{len(doc['jalur'])} jalur", jalur=len(doc["jalur"]))
        return 0
    except beban.Ditolak as e:
        beban.progres("ditolak", 100, str(e))
        return 2
    except Exception as e:  # noqa: BLE001
        print(f"GAGAL: {e!r}", file=sys.stderr)
        beban.progres("gagal", 100, str(e)[:300])
        return 1


if __name__ == "__main__":
    sys.exit(main())
