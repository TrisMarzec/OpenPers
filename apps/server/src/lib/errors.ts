export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public extra?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export const badRequest = (msg = 'Bad request', extra?: Record<string, unknown>) => new HttpError(400, msg, extra);
export const unauthorized = (msg = 'Authentication required') => new HttpError(401, msg);
export const forbidden = (msg = 'Forbidden') => new HttpError(403, msg);
export const notFound = (msg = 'Not found') => new HttpError(404, msg);
export const conflict = (msg = 'Conflict', extra?: Record<string, unknown>) => new HttpError(409, msg, extra);
export const unprocessable = (msg = 'Validation failed', errors: { path: string; message: string }[] = []) => new HttpError(422, msg, { errors });

const TITLES: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  413: 'Payload Too Large',
  415: 'Unsupported Media Type',
  422: 'Unprocessable Entity',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
};

export function problem(status: number, detail: string, extra?: Record<string, unknown>) {
  return { type: 'about:blank', title: TITLES[status] ?? 'Error', status, detail, ...extra };
}
