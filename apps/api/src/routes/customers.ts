import { and, asc, desc, eq, exists, ilike, inArray, isNull, like, or, sql, type SQL } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  customerInput,
  customerUpdate,
  normalizePhone,
  normalizePlate,
  vehicleInput,
  vehicleUpdate,
  type CustomerDetail,
  type CustomerRow,
  type CustomerStats,
  type VehicleDto,
  type VehicleInput,
  type VisitDto,
} from '@niinas/shared';
import type { DbOrTx } from '../db/client.js';
import { customers, jobLines, jobs, payments, services, vehicles } from '../db/schema.js';
import { writeAudit } from '../lib/audit.js';
import { conflict, notFound } from '../lib/errors.js';
import { changedFields } from '../lib/helpers.js';
import { idParams } from '../lib/params.js';

type CustomerRecord = typeof customers.$inferSelect;
type VehicleRecord = typeof vehicles.$inferSelect;

const vehicleDto = (v: VehicleRecord): VehicleDto => ({ id: v.id, plate: v.plate, makeModel: v.makeModel, carType: v.carType });

/** Escape `%`, `_` and `\` so a typed search is matched literally. */
const likeSafe = (s: string) => s.replace(/[\\%_]/g, '\\$&');

const listQuery = z.object({
  q: z.string().trim().max(60).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});

/** Name, phone digits, or number plate, whichever the person typed. */
function searchFilter(q: string | undefined): SQL | undefined {
  if (!q) return undefined;
  const parts: SQL[] = [ilike(customers.name, `%${likeSafe(q)}%`)];
  const digits = q.replace(/\D/g, '');
  if (digits.length >= 3) parts.push(like(customers.phone, `%${likeSafe(digits)}%`));
  const plate = normalizePlate(q);
  if (plate.length >= 2) {
    parts.push(
      exists(
        // Looked up through the vehicle, so a plate search finds the owner.
        // Columns are written out in full: inside a subquery drizzle would print a bare "id".
        sql`(select 1 from vehicles pv where pv.customer_id = "customers"."id" and pv.plate_key like ${`%${likeSafe(plate)}%`})`,
      ),
    );
  }
  return or(...parts);
}

/** Add each customer's cars, visit count, last visit and total paid. Voided jobs and payments are left out. */
export async function buildRows(db: DbOrTx, records: CustomerRecord[]): Promise<CustomerRow[]> {
  if (records.length === 0) return [];
  const ids = records.map((c) => c.id);

  const [cars, visitRows, spentRows] = await Promise.all([
    db.select().from(vehicles).where(inArray(vehicles.customerId, ids)).orderBy(asc(vehicles.id)),
    db
      .select({
        customerId: vehicles.customerId,
        visits: sql<number>`count(${jobs.id})::int`,
        lastVisit: sql<Date | null>`max(${jobs.createdAt})`,
      })
      .from(vehicles)
      .innerJoin(jobs, and(eq(jobs.vehicleId, vehicles.id), isNull(jobs.voidedAt)))
      .where(inArray(vehicles.customerId, ids))
      .groupBy(vehicles.customerId),
    db
      .select({ customerId: vehicles.customerId, spent: sql<number>`coalesce(sum(${payments.amount}), 0)::int` })
      .from(vehicles)
      .innerJoin(jobs, and(eq(jobs.vehicleId, vehicles.id), isNull(jobs.voidedAt)))
      .innerJoin(payments, and(eq(payments.jobId, jobs.id), isNull(payments.voidedAt)))
      .where(inArray(vehicles.customerId, ids))
      .groupBy(vehicles.customerId),
  ]);

  const carsBy = new Map<number, VehicleDto[]>();
  for (const v of cars) carsBy.set(v.customerId!, [...(carsBy.get(v.customerId!) ?? []), vehicleDto(v)]);
  const visitBy = new Map(visitRows.map((r) => [r.customerId, r]));
  const spentBy = new Map(spentRows.map((r) => [r.customerId, r.spent]));

  return records.map((c) => ({
    id: c.id,
    name: c.name,
    phone: c.phone,
    okToText: c.okToText,
    createdAt: c.createdAt.toISOString(),
    vehicles: carsBy.get(c.id) ?? [],
    visits: visitBy.get(c.id)?.visits ?? 0,
    lastVisit: visitBy.get(c.id)?.lastVisit ? new Date(visitBy.get(c.id)!.lastVisit!).toISOString() : null,
    spent: spentBy.get(c.id) ?? 0,
  }));
}

