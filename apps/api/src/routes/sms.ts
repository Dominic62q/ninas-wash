import { and, desc, eq, gte, ilike, like, or, sql, type SQL } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  AUTO_EVENTS,
  EVENT_LABEL,
  EVENT_PLACEHOLDERS,
  EVENT_WHEN,
  LOW_CREDITS,
  creditInput,
  messagesQuery,
  placeholdersIn,
  sendInput,
  templateInput,
  DEFAULT_TEMPLATES,
  type AutoEvent,
  type SmsCreditEntryDto,
  type SmsMessageDto,
  type SmsMessagesPage,
  type SmsOverview,
  type SmsTemplateDto,
} from '@niinas/shared';
import type { DbOrTx } from '../db/client.js';
import { customers, jobs, smsCreditEntries, smsMessages, smsTemplates, users, vehicles } from '../db/schema.js';
import { writeAudit } from '../lib/audit.js';
import { HttpError, conflict, notFound } from '../lib/errors.js';
import { idParams } from '../lib/params.js';
import { creditSummary, loadTemplate } from '../lib/sms.js';

const eventParams = z.object({ event: z.enum(AUTO_EVENTS) });
const resendInput = z.object({ idemKey: z.string().trim().min(8).max(64) });

/** Escape `%`, `_` and `\` so a typed search is matched literally. */
const likeSafe = (s: string) => s.replace(/[\\%_]/g, '\\$&');

async function templateDto(db: DbOrTx, event: AutoEvent): Promise<SmsTemplateDto> {
  const t = await loadTemplate(db, event);
  return {
    event,
    label: EVENT_LABEL[event],
    when: EVENT_WHEN[event],
    body: t.body,
    enabled: t.enabled,
    isDefault: t.isDefault,
    placeholders: [...EVENT_PLACEHOLDERS[event]],
    updatedAt: t.updatedAt ? t.updatedAt.toISOString() : null,
  };
}

const messageSelect = (db: DbOrTx) =>
  db
    .select({
      m: smsMessages,
      customerName: customers.name,
      customerOk: customers.okToText,
      // A failed or skipped text that was sent again later (a resend is a new text with the same words).
      superseded: sql<boolean>`exists (select 1 from sms_messages later where later.customer_id = ${smsMessages.customerId} and later.event = ${smsMessages.event} and later.body = ${smsMessages.body} and later.status = 'sent' and later.id > ${smsMessages.id})`,
      plate: vehicles.plate,
      by: users.name,
    })
    .from(smsMessages)
    .leftJoin(customers, eq(customers.id, smsMessages.customerId))
    .leftJoin(jobs, eq(jobs.id, smsMessages.jobId))
    .leftJoin(vehicles, eq(vehicles.id, jobs.vehicleId))
    .leftJoin(users, eq(users.id, smsMessages.sentBy));

type MessageRow = Awaited<ReturnType<ReturnType<typeof messageSelect>['limit']>>[number];

const messageDto = ({ m, customerName, customerOk, superseded, plate, by }: MessageRow): SmsMessageDto => ({
  id: m.id,
  event: m.event,
  status: m.status,
  phone: m.phone,
  body: m.body,
  segments: m.segments,
  error: m.error,
  customer: m.customerId && customerName ? { id: m.customerId, name: customerName } : null,
  customerOkToText: m.customerId ? customerOk : null,
  superseded: m.status !== 'sent' && !!superseded,
  jobId: m.jobId,
  plate,
  by,
  at: m.createdAt.toISOString(),
});

async function oneMessage(db: DbOrTx, id: number): Promise<SmsMessageDto> {
  const [row] = await messageSelect(db).where(eq(smsMessages.id, id)).limit(1);
  return messageDto(row!);
}

