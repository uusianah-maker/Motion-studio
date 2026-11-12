// Buat SFX sederhana (WAV 16-bit) tanpa download: pop & whoosh halus.
// Pakai: node pipeline/make-sfx.mjs  -> public/sfx/pop.wav, public/sfx/whoosh.wav
import { mkdirSync, writeFileSync } from "node:fs";

const RATE = 48000;

const toWav = (samples) => {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, s)) * 32767), i * 2));
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(RATE, 24);
  h.writeUInt32LE(RATE * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
};

// Pop: sinus dengan nada turun cepat + klik lembut di awal.
const pop = () => {
  const n = Math.round(RATE * 0.12);
  const out = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const freq = 220 + 680 * Math.exp(-t * 45);
    phase += (2 * Math.PI * freq) / RATE;
    const env = Math.min(1, t / 0.002) * Math.exp(-t * 38);
    out[i] = Math.sin(phase) * env * 0.8;
  }
  return out;
};

// Whoosh: noise yang difilter, membesar lalu hilang, filter menyapu naik.
const whoosh = () => {
  const n = Math.round(RATE * 0.42);
  const out = new Float32Array(n);
  let seed = 12345;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  let lp = 0;
  let bp = 0;
  for (let i = 0; i < n; i++) {
    const t = i / n;
    const cutoff = 0.02 + 0.18 * Math.sin(Math.PI * t); // sapuan filter
    lp += cutoff * (rand() - lp);
    bp += 0.5 * (lp - bp);
    const env = Math.pow(Math.sin(Math.PI * Math.min(1, t * 1.15)), 2);
    out[i] = (lp - bp * 0.5) * env * 2.2;
  }
  // Normalisasi ke -3 dBFS.
  const peak = out.reduce((m, s) => Math.max(m, Math.abs(s)), 0);
  return out.map((s) => (s / peak) * 0.7);
};

mkdirSync("public/sfx", { recursive: true });
writeFileSync("public/sfx/pop.wav", toWav(pop()));
writeFileSync("public/sfx/whoosh.wav", toWav(whoosh()));
console.log("public/sfx/pop.wav, public/sfx/whoosh.wav");