/**
 * Put a car on a customer. A plate already on file for someone else is refused, with their name.
 * A plate that exists only as a walk-in car (no customer) is claimed by this customer.
 */
async function attachVehicle(
  tx: DbOrTx,
  customerId: number,
  input: VehicleInput,
  actor: { userId: number; ip: string },
): Promise<VehicleRecord> {
  const plateKey = normalizePlate(input.plate);
  const [existing] = await tx
    .select({ vehicle: vehicles, owner: customers.name })
    .from(vehicles)
    .leftJoin(customers, eq(customers.id, vehicles.customerId))
    .where(eq(vehicles.plateKey, plateKey))
    .for('update', { of: vehicles });

  if (existing && existing.vehicle.customerId !== null) {
    const same = existing.vehicle.customerId === customerId;
    throw conflict(
      'plate_taken',
      same ? 'That car is already on this customer.' : `That plate is already on file for ${existing.owner}.`,
    );
  }

  if (existing) {
    const [claimed] = await tx
      .update(vehicles)
      .set({
        customerId,
        makeModel: input.makeModel ?? existing.vehicle.makeModel,
        carType: input.carType ?? existing.vehicle.carType,
      })
      .where(eq(vehicles.id, existing.vehicle.id))
      .returning();
    await writeAudit(tx, {
      userId: actor.userId,
      action: 'vehicle.claim',
      recordTable: 'vehicles',
      recordId: claimed!.id,
      before: { customerId: null },
      after: { customerId },
      ip: actor.ip,
    });
    return claimed!;
  }

  const [created] = await tx
    .insert(vehicles)
    .values({ plate: input.plate, plateKey, customerId, makeModel: input.makeModel, carType: input.carType })
    .returning();
  await writeAudit(tx, {
    userId: actor.userId,
    action: 'vehicle.create',
    recordTable: 'vehicles',
    recordId: created!.id,
    after: { plate: input.plate, customerId, makeModel: input.makeModel, carType: input.carType },
    ip: actor.ip,
  });
  return created!;
}

