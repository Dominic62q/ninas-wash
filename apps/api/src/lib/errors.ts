/** An error we meant to raise. `message` is safe to show to the person using the app. */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const notFound = (what = 'That') => new HttpError(404, 'not_found', `${what} does not exist.`);
export const conflict = (code: string, message: string) => new HttpError(409, code, message);
export const unauthorized = (message = 'Please sign in.') => new HttpError(401, 'unauthorized', message);
export const forbidden = (message = 'You are not allowed to do that.') => new HttpError(403, 'forbidden', message);
