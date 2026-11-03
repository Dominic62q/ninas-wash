// A round badge with someone's initials. The colour comes from the name, so a person looks the same everywhere.

const TONES = [
  { bg: '#0068d8', fg: '#ffffff' },
  { bg: '#0b7a43', fg: '#ffffff' },
  { bg: '#7a3fc0', fg: '#ffffff' },
  { bg: '#c2410c', fg: '#ffffff' },
  { bg: '#0e7490', fg: '#ffffff' },
  { bg: '#b4235a', fg: '#ffffff' },
  { bg: '#4d5fa8', fg: '#ffffff' },
  { bg: '#8a6a00', fg: '#ffffff' },
] as const;

export function initials(name: string) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  const first = words[0]![0] ?? '';
  const last = words.length > 1 ? (words[words.length - 1]![0] ?? '') : '';
  return (first + last).toUpperCase();
}

function toneFor(name: string) {
  let hash = 0;
  for (const ch of name.trim().toLowerCase()) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return TONES[hash % TONES.length]!;
}

const SIZES = { sm: 'h-7 w-7 text-[11px]', md: 'h-9 w-9 text-xs', lg: 'h-16 w-16 text-xl' } as const;

export function Avatar({ name, size = 'md', ring, className = '' }: { name: string; size?: keyof typeof SIZES; ring?: boolean; className?: string }) {
  const tone = toneFor(name);
  return (
    <span
      aria-hidden="true"
      className={`grid flex-none select-none place-items-center rounded-full font-extrabold tracking-wide ${SIZES[size]} ${ring ? 'ring-2 ring-white/70' : ''} ${className}`}
      style={{ background: tone.bg, color: tone.fg }}
    >
      {initials(name)}
    </span>
  );
}
