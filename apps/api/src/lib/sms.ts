import { and, desc, eq, gt, inArray, max, sql } from 'drizzle-orm';
import {
  DEFAULT_TEMPLATES,
  firstName,
  gatewayNumber,
  renderTemplate,
  smsMoney,
  smsSegments,
  type AutoEvent,
  type Placeholder,
  type SmsEvent,
  type SmsStatus,
} from '@niinas/shared';
import type { Config } from '../config.js';
import type { Db, DbOrTx } from '../db/client.js';
import { customers, jobLines, jobs, services, smsCreditEntries, smsMessages, smsTemplates, vehicles } from '../db/schema.js';
import { jobPaid, jobTotal } from '../routes/jobs.js';

// ---- the gateway -------------------------------------------------------------

export interface GatewayResult {
  status: SmsStatus;
  /** The gateway's own code. 1701 is "accepted". */
  code: string | null;
  ref: string | null;
  /** Why it did not go, in words a person can act on. */
  error: string | null;
}

export interface SmsGateway {
  /** False until the address and key are in the server settings. */
  readonly configured: boolean;
  /** `msisdn` is digits only, with the country code: 233245510932. Never throws. */
  send(msisdn: string, message: string): Promise<GatewayResult>;
}

/** What Nalo's codes mean for the person looking at the history. */
const NALO_ERRORS: Record<string, string> = {
  '1702': 'The gateway address or a required detail is wrong. Check the server settings.',
  '1703': 'Nalo did not accept the key. Check SMS_API_KEY.',
  '1704': 'Nalo does not accept this kind of message.',
  '1705': 'Nalo rejected the message text.',
  '1706': 'Nalo says that phone number is not valid.',
  '1707': 'Nalo does not recognise the sender name. It must be approved on the Nalo account.',
  '1708': 'The delivery-report setting was refused.',
  '1709': 'Nalo could not check the account details.',
  '1710': 'Nalo had an internal problem. Try again in a moment.',
  '1025': 'Out of SMS credit. Top up on the Nalo portal.',
  '1026': 'Out of SMS credit. Top up on the Nalo portal.',
};

export const OUT_OF_CREDIT_CODES = ['1025', '1026'];

const failed = (code: string | null, error: string): GatewayResult => ({ status: 'failed', code, ref: null, error });

/**
 * Nalo Solutions' send-message API, one request per text. Nalo has two front doors: an address with `/clientapi/` in
 * it takes the details in the web address (a GET), and the other takes a JSON post. Either works; the address decides.
 */
export function createNaloGateway(config: Config, fetchFn: typeof fetch = fetch): SmsGateway {
  const url = config.SMS_API_URL;
  const key = config.SMS_API_KEY;
  return {
    configured: Boolean(url && key),
    async send(msisdn, message) {
      if (!url || !key) return { status: 'skipped', code: null, ref: null, error: 'Texting is not switched on yet: the gateway details are missing.' };
      try {
        const signal = AbortSignal.timeout(10_000);
        let res: Response;
        if (new URL(url).pathname.includes('/clientapi/')) {
          const query = new URLSearchParams({ key, type: '0', destination: msisdn, dlr: '1', source: config.SMS_SENDER_ID, message });
          res = await fetchFn(`${url}?${query}`, { method: 'GET', headers: { accept: 'application/json' }, signal });
        } else {
          res = await fetchFn(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ key, msisdn, message, sender_id: config.SMS_SENDER_ID }),
            signal,
          });
        }
        const text = await res.text();
        let body: { status?: string | number; job_id?: string | number; message?: string } = {};
        try {
          body = JSON.parse(text) as typeof body;
        } catch {
          // Some replies are plain text, like "1701|233245510932|abc". Handled below.
        }
        // Plain-text answers look like "1701|233245510932|abc" when it went and "1706:Invalid Destination" when it did not.
        const piped = /^(\d{4})(?:[|:]|$)/.exec(text.trim());
        const code = body.status !== undefined ? String(body.status) : (piped?.[1] ?? null);
        if (code === '1701') {
          const ref = body.job_id !== undefined ? String(body.job_id) : (text.trim().split('|')[2] ?? null);
          return { status: 'sent', code, ref, error: null };
        }
        if (code) return failed(code, NALO_ERRORS[code] ?? `Nalo refused the text (code ${code}).`);
        const said = text.replaceAll(key, '…').replace(/\s+/g, ' ').trim().slice(0, 80);
        return failed(null, `${res.ok ? 'Nalo sent back an answer we could not read' : `Nalo could not be reached (error ${res.status})`}${said ? `: "${said}"` : '.'}`);
      } catch (e) {
        const timedOut = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
        return failed(null, timedOut ? 'Nalo took too long to answer. The text may or may not have gone: check before sending again.' : 'Could not reach Nalo. Check the internet connection.');
      }
    },
  };
}

// ---- templates and credits ---------------------------------------------------

export interface TemplateState {
  body: string;
  enabled: boolean;
  isDefault: boolean;
  updatedAt: Date | null;
}

export async function loadTemplate(db: DbOrTx, event: AutoEvent): Promise<TemplateState> {
  const [row] = await db.select().from(smsTemplates).where(eq(smsTemplates.event, event));
  return row
    ? { body: row.body, enabled: row.enabled, isDefault: row.body === DEFAULT_TEMPLATES[event], updatedAt: row.updatedAt }
    : { body: DEFAULT_TEMPLATES[event], enabled: true, isDefault: true, updatedAt: null };
}

