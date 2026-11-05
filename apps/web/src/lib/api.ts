/** An error from the server, or a failure to reach it (status 0). `message` is safe to show on screen. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }

  get isOffline() {
    return this.status === 0;
  }
}

interface Options {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
}

/** Fetch a file the server makes, like a receipt PDF. */
export async function apiFile(path: string): Promise<Blob> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, { credentials: 'same-origin' });
  } catch {
    throw new ApiError(0, 'offline', 'Cannot reach the server. Check the internet connection and try again.');
  }
  if (!res.ok) throw new ApiError(res.status, 'error', 'The receipt could not be made. Try again.');
  return res.blob();
}

/** Send a file as the request body, like a receipt photo. */
export async function apiUpload<T>(path: string, file: Blob): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': file.type || 'application/octet-stream' }, body: file });
  } catch {
    throw new ApiError(0, 'offline', 'Cannot reach the server. Check the internet connection and try again.');
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(res.status, err?.code ?? 'error', err?.message ?? (res.status === 413 ? 'The photo is too big.' : 'Something went wrong. Try again.'));
  }
  return data as T;
}

/**
 * The only way the app talks to the server. Always same-site, so the sign-in cookie rides along.
 * The wash works online only: if the server cannot be reached we say so, and never pretend a save worked.
 */
export async function api<T>(path: string, { method = 'GET', body }: Options = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'offline', 'Cannot reach the server. Check the internet connection and try again.');
  }

  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(res.status, err?.code ?? 'error', err?.message ?? 'Something went wrong. Try again.');
  }
  return data as T;
}
