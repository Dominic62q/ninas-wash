import { Link } from 'react-router';
import { Icon } from '../components/Icon';
import { useAuth } from '../lib/auth';
import { SETTINGS_SECTIONS, navFor, settingsFor } from '../lib/nav';

/** Everything that can be set up or changed, in one place. Each person sees only what their role allows. */
export function Settings() {
  const { can } = useAuth();
  const items = settingsFor(navFor(can));

  return (
    <div className="mx-auto flex w-full max-w-[720px] flex-col gap-5">
      {SETTINGS_SECTIONS.map((section) => {
        const inSection = items.filter((i) => i.inSettings?.section === section);
        if (inSection.length === 0) return null;
        return (
          <section key={section} aria-labelledby={`settings-${section}`} className="flex flex-col gap-2">
            <h2 id={`settings-${section}`} className="px-1 text-sm font-medium text-ink-3">
              {section}
            </h2>
            <ul className="overflow-hidden border border-line bg-surface max-lg:rounded-[14px] max-lg:border-0 max-lg:shadow-card">
              {inSection.map((item) => (
                <li key={item.path} className="border-t border-line-2 first:border-t-0">
                  <Link to={item.path} className="flex min-h-14 items-center gap-3 px-3.5 py-2.5 text-ink no-underline hover:bg-band active:bg-band">
                    <span className="grid h-[34px] w-[34px] flex-none place-items-center rounded-[9px] bg-blue-50 text-navy">
                      <Icon name={item.icon} size={18} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium">{item.label}</span>
                      <span className="block text-sm text-ink-3">{item.inSettings?.blurb}</span>
                    </span>
                    <span aria-hidden="true" className="text-ink-3">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="m9 6 6 6-6 6" />
                      </svg>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