/** Customer texts: the history, the wording of the automatic ones, and the credit record. */
export const smsRoutes: FastifyPluginAsync = async (app) => {
  const view = { preHandler: app.requirePermission('sms.view') };
  const send = { preHandler: app.requirePermission('sms.send') };
  const manage = { preHandler: app.requirePermission('sms.manage') };

  app.get('/overview', view, async (): Promise<SmsOverview> => {
    const credits = await creditSummary(app.db);
    const entries = await app.db
      .select({ e: smsCreditEntries, by: users.name })
      .from(smsCreditEntries)
      .innerJoin(users, eq(users.id, smsCreditEntries.createdBy))
      .orderBy(desc(smsCreditEntries.id))
      .limit(8);
    const [counts] = await app.db
      .select({
        sent: sql<number>`count(*) filter (where ${smsMessages.status} = 'sent')::int`,
        failed: sql<number>`count(*) filter (where ${smsMessages.status} = 'failed')::int`,
        skipped: sql<number>`count(*) filter (where ${smsMessages.status} = 'skipped')::int`,
      })
      .from(smsMessages)
      .where(gte(smsMessages.createdAt, new Date(Date.now() - 30 * 86_400_000)));

    return {
      gateway: { configured: app.sms.gateway.configured, senderId: app.config.SMS_SENDER_ID, topUpUrl: app.config.SMS_TOPUP_URL },
      credits: {
        balance: credits.balance,
        bought: credits.bought,
        used: credits.used,
        low: credits.balance <= LOW_CREDITS,
        outOfCredit: credits.outOfCredit,
        entries: entries.map(({ e, by }): SmsCreditEntryDto => ({ id: e.id, kind: e.kind, credits: e.credits, note: e.note, by, at: e.createdAt.toISOString() })),
      },
      templates: await Promise.all(AUTO_EVENTS.map((event) => templateDto(app.db, event))),
      last30: { sent: counts?.sent ?? 0, failed: counts?.failed ?? 0, skipped: counts?.skipped ?? 0 },
    };
  });

  app.get('/messages', view, async (req): Promise<SmsMessagesPage> => {
    const q = messagesQuery.parse(req.query);
    const where: SQL[] = [];
    if (q.status) where.push(eq(smsMessages.status, q.status));
    if (q.event) where.push(eq(smsMessages.event, q.event));
    if (q.q) {
      const parts: SQL[] = [ilike(smsMessages.body, `%${likeSafe(q.q)}%`), ilike(customers.name, `%${likeSafe(q.q)}%`)];
      const digits = q.q.replace(/\D/g, '');
      if (digits.length >= 3) parts.push(like(smsMessages.phone, `%${likeSafe(digits)}%`));
      const plate = q.q.replace(/[^a-z0-9]/gi, '').toUpperCase();
      if (plate.length >= 2) parts.push(like(vehicles.plateKey, `%${likeSafe(plate)}%`));
      where.push(or(...parts)!);
    }
    const filter = where.length > 0 ? and(...where) : undefined;

    const rows = await messageSelect(app.db).where(filter).orderBy(desc(smsMessages.id)).limit(q.limit).offset(q.offset);
    const [total] = await app.db
      .select({ n: sql<number>`count(*)::int` })
      .from(smsMessages)
      .leftJoin(customers, eq(customers.id, smsMessages.customerId))
      .leftJoin(jobs, eq(jobs.id, smsMessages.jobId))
      .leftJoin(vehicles, eq(vehicles.id, jobs.vehicleId))
      .where(filter);
    return { messages: rows.map(messageDto), total: total?.n ?? 0 };
  });

  // ---- wording -------------------------------------------------------------

  app.put('/templates/:event', manage, async (req) => {
    const { event } = eventParams.parse(req.params);
    const input = templateInput.parse(req.body);
    const allowed: readonly string[] = EVENT_PLACEHOLDERS[event];
    const unknown = placeholdersIn(input.body).find((p) => !allowed.includes(p));
    if (unknown) {
      throw new HttpError(400, 'bad_placeholder', `{${unknown}} cannot be used in the "${EVENT_LABEL[event]}" text. You can use: ${allowed.map((p) => `{${p}}`).join(', ')}.`);
    }

    await app.db.transaction(async (tx) => {
      const before = await loadTemplate(tx, event);
      await tx
        .insert(smsTemplates)
        .values({ event, body: input.body, enabled: input.enabled, updatedBy: req.user!.id })
        .onConflictDoUpdate({ target: smsTemplates.event, set: { body: input.body, enabled: input.enabled, updatedBy: req.user!.id, updatedAt: new Date() } });
      await writeAudit(tx, {
        userId: req.user!.id,
        action: 'sms.template',
        recordTable: 'sms_templates',
        before: { event, body: before.body, enabled: before.enabled },
        after: { event, body: input.body, enabled: input.enabled },
        ip: req.ip,
      });
    });
    return { template: await templateDto(app.db, event) };
  });

  // Back to the wording we ship with.
  app.post('/templates/:event/reset', manage, async (req) => {
    const { event } = eventParams.parse(req.params);
    await app.db.transaction(async (tx) => {
      const before = await loadTemplate(tx, event);
      await tx.delete(smsTemplates).where(eq(smsTemplates.event, event));
      await writeAudit(tx, {
        userId: req.user!.id,
        action: 'sms.template',
        recordTable: 'sms_templates',
        before: { event, body: before.body, enabled: before.enabled },
        after: { event, body: DEFAULT_TEMPLATES[event], enabled: true },
        note: 'Back to the standard wording',
        ip: req.ip,
      });
    });
    return { template: await templateDto(app.db, event) };
  });

  // ---- sending by hand -----------------------------------------------------

  async function sendTo(customerId: number, body: string, idemKey: string, userId: number, ip: string, event: 'manual' | AutoEvent = 'manual') {
    const [customer] = await app.db.select().from(customers).where(eq(customers.id, customerId));
    if (!customer) throw notFound('That customer');
    if (!customer.phone) throw conflict('no_phone', `${customer.name} has no phone number saved.`);
    if (!customer.okToText) throw conflict('not_ok_to_text', `${customer.name} has not agreed to texts. Ask, then tick "OK to text" on their page.`);

    const result = await app.sms.deliver({ event, phone: customer.phone, body, customerId, sentBy: userId, idemKey });
    if (result.created) {
      await writeAudit(app.db, { userId, action: 'sms.send', recordTable: 'sms_messages', recordId: result.id, after: { customerId, event }, ip });
    }
    return result;
  }

  app.post('/send', send, async (req, reply) => {
    const input = sendInput.parse(req.body);
    const result = await sendTo(input.customerId, input.message, input.idemKey, req.user!.id, req.ip);
    return reply.status(result.created ? 201 : 200).send({ message: await oneMessage(app.db, result.id) });
  });

  // Try a failed text again. It goes out as a new text, so the history keeps both.
  app.post('/messages/:id/resend', send, async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const { idemKey } = resendInput.parse(req.body);
    const [old] = await app.db.select().from(smsMessages).where(eq(smsMessages.id, id));
    if (!old) throw notFound('That text');
    if (old.status === 'sent') throw conflict('already_sent', 'That text already went out.');
    if (!old.customerId) throw conflict('no_customer', 'That text was not to a saved customer, so it cannot be sent again.');
    const result = await sendTo(old.customerId, old.body, idemKey, req.user!.id, req.ip, old.event);
    return reply.status(result.created ? 201 : 200).send({ message: await oneMessage(app.db, result.id) });
  });

  // ---- credits -------------------------------------------------------------

  // The credit balance is kept by hand: Nalo has no way to ask it. Record what was bought, or type in
  // what the Nalo portal shows and the difference is written down as a correction.
  app.post('/credits', manage, async (req, reply) => {
    const input = creditInput.parse(req.body);
    const entry = await app.db.transaction(async (tx) => {
      let credits: number;
      let note: string | null;
      if (input.type === 'topup') {
        credits = input.credits;
        note = input.note;
      } else {
        const now = await creditSummary(tx);
        credits = input.balance - now.balance;
        note = `Balance set to ${input.balance} (was ${now.balance})`;
        if (credits === 0) return null;
      }
      const [row] = await tx
        .insert(smsCreditEntries)
        .values({ kind: input.type === 'topup' ? 'topup' : 'adjust', credits, note, createdBy: req.user!.id })
        .returning({ id: smsCreditEntries.id });
      await writeAudit(tx, {
        userId: req.user!.id,
        action: 'sms.credits',
        recordTable: 'sms_credit_entries',
        recordId: row!.id,
        after: { kind: input.type, credits, note },
        ip: req.ip,
      });
      return row!.id;
    });
    const credits = await creditSummary(app.db);
    return reply.status(entry ? 201 : 200).send({ balance: credits.balance });
  });
};
