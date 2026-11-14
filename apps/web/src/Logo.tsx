/** Logo Motion Studio: api dengan tombol play di tengahnya (dipilih owner, 14 Nov 2026). */
export function Logo({ size = 38, title }: { size?: number; title?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 120 120" role={title ? 'img' : undefined} aria-hidden={title ? undefined : true} aria-label={title}>
      <path d="M60 6c10 18 34 30 34 62 0 24-15 44-34 44S26 92 26 68c0-14 6-24 14-31 0 10 4 17 10 19-4-18 2-35 10-50z" fill="#E8432A" />
      <path d="M60 40c6 12 20 20 20 40 0 15-9 25-20 25S40 95 40 80c0-10 5-17 10-21 0 6 3 10 6 11-2-11 0-21 4-30z" fill="#FF8A2B" />
      <path d="M52 68v28l24-14z" fill="#ffffff" stroke="#ffffff" strokeWidth={5} strokeLinejoin="round" />
    </svg>
  );
}