/** Spreadsheets run text that starts with = + - or @ as a formula. A leading quote stops that. */
function csvCell(value: string | number | boolean | null): string {
  let s = value === null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const customerRoutes: FastifyPluginAsync = async (app) => {
  const manage = { preHandler: app.requirePermission('customer.manage') };

  app.get('/', manage, async (req) => {
    const { q, limit, offset } = listQuery.parse(req.query);
    const where = searchFilter(q);

    const lastVisitSort = sql`(
      select max(j.created_at) from ${jobs} j join ${vehicles} v on v.id = j.vehicle_id
      where v.customer_id = "customers"."id" and j.voided_at is null
    )`;
    const [records, [count]] = await Promise.all([
      app.db.select().from(customers).where(where).orderBy(sql`${lastVisitSort} desc nulls last`, desc(customers.id)).limit(limit).offset(offset),
      app.db.select({ n: sql<number>`count(*)::int` }).from(customers).where(where),
    ]);
    return { rows: await buildRows(app.db, records), total: count?.n ?? 0 };
  });

  app.get('/stats', manage, async (): Promise<CustomerStats> => {
    const result = await app.db.execute<{
      total: number;
      new_this_week: number;
      ok_pct: number | null;
      seen: number;
      came_back: number;
    }>(sql`
      with month_start as (select date_trunc('month', now()) as at),
      seen as (
        select distinct v.customer_id
        from ${jobs} j join ${vehicles} v on v.id = j.vehicle_id, month_start
        where v.customer_id is not null and j.voided_at is null and j.created_at >= month_start.at
      ),
      came_back as (
        select s.customer_id from seen s
        where exists (
          select 1 from ${jobs} j join ${vehicles} v on v.id = j.vehicle_id, month_start
          where v.customer_id = s.customer_id and j.voided_at is null and j.created_at < month_start.at
        )
      )
      select
        (select count(*) from ${customers})::int as total,
        (select count(*) from ${customers} where created_at > now() - interval '7 days')::int as new_this_week,
        (select round(100.0 * avg(ok_to_text::int)) from ${customers})::int as ok_pct,
        (select count(*) from seen)::int as seen,
        (select count(*) from came_back)::int as came_back
    `);
    const r = result.rows[0]!;
    return {
      total: r.total,
      newThisWeek: r.new_this_week,
      cameBackThisMonthPct: r.seen > 0 ? Math.round((100 * r.came_back) / r.seen) : null,
      okToTextPct: r.ok_pct,
    };
  });

  // Personal data leaves the system here, so it is owner-only and always logged.
  app.get('/export.csv', { preHandler: app.requirePermission('customer.export') }, async (req, reply) => {
    const records = await app.db.select().from(customers).orderBy(asc(customers.name));
    const rows = await buildRows(app.db, records);
    const header = ['Name', 'Phone', 'OK to text', 'Plates', 'Visits', 'Last visit', 'Spent (GHS)'];
    const lines = rows.map((r) =>
      [
        r.name,
        r.phone,
        r.okToText ? 'Yes' : 'No',
        r.vehicles.map((v) => v.plate).join(' / '),
        r.visits,
        r.lastVisit ? r.lastVisit.slice(0, 10) : '',
        (r.spent / 100).toFixed(2),
      ]
        .map(csvCell)
        .join(','),
    );
    await writeAudit(app.db, { userId: req.user!.id, action: 'customer.export', note: `${rows.length} customers`, ip: req.ip });
    const day = new Date().toISOString().slice(0, 10);
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="niinas-customers-${day}.csv"`)
      .send(`﻿${[header.join(','), ...lines].join('\r\n')}\r\n`);
  });

  app.post('/', manage, async (req, reply) => {
    const input = customerInput.parse(req.body);
    const actor = { userId: req.user!.id, ip: req.ip };

    const record = await app.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(customers)
        .values({ name: input.name, phone: input.phone, okToText: input.okToText })
        .returning();
      await writeAudit(tx, {
        userId: actor.userId,
        action: 'customer.create',
        recordTable: 'customers',
        recordId: created!.id,
        after: { name: input.name, phone: input.phone, okToText: input.okToText },
        ip: actor.ip,
      });
      if (input.vehicle) await attachVehicle(tx, created!.id, input.vehicle, actor);
      return created!;
    });
    const [row] = await buildRows(app.db, [record]);
    return reply.status(201).send({ customer: row });
  });

  app.get('/:id', manage, async (req): Promise<CustomerDetail> => {
    const { id } = idParams.parse(req.params);
    const [record] = await app.db.select().from(customers).where(eq(customers.id, id));
    if (!record) throw notFound('That customer');
    const [customer] = await buildRows(app.db, [record]);

    const total = sql<number>`greatest(coalesce((select sum(price_at_sale) from ${jobLines} where job_id = ${jobs.id}), 0) - ${jobs.discount}, 0)::int`;
    const paid = sql<number>`coalesce((select sum(amount) from ${payments} where job_id = ${jobs.id} and voided_at is null), 0)::int`;
    const jobRows = await app.db
      .select({ id: jobs.id, at: jobs.createdAt, status: jobs.status, voidedAt: jobs.voidedAt, total, paid })
      .from(jobs)
      .innerJoin(vehicles, eq(vehicles.id, jobs.vehicleId))
      .where(eq(vehicles.customerId, id))
      .orderBy(desc(jobs.createdAt), desc(jobs.id));

    const owes = jobRows.filter((j) => !j.voidedAt).reduce((sum, j) => sum + Math.max(j.total - j.paid, 0), 0);

    const recent = jobRows.slice(0, 10);
    const lineRows = recent.length
      ? await app.db
          .select({ jobId: jobLines.jobId, name: services.name })
          .from(jobLines)
          .innerJoin(services, eq(services.id, jobLines.serviceId))
          .where(inArray(jobLines.jobId, recent.map((j) => j.id)))
          .orderBy(asc(jobLines.id))
      : [];
    const recentVisits: VisitDto[] = recent.map((j) => ({
      jobId: j.id,
      at: j.at.toISOString(),
      services: lineRows.filter((l) => l.jobId === j.id).map((l) => l.name),
      total: j.total,
      status: j.status,
      voided: j.voidedAt !== null,
    }));

    return { customer: customer!, owes, recentVisits };
  });

  app.patch('/:id', manage, async (req) => {
    const { id } = idParams.parse(req.params);
    const patch = customerUpdate.parse(req.body);

    const record = await app.db.transaction(async (tx) => {
      const [current] = await tx.select().from(customers).where(eq(customers.id, id)).for('update');
      if (!current) throw notFound('That customer');
      const diff = changedFields({ name: current.name, phone: current.phone, okToText: current.okToText }, patch);
      if (!diff) return current;
      const [row] = await tx.update(customers).set(diff.after).where(eq(customers.id, id)).returning();
      await writeAudit(tx, {
        userId: req.user!.id,
        action: 'customer.update',
        recordTable: 'customers',
        recordId: id,
        before: diff.before,
        after: diff.after,
        ip: req.ip,
      });
      return row!;
    });
    const [row] = await buildRows(app.db, [record]);
    return { customer: row };
  });

  app.post('/:id/vehicles', manage, async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const input = vehicleInput.parse(req.body);
    const vehicle = await app.db.transaction(async (tx) => {
      const [owner] = await tx.select({ id: customers.id }).from(customers).where(eq(customers.id, id));
      if (!owner) throw notFound('That customer');
      return attachVehicle(tx, id, input, { userId: req.user!.id, ip: req.ip });
    });
    return reply.status(201).send({ vehicle: vehicleDto(vehicle) });
  });
};

export const vehicleRoutes: FastifyPluginAsync = async (app) => {
  // Type a plate on the new-job screen, and a regular is filled in with one tap.
  app.get('/lookup', { preHandler: app.requireAuth }, async (req) => {
    const { plate } = z.object({ plate: z.string().trim().min(1).max(20) }).parse(req.query);
    const key = normalizePlate(plate);
    const [row] = await app.db
      .select({ vehicle: vehicles, customer: customers })
      .from(vehicles)
      .leftJoin(customers, eq(customers.id, vehicles.customerId))
      .where(eq(vehicles.plateKey, key));
    if (!row) return { vehicle: null, customer: null };
    const [customer] = row.customer ? await buildRows(app.db, [row.customer]) : [];
    return { vehicle: vehicleDto(row.vehicle), customer: customer ?? null };
  });

  // Cars whose plate contains what has been typed so far. Starts-with matches come first.
  app.get('/search', { preHandler: app.requireAuth }, async (req) => {
    const { q } = z.object({ q: z.string().trim().min(1).max(20) }).parse(req.query);
    const key = normalizePlate(q);
    if (key.length < 2) return { matches: [] };
    const rows = await app.db
      .select({
        vehicle: vehicles,
        owner: customers.name,
        onBoard: sql<boolean>`exists (select 1 from jobs oj where oj.vehicle_id = "vehicles"."id" and oj.voided_at is null and oj.status in ('pending', 'in_progress'))`,
      })
      .from(vehicles)
      .leftJoin(customers, eq(customers.id, vehicles.customerId))
      .where(like(vehicles.plateKey, `%${likeSafe(key)}%`))
      .orderBy(sql`(${vehicles.plateKey} like ${`${likeSafe(key)}%`}) desc`, asc(vehicles.plateKey))
      .limit(6);
    return { matches: rows.map((r) => ({ vehicle: vehicleDto(r.vehicle), owner: r.owner, onBoard: r.onBoard })) };
  });

  app.patch('/:id', { preHandler: app.requirePermission('customer.manage') }, async (req) => {
    const { id } = idParams.parse(req.params);
    const patch = vehicleUpdate.parse(req.body);

    const record = await app.db.transaction(async (tx) => {
      const [current] = await tx.select().from(vehicles).where(eq(vehicles.id, id)).for('update');
      if (!current) throw notFound('That car');

      if (patch.plate !== undefined) {
        const key = normalizePlate(patch.plate);
        const [clash] = await tx
          .select({ owner: customers.name })
          .from(vehicles)
          .leftJoin(customers, eq(customers.id, vehicles.customerId))
          .where(and(eq(vehicles.plateKey, key), sql`${vehicles.id} <> ${id}`));
        if (clash) throw conflict('plate_taken', clash.owner ? `That plate is already on file for ${clash.owner}.` : 'That plate is already on file.');
      }

      const next = {
        ...(patch.plate !== undefined ? { plate: patch.plate } : {}),
        ...(patch.makeModel !== undefined ? { makeModel: patch.makeModel } : {}),
        ...(patch.carType !== undefined ? { carType: patch.carType } : {}),
      };
      const diff = changedFields({ plate: current.plate, makeModel: current.makeModel, carType: current.carType }, next);
      if (!diff) return current;
      const [row] = await tx
        .update(vehicles)
        .set({ ...diff.after, ...(diff.after.plate ? { plateKey: normalizePlate(diff.after.plate) } : {}) })
        .where(eq(vehicles.id, id))
        .returning();
      await writeAudit(tx, {
        userId: req.user!.id,
        action: 'vehicle.update',
        recordTable: 'vehicles',
        recordId: id,
        before: diff.before,
        after: diff.after,
        ip: req.ip,
      });
      return row!;
    });
    return { vehicle: vehicleDto(record) };
  });
};

export { normalizePhone };
