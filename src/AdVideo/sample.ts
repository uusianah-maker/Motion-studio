import uji01 from "../../data/uji01/props.json";
import type { AdVideoProps } from "./schema";

// Props default untuk preview di Studio = hasil pipeline uji-01.
// Untuk video lain: jalankan pipeline/transcribe.py + autocut.py, lalu render
// dengan --props=data/<nama>/props.json.
export const sampleProps: AdVideoProps = uji01;
