import { THEME_CHOICES, useTheme } from '../lib/theme';

/** Auto follows the phone's own light or dark setting. */
export function ThemePicker() {
  const { choice, set } = useTheme();
  return (
    <div role="radiogroup" aria-label="Appearance" className="flex gap-0.5 rounded-[10px] bg-line-2 p-[3px]">
      {THEME_CHOICES.map((t) => (
        <button
          key={t.value}
          type="button"
          role="radio"
          aria-checked={choice === t.value}
          onClick={() => set(t.value)}
          className={`min-h-9 flex-1 cursor-pointer rounded-[8px] px-3 text-sm font-bold ${
            choice === t.value ? 'bg-surface text-navy shadow-[0_0_0_1px_var(--card-ring),0_1px_2px_rgba(11,42,91,0.08)]' : 'text-ink-3 hover:text-ink'
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
