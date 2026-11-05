import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { ReceiptDto } from '@niinas/shared';
import { jobReceiptLinks } from '../db/schema.js';
import { writeAudit } from '../lib/audit.js';
import { notFound } from '../lib/errors.js';
import { idParams } from '../lib/params.js';
import { loadJob } from './jobs.js';

const tokenParams = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{20,64}$/) });

/**
 * The receipt a customer can open from a link. Making a link needs the same access as working on a job;
 * opening one needs nothing but the link, so it shows the bill and nothing about who the customer is or how they paid.
 */
export const receiptRoutes: FastifyPluginAsync = async (app) => {
  // The link for a job. The same job always gets the same link, so sharing twice does not make two.
  app.post('/for-job/:id', { preHandler: app.requirePermission('job.create') }, async (req) => {
    const { id } = idParams.parse(req.params);
    const job = await loadJob(app.db, id);
    if (!job) throw notFound('That job');
    const token = await app.db.transaction(async (tx) => {
      const [existing] = await tx.select({ token: jobReceiptLinks.token }).from(jobReceiptLinks).where(eq(jobReceiptLinks.jobId, id));
      if (existing) return existing.token;
      const fresh = randomBytes(18).toString('base64url');
      const [created] = await tx
        .insert(jobReceiptLinks)
        .values({ jobId: id, token: fresh, createdBy: req.user!.id })
        .onConflictDoNothing()
        .returning({ token: jobReceiptLinks.token });
      if (!created) {
        // Someone else made it a moment ago.
        const [again] = await tx.select({ token: jobReceiptLinks.token }).from(jobReceiptLinks).where(eq(jobReceiptLinks.jobId, id));
        return again!.token;
      }
      await writeAudit(tx, { userId: req.user!.id, action: 'job.receipt_link', recordTable: 'jobs', recordId: id, note: 'Made a link to share the receipt', ip: req.ip });
      return created.token;
    });
    return { token };
  });

  app.get('/:token', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { token } = tokenParams.parse(req.params);
    const [link] = await app.db.select({ jobId: jobReceiptLinks.jobId }).from(jobReceiptLinks).where(eq(jobReceiptLinks.token, token));
    // The same answer for a wrong token as for no token: nothing to learn by trying.
    if (!link) throw notFound('That receipt');
    const job = await loadJob(app.db, link.jobId);
    if (!job) throw notFound('That receipt');
    reply.header('x-robots-tag', 'noindex, nofollow');
    const receipt: ReceiptDto = {
      number: job.number,
      at: job.createdAt,
      plate: job.vehicle.plate,
      status: job.status,
      voided: job.voided !== null,
      lines: job.lines.map((l) => ({ name: l.name, quantity: l.quantity, price: l.price })),
      subtotal: job.subtotal,
      discount: job.discount,
      total: job.total,
      paid: job.paid,
      balance: job.balance,
    };
    return { receipt };
  });
};
