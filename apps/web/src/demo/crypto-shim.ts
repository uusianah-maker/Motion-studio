/** Browser stand-in for `node:crypto` in the demo build (only randomBytes is imported by the core). */
export function randomBytes(n: number) {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return { toString: () => [...a].map((b) => b.toString(16).padStart(2, '0')).join('') };
}
