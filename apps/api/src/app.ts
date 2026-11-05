import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { can, type Permission } from '@niinas/shared';
import { ZodError } from 'zod';
import type { Config } from './config.js';
import type { Db } from './db/client.js';
import { HttpError, forbidden, unauthorized } from './lib/errors.js';
import { SESSION_COOKIE, findSession, type AuthedUser } from './lib/session.js';
import { createNaloGateway, createSmsService, type SmsGateway, type SmsService } from './lib/sms.js';
import { auditRoutes } from './routes/audit.js';
import { attendantRoutes } from './routes/attendants.js';
import { authRoutes } from './routes/auth.js';
import { commissionRoutes } from './routes/commissions.js';
import { customerRoutes, vehicleRoutes } from './routes/customers.js';
import { dailyCloseRoutes } from './routes/dailyClose.js';
import { dashboardRoutes } from './routes/dashboard.js';
import { reportRoutes } from './routes/reports.js';
import { expenseRoutes } from './routes/expenses.js';
import { healthRoutes } from './routes/health.js';
import { jobRoutes } from './routes/jobs.js';
import { receiptRoutes } from './routes/receipts.js';
import { serviceRoutes } from './routes/services.js';
import { smsRoutes } from './routes/sms.js';
import { tipRoutes } from './routes/tips.js';
import { expenseCategoryRoutes } from './routes/expenseCategories.js';
import { paymentMethodRoutes } from './routes/paymentMethods.js';
import { roleRoutes } from './routes/roles.js';
import { userRoutes } from './routes/users.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** The signed-in person, or null if nobody is signed in. */
    user: AuthedUser | null;
  }
  interface FastifyInstance {
    db: Db;
    config: Config;
    /** Customer text messages: the gateway, and the automatic texts for jobs and payments. */
    sms: SmsService;
    /** Route guard: must be signed in. */
    requireAuth: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /** Route guard: must be signed in AND allowed to do `permission`. */
    requirePermission: (permission: Permission) => (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export async function buildApp(opts: { db: Db; config: Config; logger?: boolean; smsGateway?: SmsGateway }): Promise<FastifyInstance> {
  const { db, config } = opts;
  // Behind the reverse proxy every request arrives from 127.0.0.1. Trusting it lets the sign-in rate limit and the
  // logs see each person's real address, instead of treating the whole wash as one very busy visitor.
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 1_000_000, trustProxy: config.NODE_ENV === 'production' });

  app.decorate('db', db);
  app.decorate('config', config);
  app.decorate('sms', createSmsService({ db, gateway: opts.smsGateway ?? createNaloGateway(config), log: { error: (e, msg) => app.log.error(e, msg) } }));
  // Let texts that are still going out finish before the server stops.
  app.addHook('onClose', async () => app.sms.idle());
  app.decorateRequest('user', null);

  await app.register(cookie);
  await app.register(rateLimit, { global: false });

  // Answers carry money and personal details: never let a browser or proxy keep a copy, and never guess their type.
  app.addHook('onSend', async (_req, reply) => {
    reply.header('cache-control', 'no-store');
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
  });

  // Look up who is signed in on every request.
  app.addHook('onRequest', async (req) => {
    const token = req.cookies[SESSION_COOKIE];
    req.user = token ? await findSession(db, token, config) : null;
  });

  // Refuse changes that come from another website. Browsers always send Origin on a POST.
  app.addHook('onRequest', async (req) => {
    if (SAFE_METHODS.has(req.method)) return;
    const origin = req.headers.origin;
    if (origin && !config.WEB_ORIGIN.includes(origin)) {
      throw forbidden('This request came from an unknown site.');
    }
  });

  // Someone on a temporary password may only change it (or sign out). Nothing else, so a handed-out
  // password can never be used to work in the system.
  app.addHook('onRequest', async (req) => {
    if (!req.user?.mustChangePassword) return;
    const path = req.url.split('?')[0] ?? '';
    const allowed = ['/api/auth/me', '/api/auth/logout', '/api/auth/change-password', '/api/health'];
    if (!allowed.includes(path)) {
      throw new HttpError(403, 'password_change_required', 'Choose your own password before you continue.');
    }
  });

  app.decorate('requireAuth', async (req: FastifyRequest) => {
    if (!req.user) throw unauthorized();
  });

  app.decorate('requirePermission', (permission: Permission) => async (req: FastifyRequest) => {
    if (!req.user) throw unauthorized();
    if (!can(req.user.permissions, permission)) throw forbidden();
  });

  app.setErrorHandler((error, req, reply) => {
    if (error instanceof HttpError) {
      return reply.status(error.status).send({ error: { code: error.code, message: error.message } });
    }
    if (error instanceof ZodError) {
      return reply.status(400).send({
        error: { code: 'invalid_input', message: error.issues[0]?.message ?? 'Some details are missing or wrong.' },
      });
    }
    const status = (error as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      const code = status === 429 ? 'too_many_requests' : 'bad_request';
      const message = status === 429 ? 'Too many attempts. Wait a minute and try again.' : 'That request could not be understood.';
      return reply.status(status).send({ error: { code, message } });
    }
    req.log.error(error);
    return reply.status(500).send({ error: { code: 'server_error', message: 'Something went wrong on our side.' } });
  });

  app.setNotFoundHandler((_req, reply) =>
    reply.status(404).send({ error: { code: 'not_found', message: 'That does not exist.' } }),
  );

  await app.register(healthRoutes, { prefix: '/api' });
  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.register(auditRoutes, { prefix: '/api/audit' });
  await app.register(serviceRoutes, { prefix: '/api/services' });
  await app.register(attendantRoutes, { prefix: '/api/attendants' });
  await app.register(userRoutes, { prefix: '/api/users' });
  await app.register(roleRoutes, { prefix: '/api/roles' });
  await app.register(paymentMethodRoutes, { prefix: '/api/payment-methods' });
  await app.register(expenseCategoryRoutes, { prefix: '/api/expense-categories' });
  await app.register(customerRoutes, { prefix: '/api/customers' });
  await app.register(vehicleRoutes, { prefix: '/api/vehicles' });
  await app.register(jobRoutes, { prefix: '/api/jobs' });
  await app.register(receiptRoutes, { prefix: '/api/receipts' });
  await app.register(commissionRoutes, { prefix: '/api/commissions' });
  await app.register(tipRoutes, { prefix: '/api/tips' });
  await app.register(expenseRoutes, { prefix: '/api/expenses' });
  await app.register(dailyCloseRoutes, { prefix: '/api/daily-close' });
  await app.register(dashboardRoutes, { prefix: '/api/dashboard' });
  await app.register(reportRoutes, { prefix: '/api/reports' });
  await app.register(smsRoutes, { prefix: '/api/sms' });

  return app;
}