export async function creditSummary(db: DbOrTx) {
  const [bought] = await db.select({ sum: sql<number>`coalesce(sum(${smsCreditEntries.credits}), 0)::int`, last: max(smsCreditEntries.createdAt) }).from(smsCreditEntries);
  const [used] = await db
    .select({ sum: sql<number>`coalesce(sum(${smsMessages.segments}), 0)::int` })
    .from(smsMessages)
    .where(eq(smsMessages.status, 'sent'));
  const [blocked] = await db
    .select({ id: smsMessages.id })
    .from(smsMessages)
    .where(and(inArray(smsMessages.gatewayCode, OUT_OF_CREDIT_CODES), gt(smsMessages.createdAt, bought?.last ?? new Date(0))))
    .orderBy(desc(smsMessages.id))
    .limit(1);
  const boughtSum = bought?.sum ?? 0;
  const usedSum = used?.sum ?? 0;
  return { bought: boughtSum, used: usedSum, balance: boughtSum - usedSum, outOfCredit: Boolean(blocked) };
}

// ---- sending -----------------------------------------------------------------

export interface DeliverInput {
  event: SmsEvent;
  phone: string;
  body: string;
  customerId?: number | null;
  jobId?: number | null;
  sentBy?: number | null;
  idemKey?: string | null;
  /** Set when the text is not to be sent at all, and why (for example, the customer has not agreed to texts). */
  skip?: string;
}

export interface SmsService {
  readonly gateway: SmsGateway;
  /** Send one text and write down what happened. Returns the record's id. Never throws for a failed send. */
  deliver(input: DeliverInput): Promise<{ id: number; created: boolean }>;
  /** Tell a job's customer about it, if they have a phone, agreed to texts, and the text is switched on. Never throws. */
  notifyJob(event: AutoEvent, jobId: number, opts?: { paymentAmount?: number }): Promise<void>;
  /** Resolves when every automatic text started so far has finished. */
  idle(): Promise<void>;
}

export function createSmsService(opts: { db: Db; gateway: SmsGateway; log?: { error: (e: unknown, msg: string) => void } }): SmsService {
  const { db, gateway } = opts;
  const pending = new Set<Promise<void>>();

  async function sendAndRecord(dbx: DbOrTx, input: DeliverInput) {
    const number = gatewayNumber(input.phone);
    let result: GatewayResult;
    if (input.skip) result = { status: 'skipped', code: null, ref: null, error: input.skip };
    else if (!number) result = failed(null, 'That is not a phone number we can text.');
    else result = await gateway.send(number, input.body);

    const [row] = await dbx
      .insert(smsMessages)
      .values({
        event: input.event,
        status: result.status,
        phone: input.phone,
        body: input.body,
        segments: smsSegments(input.body),
        gatewayCode: result.code,
        gatewayRef: result.ref,
        error: result.error,
        customerId: input.customerId ?? null,
        jobId: input.jobId ?? null,
        sentBy: input.sentBy ?? null,
        idemKey: input.idemKey ?? null,
      })
      .returning({ id: smsMessages.id });
    return { id: row!.id, created: true };
  }

  async function deliver(input: DeliverInput) {
    if (!input.idemKey) return sendAndRecord(db, input);
    const key = input.idemKey;
    // A text costs money and cannot be taken back, so the same key must never reach the gateway twice, even when
    // two taps arrive at the same moment: the second waits here for the first to finish, then finds its record.
    return db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`sms:${key}`}))`);
      const [again] = await tx.select({ id: smsMessages.id }).from(smsMessages).where(eq(smsMessages.idemKey, key));
      if (again) return { id: again.id, created: false };
      return sendAndRecord(tx, input);
    });
  }

  async function notify(event: AutoEvent, jobId: number, o: { paymentAmount?: number }) {
    const [ctx] = await db
      .select({
        plate: vehicles.plate,
        customerId: customers.id,
        name: customers.name,
        phone: customers.phone,
        ok: customers.okToText,
        total: jobTotal,
        paid: jobPaid,
      })
      .from(jobs)
      .innerJoin(vehicles, eq(vehicles.id, jobs.vehicleId))
      .leftJoin(customers, eq(customers.id, vehicles.customerId))
      .where(eq(jobs.id, jobId));
    // A walk-in with no phone has nobody to text, and that is not worth a line in the history.
    if (!ctx || !ctx.customerId || !ctx.phone) return;

    const template = await loadTemplate(db, event);
    if (!template.enabled) return;

    const lines = await db
      .select({ name: services.name })
      .from(jobLines)
      .innerJoin(services, eq(services.id, jobLines.serviceId))
      .where(eq(jobLines.jobId, jobId))
      .orderBy(jobLines.id);

    const values: Record<Placeholder, string> = {
      name: firstName(ctx.name),
      plate: ctx.plate,
      services: lines.map((l) => l.name).join(', '),
      total: smsMoney(ctx.total),
      amount: smsMoney(o.paymentAmount ?? 0),
      balance: smsMoney(Math.max(ctx.total - ctx.paid, 0)),
    };
    await deliver({
      event,
      phone: ctx.phone,
      body: renderTemplate(template.body, values),
      customerId: ctx.customerId,
      jobId,
      skip: ctx.ok ? undefined : 'This customer has not agreed to texts.',
    });
  }

  return {
    gateway,
    deliver,
    notifyJob(event, jobId, o = {}) {
      // The car wash must never wait on, or fail because of, a text message.
      const run = notify(event, jobId, o).catch((e) => opts.log?.error(e, `automatic text "${event}" for job ${jobId} failed`));
      pending.add(run);
      void run.finally(() => pending.delete(run));
      return run;
    },
    async idle() {
      await Promise.all([...pending]);
    },
  };
}
