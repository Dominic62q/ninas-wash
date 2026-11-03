import { and, asc, desc, eq, gte, ilike, inArray, isNotNull, isNull, lt, ne, or, sql, type SQL } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  addLineInput,
  assignInput,
  can,
  createJobInput,
  discountInput,
  dispatchInput,
  formatGHS,
  JOB_STATUSES,
  normalizePlate,
  paymentInput,
  splitEvenly,
  statusInput,
  voidInput,
  type JobCard,
  type JobDetail,
  type JobListRow,
  type PaymentDto,
} from '@niinas/shared';
import type { DbOrTx } from '../db/client.js';
import { attendants, auditLogs, customers, jobLineAttendants, jobLines, jobs, payments, services, users, vehicles } from '../db/schema.js';
import { writeAudit } from '../lib/audit.js';
import { earnCommissions, reverseCommissions } from '../lib/commissions.js';
import { assertDayOpen, dayOf } from '../lib/dayLock.js';
import { HttpError, conflict, notFound } from '../lib/errors.js';
import { isUniqueViolation } from '../lib/helpers.js';
import { idParams } from '../lib/params.js';
import { buildRows } from './customers.js';

const ONE_WHOLE_LINE = 10_000; // basis points

/** The line total after the whole-job discount, never below zero. Written out in full: see customers.ts. */
export const jobTotal = sql<number>`greatest(coalesce((select sum(price_at_sale) from job_lines where job_id = "jobs"."id"), 0) - "jobs"."discount", 0)::int`;

/** Payments received on the job, voided ones left out. */
export const jobPaid = sql<number>`coalesce((select sum(amount) from payments where job_id = "jobs"."id" and voided_at is null), 0)::int`;

const iso = (d: Date | null) => (d ? d.toISOString() : null);

// ---- reading ----------------------------------------------------------------

