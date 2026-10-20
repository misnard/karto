import { CreateUserRequestSchema, type CreateUserResponse } from '@karto/contracts';
import { Hono } from 'hono';
import { type AppEnv, sha256Hex } from '../auth.ts';
import { createUser, getMe } from '../db/users.ts';
import { AppError, readBody } from '../errors.ts';
import { newPairingCode } from '../pairing-code.ts';

/** Admin routes. They create users and codes, and never read another user's data. */
export const admin = new Hono<AppEnv>()
  .use(async (c, next) => {
    if (!(await getMe(c.var.userId))?.user.isAdmin) throw new AppError('forbidden', 403, 'Admin only');
    await next();
  })
  .post('/users', async (c) => {
    const { name } = await readBody(c, CreateUserRequestSchema);
    const { code, expiresAt } = newPairingCode();
    const user = await createUser(name, await sha256Hex(code), expiresAt);
    return c.json({ user, code, expiresAt } satisfies CreateUserResponse, 201);
  });
