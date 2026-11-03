import { useEffect, useState } from 'react';

/**
 * The wash works online only. When the connection drops we say so at the top of every screen,
 * so nobody thinks a payment or a job was saved when it was not.
 */
export function ConnectionBanner() {
  const [online, setOnline] = useState(() => navigator.onLine);

  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);

  if (online) return null;
  return (
    <div role="alert" className="bg-red px-4 py-2 text-center text-sm font-bold text-white">
      No internet connection. Nothing you do now will be saved until it comes back.
    </div>
  );
}
