import { Hono } from 'hono';
import { auth, executorAuth } from './auth.ts';
import { notFound, onError } from './errors.ts';
import { expireLeases } from './pipeline/expire-jobs.ts';
import { admin } from './routes/admin.ts';
import { baskets } from './routes/baskets.ts';
import { jobs } from './routes/jobs.ts';
import { me, pair } from './routes/me.ts';

// Each route group is registered before the next middleware, which it short-circuits once it answers.
const app = new Hono()
  .onError(onError)
  .notFound(notFound)
  .route('/v1/pair', pair) // public
  .use('/v1/jobs/*', executorAuth) // device or LLM relay
  .route('/v1/jobs', jobs)
  .use('/v1/*', auth) // device only
  .route('/v1/me', me)
  .route('/v1/baskets', baskets)
  .route('/v1/admin', admin);

export default {
  fetch: app.fetch,
  // Cron trigger (wrangler.jsonc), once a minute.
  scheduled(_controller, _env, ctx) {
    ctx.waitUntil(expireLeases());
  },
} satisfies ExportedHandler<Env>;
