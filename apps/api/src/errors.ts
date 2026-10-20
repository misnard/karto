import type { ApiErrorBody, ApiErrorCode } from '@karto/contracts';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';

export class AppError extends Error {
  override readonly name = 'AppError';

  constructor(
    readonly code: ApiErrorCode,
    readonly status: ContentfulStatusCode,
    message: string = code,
  ) {
    super(message);
  }
}

function errorBody(code: ApiErrorCode, message: string): ApiErrorBody {
  return { error: { code, message } };
}

export function onError(err: Error, c: Context): Response {
  if (err instanceof AppError) return c.json(errorBody(err.code, err.message), err.status);
  if (err instanceof z.ZodError) return c.json(errorBody('invalid_request', z.prettifyError(err)), 400);
  console.error('unhandled error', { method: c.req.method, path: c.req.path, error: err.message, stack: err.stack });
  return c.json(errorBody('internal', 'Internal error'), 500);
}

export function notFound(c: Context): Response {
  return c.json(errorBody('not_found', 'Not found'), 404);
}

/** Parses the JSON body with `schema`. Invalid JSON or shape → 400 invalid_request. */
export async function readBody<T extends z.ZodType>(c: Context, schema: T): Promise<z.output<T>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new AppError('invalid_request', 400, 'Invalid JSON body');
  }
  return schema.parse(body);
}