async function loadJob(db: DbOrTx, id: number): Promise<JobDetail | null> {
  const [row] = await db
    .select({ job: jobs, vehicle: vehicles, creator: users.name })
    .from(jobs)
    .innerJoin(vehicles, eq(vehicles.id, jobs.vehicleId))
    .innerJoin(users, eq(users.id, jobs.createdBy))
    .where(eq(jobs.id, id));
  if (!row) return null;
  const { job, vehicle } = row;

  const lineRows = await db
    .select({ line: jobLines, name: services.name })
    .from(jobLines)
    .innerJoin(services, eq(services.id, jobLines.serviceId))
    .where(eq(jobLines.jobId, id))
    .orderBy(asc(jobLines.id));
  const workers = lineRows.length
    ? await db
        .select({ lineId: jobLineAttendants.jobLineId, id: attendants.id, name: attendants.name, shareBp: jobLineAttendants.shareBp })
        .from(jobLineAttendants)
        .innerJoin(attendants, eq(attendants.id, jobLineAttendants.attendantId))
        .where(inArray(jobLineAttendants.jobLineId, lineRows.map((l) => l.line.id)))
        .orderBy(asc(jobLineAttendants.id))
    : [];

  // "J-20261029-031": the day, then which job of that day this was (voided ones still count).
  const counted = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from jobs
    where (created_at at time zone 'UTC')::date = (select (created_at at time zone 'UTC')::date from jobs where id = ${id})
      and id <= ${id}`);
  const number = `J-${job.createdAt.toISOString().slice(0, 10).replace(/-/g, '')}-${String(counted.rows[0]?.n ?? 0).padStart(3, '0')}`;

  const [owner] = vehicle.customerId ? await db.select().from(customers).where(eq(customers.id, vehicle.customerId)) : [];
  const [customer] = owner ? await buildRows(db, [owner]) : [];

  const [voider] = job.voidedBy ? await db.select({ name: users.name }).from(users).where(eq(users.id, job.voidedBy)) : [];

  const paymentRows = await db.select().from(payments).where(eq(payments.jobId, id)).orderBy(asc(payments.id));
  const peopleIds = [...new Set([...paymentRows.flatMap((p) => [p.recordedBy, p.voidedBy]), job.dispatchOverrideBy].filter((v): v is number => v !== null))];
  const names = new Map(
    (peopleIds.length ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, peopleIds)) : []).map((u) => [u.id, u.name]),
  );
  const paymentList: PaymentDto[] = paymentRows.map((p) => ({
    id: p.id,
    method: p.method,
    amount: p.amount,
    momoReference: p.momoReference,
    at: p.createdAt.toISOString(),
    by: names.get(p.recordedBy) ?? 'Someone',
    voided: p.voidedAt ? { at: p.voidedAt.toISOString(), by: names.get(p.voidedBy!) ?? 'Someone', reason: p.voidReason ?? '' } : null,
  }));
  const paid = paymentList.filter((p) => !p.voided).reduce((sum, p) => sum + p.amount, 0);

  const history = await db
    .select({ id: auditLogs.id, at: auditLogs.at, action: auditLogs.action, before: auditLogs.before, after: auditLogs.after, note: auditLogs.note, by: users.name })
    .from(auditLogs)
    .leftJoin(users, eq(users.id, auditLogs.userId))
    .where(
      or(
        and(eq(auditLogs.recordTable, 'jobs'), eq(auditLogs.recordId, id)),
        paymentRows.length ? and(eq(auditLogs.recordTable, 'payments'), inArray(auditLogs.recordId, paymentRows.map((p) => p.id))) : undefined,
      ),
    )
    .orderBy(asc(auditLogs.id));

  const lines = lineRows.map(({ line, name }) => ({
    id: line.id,
    serviceId: line.serviceId,
    name,
    price: line.priceAtSale,
    attendants: workers.filter((w) => w.lineId === line.id).map(({ id: attendantId, name: n, shareBp }) => ({ id: attendantId, name: n, shareBp })),
  }));
  const subtotal = lines.reduce((sum, l) => sum + l.price, 0);
  const total = Math.max(subtotal - job.discount, 0);

  return {
    id: job.id,
    number,
    status: job.status,
    vehicle: { id: vehicle.id, plate: vehicle.plate, makeModel: vehicle.makeModel, carType: vehicle.carType },
    customer: customer ?? null,
    createdBy: row.creator,
    createdAt: job.createdAt.toISOString(),
    startedAt: iso(job.startedAt),
    completedAt: iso(job.completedAt),
    notes: job.notes,
    lines,
    subtotal,
    discount: job.discount,
    total,
    paid,
    balance: Math.max(total - paid, 0),
    payments: paymentList,
    dispatchedAt: iso(job.dispatchedAt),
    dispatchOverride: job.dispatchOverrideBy ? { by: names.get(job.dispatchOverrideBy) ?? 'Someone', note: job.dispatchOverrideNote ?? '' } : null,
    voided: job.voidedAt ? { at: job.voidedAt.toISOString(), by: voider?.name ?? 'Someone', reason: job.voidReason ?? '' } : null,
    history: history.map((h) => ({
      id: h.id,
      at: h.at.toISOString(),
      by: h.by,
      action: h.action,
      before: (h.before ?? null) as Record<string, unknown> | null,
      after: (h.after ?? null) as Record<string, unknown> | null,
      note: h.note ?? null,
    })),
  };
}

// ---- writing: shared pieces -------------------------------------------------

/** Lock the job row so two people tapping at once cannot both move it. */
async function lockJob(tx: DbOrTx, id: number) {
  const [job] = await tx.select().from(jobs).where(eq(jobs.id, id)).for('update');
  if (!job) throw notFound('That job');
  if (job.voidedAt) throw conflict('job_voided', 'This job was voided.');
  return job;
}

async function activeServices(tx: DbOrTx, ids: number[]) {
  const rows = await tx.select().from(services).where(and(inArray(services.id, ids), eq(services.active, true)));
  if (rows.length !== new Set(ids).size) throw new HttpError(400, 'invalid_service', 'One of those services is not offered any more.');
  return new Map(rows.map((s) => [s.id, s]));
}

async function activeAttendants(tx: DbOrTx, ids: number[]) {
  if (ids.length === 0) return new Map<number, { id: number; name: string }>();
  const rows = await tx
    .select({ id: attendants.id, name: attendants.name })
    .from(attendants)
    .where(and(inArray(attendants.id, ids), eq(attendants.active, true)));
  if (rows.length !== new Set(ids).size) throw new HttpError(400, 'invalid_attendant', 'One of those attendants no longer works here.');
  return new Map(rows.map((a) => [a.id, a]));
}

/** Copies the price and commission rule onto the line, and splits it equally between the people on it. */
async function insertLine(tx: DbOrTx, jobId: number, service: typeof services.$inferSelect, attendantIds: number[]) {
  const [line] = await tx
    .insert(jobLines)
    .values({
      jobId,
      serviceId: service.id,
      priceAtSale: service.price,
      commissionKindAtSale: service.commissionKind,
      commissionValueAtSale: service.commissionValue,
    })
    .returning();
  await insertShares(tx, line!.id, attendantIds);
  return line!;
}

async function insertShares(tx: DbOrTx, lineId: number, attendantIds: number[]) {
  if (attendantIds.length === 0) return;
  const shares = splitEvenly(ONE_WHOLE_LINE, attendantIds.length);
  await tx.insert(jobLineAttendants).values(attendantIds.map((attendantId, i) => ({ jobLineId: lineId, attendantId, shareBp: shares[i]! })));
}

async function linesWithoutAttendants(tx: DbOrTx, jobId: number): Promise<number> {
  const result = await tx.execute<{ n: number }>(sql`
    select count(*)::int as n from job_lines jl
    where jl.job_id = ${jobId} and not exists (select 1 from job_line_attendants a where a.job_line_id = jl.id)`);
  return result.rows[0]?.n ?? 0;
}

const needsAttendant = () =>
  new HttpError(409, 'needs_attendant', 'Put at least one attendant on every service before starting.');

const subtotalOf = async (tx: DbOrTx, jobId: number) => {
  const [row] = await tx.select({ s: sql<number>`coalesce(sum(${jobLines.priceAtSale}), 0)::int` }).from(jobLines).where(eq(jobLines.jobId, jobId));
  return row?.s ?? 0;
};

const paidOf = async (tx: DbOrTx, jobId: number) => {
  const [row] = await tx
    .select({ s: sql<number>`coalesce(sum(${payments.amount}), 0)::int` })
    .from(payments)
    .where(and(eq(payments.jobId, jobId), isNull(payments.voidedAt)));
  return row?.s ?? 0;
};

const tooHigh = () => new HttpError(400, 'discount_too_high', 'The discount cannot be more than the total of the services.');

// ---- routes -----------------------------------------------------------------


interface CardSource {
  job: typeof jobs.$inferSelect;
  vehicle: typeof vehicles.$inferSelect;
  customerName: string | null;
  total: number;
  paid: number;
}

/** Turn job rows into cards: add each job's services and the people working on them. */
async function cardsFor(db: DbOrTx, rows: CardSource[]): Promise<JobListRow[]> {
  const ids = rows.map((r) => r.job.id);
  const lineRows = ids.length
    ? await db
        .select({ id: jobLines.id, jobId: jobLines.jobId, service: services.name })
        .from(jobLines)
        .innerJoin(services, eq(services.id, jobLines.serviceId))
        .where(inArray(jobLines.jobId, ids))
        .orderBy(asc(jobLines.id))
    : [];
  const workers = lineRows.length
    ? await db
        .select({ lineId: jobLineAttendants.jobLineId, name: attendants.name })
        .from(jobLineAttendants)
        .innerJoin(attendants, eq(attendants.id, jobLineAttendants.attendantId))
        .where(inArray(jobLineAttendants.jobLineId, lineRows.map((l) => l.id)))
        .orderBy(asc(jobLineAttendants.id))
    : [];

  return rows.map(({ job, vehicle, customerName, total, paid }) => {
    const mine = lineRows.filter((l) => l.jobId === job.id);
    const names = new Set<string>();
    let missing = false;
    for (const line of mine) {
      const people = workers.filter((w) => w.lineId === line.id);
      if (people.length === 0) missing = true;
      for (const p of people) names.add(p.name);
    }
    return {
      id: job.id,
      status: job.status,
      plate: vehicle.plate,
      makeModel: vehicle.makeModel,
      carType: vehicle.carType,
      customerName,
      createdAt: job.createdAt.toISOString(),
      startedAt: iso(job.startedAt),
      completedAt: iso(job.completedAt),
      services: mine.map((l) => l.service),
      attendants: [...names],
      needsAttendant: missing,
      total,
      paid,
      voided: job.voidedAt !== null,
    };
  });
}

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-10-30').refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), 'Not a real date');

const listQuery = z.object({
  q: z.string().trim().max(60).optional(),
  from: day.optional(),
  to: day.optional(),
  status: z.enum([...JOB_STATUSES, 'voided', 'owing']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});

const boardQuery = z.object({ q: z.string().trim().max(60).optional(), date: day.optional() });

export const jobRoutes: FastifyPluginAsync = async (app) => {
  const work = { preHandler: app.requirePermission('job.create') };

  // Today's jobs plus anything still unfinished from earlier days, or every job from one chosen day.
  app.get('/board', work, async (req) => {
    const { q, date } = boardQuery.parse(req.query);
    const startOfToday = new Date();
    startOfToday.setUTCHours(0, 0, 0, 0); // Ghana keeps UTC all year

    const search = q
      ? or(
          ilike(customers.name, `%${q.replace(/[\\%_]/g, '\\$&')}%`),
          normalizePlate(q).length >= 2 ? sql`${vehicles.plateKey} like ${`%${normalizePlate(q)}%`}` : undefined,
        )
      : undefined;

    const rows = await app.db
      .select({ job: jobs, vehicle: vehicles, customerName: customers.name, total: jobTotal, paid: jobPaid })
      .from(jobs)
      .innerJoin(vehicles, eq(vehicles.id, jobs.vehicleId))
      .leftJoin(customers, eq(customers.id, vehicles.customerId))
      .where(
        and(
          isNull(jobs.voidedAt),
          date
            ? and(gte(jobs.createdAt, new Date(`${date}T00:00:00Z`)), lt(jobs.createdAt, new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000)))
            : or(ne(jobs.status, 'dispatched'), gte(jobs.createdAt, startOfToday)),
          search,
        ),
      )
      .orderBy(asc(jobs.createdAt), asc(jobs.id));

    return { jobs: await cardsFor(app.db, rows) };
  });

  // Every job, newest first, for any dates. Voided jobs only appear when asked for.
  app.get('/', work, async (req) => {
    const { q, from, to, status, limit, offset } = listQuery.parse(req.query);
    if (from && to && to < from) throw new HttpError(400, 'bad_range', 'The end date is before the start date.');

    const filters: (SQL | undefined)[] = [
      status === 'voided' ? isNotNull(jobs.voidedAt) : isNull(jobs.voidedAt),
      status === 'owing'
        ? and(inArray(jobs.status, ['completed', 'dispatched']), sql`${jobTotal} > ${jobPaid}`)
        : status && status !== 'voided'
          ? eq(jobs.status, status)
          : undefined,
      // Ghana keeps UTC all year, so a calendar day is a UTC day.
      from ? gte(jobs.createdAt, new Date(`${from}T00:00:00Z`)) : undefined,
      to ? lt(jobs.createdAt, new Date(Date.parse(`${to}T00:00:00Z`) + 86_400_000)) : undefined,
      q
        ? or(
            ilike(customers.name, `%${q.replace(/[\\%_]/g, '\\$&')}%`),
            normalizePlate(q).length >= 2 ? sql`${vehicles.plateKey} like ${`%${normalizePlate(q)}%`}` : undefined,
          )
        : undefined,
    ];
    const where = and(...filters);

    const rows = await app.db
      .select({ job: jobs, vehicle: vehicles, customerName: customers.name, total: jobTotal, paid: jobPaid })
      .from(jobs)
      .innerJoin(vehicles, eq(vehicles.id, jobs.vehicleId))
      .leftJoin(customers, eq(customers.id, vehicles.customerId))
      .where(where)
      .orderBy(desc(jobs.createdAt), desc(jobs.id))
      .limit(limit)
      .offset(offset);

    const [totals] = await app.db
      .select({ n: sql<number>`count(*)::int`, sum: sql<number>`coalesce(sum(${jobTotal}), 0)::int` })
      .from(jobs)
      .innerJoin(vehicles, eq(vehicles.id, jobs.vehicleId))
      .leftJoin(customers, eq(customers.id, vehicles.customerId))
      .where(where);

    return { jobs: await cardsFor(app.db, rows), total: totals?.n ?? 0, sum: totals?.sum ?? 0 };
  });

  app.get('/:id', work, async (req) => {
    const { id } = idParams.parse(req.params);
    const job = await loadJob(app.db, id);
    if (!job) throw notFound('That job');
    return { job };
  });

  app.post('/', work, async (req, reply) => {
    const input = createJobInput.parse(req.body);
    const actor = { userId: req.user!.id, ip: req.ip };
    const plateKey = normalizePlate(input.plate);

    try {
      const jobId = await app.db.transaction(async (tx) => {
        const serviceById = await activeServices(tx, input.lines.map((l) => l.serviceId));
        const attendantById = await activeAttendants(tx, input.lines.flatMap((l) => l.attendantIds));

        const subtotal = input.lines.reduce((sum, l) => sum + serviceById.get(l.serviceId)!.price, 0);
        if (input.discount > subtotal) throw tooHigh();
        if (input.start && input.lines.some((l) => l.attendantIds.length === 0)) throw needsAttendant();

        // The car: found by plate, or added now. A car can only be on the board once at a time.
        const [found] = await tx.select().from(vehicles).where(eq(vehicles.plateKey, plateKey)).for('update');
        let vehicle = found;
        if (vehicle) {
          const [open] = await tx
            .select({ id: jobs.id })
            .from(jobs)
            .where(and(eq(jobs.vehicleId, vehicle.id), isNull(jobs.voidedAt), inArray(jobs.status, ['pending', 'in_progress'])))
            .limit(1);
          if (open) throw conflict('vehicle_has_open_job', 'That car already has a job on the board.');
        }

        let customerId = vehicle?.customerId ?? null;
        if (!customerId && input.customer) {
          const [created] = await tx.insert(customers).values(input.customer).returning();
          customerId = created!.id;
          await writeAudit(tx, { ...actor, action: 'customer.create', recordTable: 'customers', recordId: customerId, after: input.customer });
        }

        if (!vehicle) {
          [vehicle] = await tx
            .insert(vehicles)
            .values({ plate: input.plate, plateKey, customerId, makeModel: input.makeModel, carType: input.carType })
            .returning();
          await writeAudit(tx, {
            ...actor,
            action: 'vehicle.create',
            recordTable: 'vehicles',
            recordId: vehicle!.id,
            after: { plate: input.plate, customerId, makeModel: input.makeModel, carType: input.carType },
          });
        } else if (customerId !== vehicle.customerId || (!vehicle.makeModel && input.makeModel) || (!vehicle.carType && input.carType)) {
          // A walk-in car that now has an owner, or details we did not have before.
          [vehicle] = await tx
            .update(vehicles)
            .set({ customerId, makeModel: vehicle.makeModel ?? input.makeModel, carType: vehicle.carType ?? input.carType })
            .where(eq(vehicles.id, vehicle.id))
            .returning();
        }

        const now = new Date();
        const [job] = await tx
          .insert(jobs)
          .values({
            vehicleId: vehicle!.id,
            createdBy: actor.userId,
            discount: input.discount,
            notes: input.notes,
            ...(input.start ? { status: 'in_progress' as const, startedAt: now } : {}),
          })
          .returning();

        for (const l of input.lines) await insertLine(tx, job!.id, serviceById.get(l.serviceId)!, l.attendantIds);

        await writeAudit(tx, {
          ...actor,
          action: 'job.create',
          recordTable: 'jobs',
          recordId: job!.id,
          after: {
            plate: vehicle!.plate,
            services: input.lines.map((l) => ({
              service: serviceById.get(l.serviceId)!.name,
              price: serviceById.get(l.serviceId)!.price,
              attendants: l.attendantIds.map((a) => attendantById.get(a)!.name),
            })),
            discount: input.discount,
          },
        });
        if (input.start) {
          await writeAudit(tx, { ...actor, action: 'job.status', recordTable: 'jobs', recordId: job!.id, before: { status: 'pending' }, after: { status: 'in_progress' } });
        }
        return job!.id;
      });
      // The text goes out after the job is safely saved, and the cashier never waits for it.
      void app.sms.notifyJob('job_booked', jobId);
      return reply.status(201).send({ job: await loadJob(app.db, jobId) });
    } catch (e) {
      // Two people adding the same new plate at the same moment: the second one lands here.
      if (isUniqueViolation(e)) throw conflict('vehicle_has_open_job', 'Someone just added this car. Check the board.');
      throw e;
    }
  });

  // Add another service to a job that is still being worked on. Lines are never removed: fix a mistake by voiding the job.
  app.post('/:id/lines', work, async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const input = addLineInput.parse(req.body);

    await app.db.transaction(async (tx) => {
      const job = await lockJob(tx, id);
      if (job.status !== 'pending' && job.status !== 'in_progress') {
        throw conflict('job_closed', 'This job is closed.');
      }
      const serviceById = await activeServices(tx, [input.serviceId]);
      const people = await activeAttendants(tx, input.attendantIds);
      const [dup] = await tx
        .select({ id: jobLines.id })
        .from(jobLines)
        .where(and(eq(jobLines.jobId, id), eq(jobLines.serviceId, input.serviceId)))
        .limit(1);
      if (dup) throw conflict('duplicate_line', 'That service is already on this job.');

      const service = serviceById.get(input.serviceId)!;
      await insertLine(tx, id, service, input.attendantIds);
      await writeAudit(tx, {
        userId: req.user!.id,
        action: 'job.add_line',
        recordTable: 'jobs',
        recordId: id,
        after: { service: service.name, price: service.price, attendants: input.attendantIds.map((a) => people.get(a)!.name) },
        ip: req.ip,
      });
    });
    return reply.status(201).send({ job: await loadJob(app.db, id) });
  });

  // "Assign": put people on a service that has nobody yet. Once set, a line's team is fixed (the records are never edited).
  app.put('/:id/lines/:lineId/attendants', work, async (req) => {
    const { id, lineId } = z.object({ id: z.coerce.number().int().positive(), lineId: z.coerce.number().int().positive() }).parse(req.params);
    const { attendantIds } = assignInput.parse(req.body);

    await app.db.transaction(async (tx) => {
      const job = await lockJob(tx, id);
      if (job.status === 'dispatched') throw conflict('job_closed', 'This job has been handed over.');
      const [line] = await tx
        .select({ line: jobLines, name: services.name })
        .from(jobLines)
        .innerJoin(services, eq(services.id, jobLines.serviceId))
        .where(and(eq(jobLines.id, lineId), eq(jobLines.jobId, id)));
      if (!line) throw notFound('That service on this job');
      const [existing] = await tx.select({ id: jobLineAttendants.id }).from(jobLineAttendants).where(eq(jobLineAttendants.jobLineId, lineId)).limit(1);
      if (existing) {
        throw conflict('already_assigned', 'Attendants are already set. To change them, void the job and enter it again.');
      }
      const people = await activeAttendants(tx, attendantIds);
      await insertShares(tx, lineId, attendantIds);
      await writeAudit(tx, {
        userId: req.user!.id,
        action: 'job.assign',
        recordTable: 'jobs',
        recordId: id,
        after: { service: line.name, attendants: attendantIds.map((a) => people.get(a)!.name) },
        ip: req.ip,
      });
    });
    return { job: await loadJob(app.db, id) };
  });

  app.patch('/:id', work, async (req) => {
    const { id } = idParams.parse(req.params);
    const { discount } = discountInput.parse(req.body);

    await app.db.transaction(async (tx) => {
      const job = await lockJob(tx, id);
      if (job.status !== 'pending' && job.status !== 'in_progress') {
        throw conflict('job_closed', 'This job is closed.');
      }
      const subtotal = await subtotalOf(tx, id);
      if (discount > subtotal) throw tooHigh();
      if (discount === job.discount) return;
      if (subtotal - discount < (await paidOf(tx, id))) {
        throw new HttpError(400, 'discount_below_paid', 'That would take the total below what was already paid.');
      }
      await tx.update(jobs).set({ discount }).where(eq(jobs.id, id));
      await writeAudit(tx, {
        userId: req.user!.id,
        action: 'job.discount',
        recordTable: 'jobs',
        recordId: id,
        before: { discount: job.discount },
        after: { discount },
        ip: req.ip,
      });
    });
    return { job: await loadJob(app.db, id) };
  });

  // pending -> in progress -> completed, one step at a time and never backwards.
  app.post('/:id/status', { preHandler: app.requirePermission('job.advance') }, async (req) => {
    const { id } = idParams.parse(req.params);
    const { to } = statusInput.parse(req.body);
    const from = to === 'in_progress' ? 'pending' : 'in_progress';

    await app.db.transaction(async (tx) => {
      const job = await lockJob(tx, id);
      if (job.status !== from) {
        // Someone else (or a second tap) already moved it.
        throw conflict('wrong_status', job.status === to ? 'This job has already moved on.' : `This job is ${job.status.replace('_', ' ')}, so it cannot go to ${to.replace('_', ' ')}.`);
      }
      if ((await linesWithoutAttendants(tx, id)) > 0) throw needsAttendant();
      const now = new Date();
      await tx
        .update(jobs)
        .set(to === 'in_progress' ? { status: to, startedAt: now } : { status: to, completedAt: now })
        .where(eq(jobs.id, id));
      if (to === 'completed') await earnCommissions(tx, id);
      await writeAudit(tx, {
        userId: req.user!.id,
        action: 'job.status',
        recordTable: 'jobs',
        recordId: id,
        before: { status: from },
        after: { status: to },
        ip: req.ip,
      });
    });
    if (to === 'completed') void app.sms.notifyJob('job_ready', id);
    return { job: await loadJob(app.db, id) };
  });

  // Take a payment. Part cash and part MoMo is two payments. The same key twice saves once.
  app.post('/:id/payments', { preHandler: app.requirePermission('payment.record') }, async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const input = paymentInput.parse(req.body);

    const created = await app.db.transaction(async (tx) => {
      const job = await lockJob(tx, id);
      const [again] = await tx.select().from(payments).where(eq(payments.idemKey, input.idemKey));
      if (again) {
        if (again.jobId !== id) throw conflict('key_reused', 'That payment was already saved on another job.');
        return false;
      }
      await assertDayOpen(tx, dayOf());
      const owed = Math.max((await subtotalOf(tx, id)) - job.discount, 0) - (await paidOf(tx, id));
      if (owed <= 0) throw conflict('nothing_owed', 'Nothing is owed on this job.');
      if (input.amount > owed) throw new HttpError(400, 'too_much', `Only ${formatGHS(owed)} is still owed.`);
      const [row] = await tx
        .insert(payments)
        .values({ jobId: id, method: input.method, amount: input.amount, momoReference: input.momoReference, idemKey: input.idemKey, recordedBy: req.user!.id })
        .returning();
      await writeAudit(tx, {
        userId: req.user!.id,
        action: 'payment.record',
        recordTable: 'payments',
        recordId: row!.id,
        after: { method: input.method, amount: input.amount, momoReference: input.momoReference },
        ip: req.ip,
      });
      return true;
    });
    // A repeated tap on the same payment saved nothing new, so it texts nothing new.
    if (created) void app.sms.notifyJob('payment_received', id, { paymentAmount: input.amount });
    return reply.status(created ? 201 : 200).send({ job: await loadJob(app.db, id) });
  });

  // A wrong payment is voided with a reason and entered again. It is never edited or deleted.
  app.post('/:id/payments/:paymentId/void', { preHandler: app.requirePermission('payment.void') }, async (req) => {
    const { id, paymentId } = z.object({ id: idParams.shape.id, paymentId: z.coerce.number().int().positive() }).parse(req.params);
    const { reason } = voidInput.parse(req.body);

    await app.db.transaction(async (tx) => {
      await lockJob(tx, id);
      const [payment] = await tx.select().from(payments).where(and(eq(payments.id, paymentId), eq(payments.jobId, id))).for('update');
      if (!payment) throw notFound('That payment');
      if (payment.voidedAt) throw conflict('already_voided', 'That payment was already voided.');
      await assertDayOpen(tx, dayOf(payment.createdAt));
      await tx.update(payments).set({ voidedAt: new Date(), voidedBy: req.user!.id, voidReason: reason }).where(eq(payments.id, paymentId));
      await writeAudit(tx, {
        userId: req.user!.id,
        action: 'payment.void',
        recordTable: 'payments',
        recordId: paymentId,
        before: { method: payment.method, amount: payment.amount },
        note: reason,
        ip: req.ip,
      });
    });
    return { job: await loadJob(app.db, id) };
  });

  // The car leaves. It must be finished and paid for. A manager or owner can release it with a balance, with a note.
  app.post('/:id/dispatch', { preHandler: app.requirePermission('job.dispatch') }, async (req) => {
    const { id } = idParams.parse(req.params);
    const { note } = dispatchInput.parse(req.body ?? {});

    await app.db.transaction(async (tx) => {
      const job = await lockJob(tx, id);
      if (job.status !== 'completed') {
        throw conflict('wrong_status', job.status === 'dispatched' ? 'This car has already been dispatched.' : 'Finish the wash before dispatching.');
      }
      const owed = Math.max((await subtotalOf(tx, id)) - job.discount, 0) - (await paidOf(tx, id));
      const withBalance = owed > 0;
      if (withBalance) {
        if (!can(req.user!.role, 'job.dispatch_with_balance')) {
          throw new HttpError(403, 'balance_owed', `${formatGHS(owed)} is still owed. A manager can release the car.`);
        }
        if (!note) throw new HttpError(400, 'note_needed', 'Say why the car is leaving with a balance.');
      }
      await tx
        .update(jobs)
        .set({
          status: 'dispatched',
          dispatchedAt: new Date(),
          ...(withBalance ? { dispatchOverrideBy: req.user!.id, dispatchOverrideNote: note } : {}),
        })
        .where(eq(jobs.id, id));
      await writeAudit(tx, {
        userId: req.user!.id,
        action: 'job.dispatch',
        recordTable: 'jobs',
        recordId: id,
        before: { status: 'completed' },
        after: { status: 'dispatched', owed },
        ...(withBalance ? { note: note! } : {}),
        ip: req.ip,
      });
    });
    return { job: await loadJob(app.db, id) };
  });

  // Void keeps the whole record. It says who, when and why, and the job leaves the board and the customer's totals.
  app.post('/:id/void', { preHandler: app.requirePermission('job.void') }, async (req) => {
    const { id } = idParams.parse(req.params);
    const { reason } = voidInput.parse(req.body);

    await app.db.transaction(async (tx) => {
      const job = await lockJob(tx, id);
      const [paid] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(payments)
        .where(and(eq(payments.jobId, id), isNull(payments.voidedAt)));
      if ((paid?.n ?? 0) > 0) throw conflict('has_payments', 'This job has payments. Void the payments first.');
      await tx.update(jobs).set({ voidedAt: new Date(), voidedBy: req.user!.id, voidReason: reason }).where(eq(jobs.id, id));
      await reverseCommissions(tx, id);
      await writeAudit(tx, {
        userId: req.user!.id,
        action: 'job.void',
        recordTable: 'jobs',
        recordId: id,
        before: { status: job.status },
        note: reason,
        ip: req.ip,
      });
    });
    return { job: await loadJob(app.db, id) };
  });
};
