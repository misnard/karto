import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { auth, executorAuth } from './auth.ts';
import { notFound, onError } from './errors.ts';
import { runPendingLlmJobs } from './llm/runner.ts';
import { expireLeases } from './pipeline/expire-jobs.ts';
import { admin } from './routes/admin.ts';
import { baskets } from './routes/baskets.ts';
import { jobs } from './routes/jobs.ts';
import { me, pair } from './routes/me.ts';

// Each route group is registered before the next middleware, which it short-circuits once it answers.
const app = new Hono()
  .onError(onError)
  .notFound(notFound)
  // The extension calls a server of the user's choice, with no host permission for it: CORS lets it read the
  // responses. Bearer tokens only, no cookies, so no credentials mode.
  .use(
    '*',
    cors({
      origin: (origin) => (origin.startsWith('chrome-extension://') ? origin : null),
      allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
      allowHeaders: ['authorization', 'content-type'],
      maxAge: 7200,
    }),
  )
  .route('/v1/pair', pair) // public
  .use('/v1/jobs/*', executorAuth) // device or LLM relay
  .route('/v1/jobs', jobs)
  .use('/v1/*', auth) // device only
  .route('/v1/me', me)
  .route('/v1/baskets', baskets)
  .route('/v1/admin', admin);

export default {
  fetch: app.fetch,
  // Cron trigger (wrangler.jsonc), once a minute; node/server.ts calls it on a timer. Leases first, so a requeued
  // llm job runs in the same pass. runPendingLlmJobs does nothing unless LLM_RUNTIME is 'api'.
  scheduled(_controller, _env, ctx) {
    ctx.waitUntil(expireLeases().then(() => runPendingLlmJobs()));
  },
} satisfies ExportedHandler<Env>;
