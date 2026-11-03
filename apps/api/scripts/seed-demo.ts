/**
 * Fills a local database with made-up (but realistic) data so every screen looks like a working car wash:
 * services, attendants, regular customers and cars, about ten days of finished and paid jobs, and a live board.
 *
 * For development only. Run `npm run db:seed` first (it makes the sign-ins). Refuses to run twice.
 * Names, plates and phone numbers are invented. The numbers come from a fixed seed, so every run looks the same.
 */
import { eq, inArray, sql } from 'drizzle-orm';
import { normalizePhone, normalizePlate, splitEvenly } from '@niinas/shared';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db/client.js';
import { balanceOf, earnCommissions, relinkPayouts } from '../src/lib/commissions.js';
import {
  attendants,
  auditLogs,
  commissionPayouts,
  customers,
  jobLineAttendants,
  jobLines,
  jobs,
  payments,
  services,
  tipHandouts,
  tips,
  users,
  vehicles,
} from '../src/db/schema.js';

const { db, pool } = createDb(loadConfig().DATABASE_URL);

// A small repeatable random number generator, so the demo data is the same every time.
let state = 20261030;
const rand = () => {
  state = (state * 1664525 + 1013904223) % 4294967296;
  return state / 4294967296;
};
const int = (min: number, max: number) => min + Math.floor(rand() * (max - min + 1));
const pick = <T>(list: readonly T[]): T => list[int(0, list.length - 1)]!;
const chance = (p: number) => rand() < p;

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

const SERVICES = [
  { name: 'Basic wash', price: 3000, kind: 'percent', value: 1500 },
  { name: 'Full wash', price: 5000, kind: 'percent', value: 1800 },
  { name: 'Interior vacuum', price: 2000, kind: 'fixed', value: 300 },
  { name: 'Engine wash', price: 6000, kind: 'percent', value: 2000 },
  { name: 'Underbody wash', price: 4500, kind: 'percent', value: 1500 },
  { name: 'Polish and wax', price: 12000, kind: 'percent', value: 1500 },
  { name: 'Full detailing', price: 25000, kind: 'percent', value: 1200 },
] as const;

const ATTENDANTS = [
  ['Kofi Mensah', '0244110022'],
  ['Yaw Boateng', '0554220033'],
  ['Ama Serwaa', '0204330044'],
  ['Kwesi Appiah', '0264440055'],
  ['Nana Yaa Owusu', '0244550066'],
  ['Emmanuel Tetteh', '0504660077'],
  ['Abena Frimpong', '0554770088'],
  ['Samuel Quaye', '0244880099'],
  ['Efua Darko', '0204990011'],
  ['Joseph Danquah', '0265001122'],
] as const;

const CAR_TYPES = ['saloon', 'saloon', 'saloon', 'suv', 'suv', 'pickup', 'van'] as const;
const MAKES = {
  saloon: ['Toyota Corolla', 'Toyota Camry', 'Honda Civic', 'Hyundai Elantra', 'Kia Rio', 'Nissan Sunny', 'Ford Fusion'],
  suv: ['Toyota RAV4', 'Honda CR-V', 'Hyundai Tucson', 'Kia Sportage', 'Nissan Qashqai', 'Toyota Highlander'],
  pickup: ['Toyota Hilux', 'Ford Ranger', 'Nissan Navara'],
  van: ['Toyota Hiace', 'Hyundai H1', 'Mercedes Sprinter'],
} as const;

const CUSTOMERS = [
  ['Akosua Boateng', '0244567801', true],
  ['Kwame Asante', '0555123902', true],
  ['Efua Mensah', '0203456703', false],
  ['Nii Armah', '0267890104', true],
  ['Adwoa Sarpong', '0243216505', true],
  ['Yaw Ofori', '0501239806', false],
  ['Maame Serwaa Addo', '0556781207', true],
  ['Kojo Antwi', '0244329908', true],
  ['Esi Quansah', '0207654309', false],
  ['Bernard Tawiah', '0268123410', true],
  ['Gifty Ampofo', '0243456711', true],
  ['Prince Nkrumah', '0551239812', false],
  ['Dr. Amponsah', '0200987613', true],
  ['Mercy Lamptey', '0247654314', true],
  ['Ebenezer Yeboah', '0558901215', false],
] as const;

const PLATE_PREFIXES = ['GR', 'GT', 'GE', 'AS', 'WR', 'ER', 'BA', 'GN'];
const usedPlates = new Set<string>();
function newPlate(): string {
  for (;;) {
    const plate = `${pick(PLATE_PREFIXES)} ${int(100, 9999)}-${pick(['21', '22', '23', '24', '25', '26'])}`;
    if (!usedPlates.has(normalizePlate(plate))) {
      usedPlates.add(normalizePlate(plate));
      return plate;
    }
  }
}

const VOID_REASONS = ['Booked on the wrong car', 'Customer left before the wash', 'Entered twice by mistake', 'Customer changed their mind'];
const NOTES = ['Scratch on the left door', 'Dog hair on the back seat', 'Customer will wait', 'Muddy from the road', 'Leaves a key with us'];

// ---- guard ---------------------------------------------------------------------

const [already] = await db.select({ id: customers.id }).from(customers).where(eq(customers.name, 'Akosua Boateng'));
if (already) {
  console.log('Demo data is already loaded. Nothing changed.');
  await pool.end();
  process.exit(0);
}
const staff = await db.select({ id: users.id, username: users.username }).from(users).where(inArray(users.username, ['esi.cashier', 'kwabena.asare']));
const idOf = (username: string) => {
  const found = staff.find((s) => s.username === username);
  if (!found) throw new Error(`User "${username}" is missing. Run "npm run db:seed" first.`);
  return found.id;
};
const cashier = idOf('esi.cashier');
const manager = idOf('kwabena.asare');

// ---- the catalogue ---------------------------------------------------------------

const serviceRows: (typeof services.$inferSelect)[] = [];
for (const s of SERVICES) {
  const [existing] = await db.select().from(services).where(eq(services.name, s.name));
  if (existing) {
    serviceRows.push(existing);
    continue;
  }
  const [row] = await db
    .insert(services)
    .values({ name: s.name, price: s.price, commissionKind: s.kind, commissionValue: s.value })
    .returning();
  serviceRows.push(row!);
}

const attendantRows: (typeof attendants.$inferSelect)[] = [];
for (const [name, phone] of ATTENDANTS) {
  const [existing] = await db.select().from(attendants).where(eq(attendants.name, name));
  if (existing) {
    attendantRows.push(existing);
    continue;
  }
  const [row] = await db.insert(attendants).values({ name, phone: normalizePhone(phone) ?? null }).returning();
  attendantRows.push(row!);
}

// ---- customers and cars ------------------------------------------------------------

interface Car {
  id: number;
  plate: string;
  regular: boolean;
}
const cars: Car[] = [];

async function addCar(customerId: number | null): Promise<Car> {
  const type = pick(CAR_TYPES);
  const plate = newPlate();
  const [row] = await db
    .insert(vehicles)
    .values({ plate, plateKey: normalizePlate(plate), customerId, makeModel: pick(MAKES[type]), carType: type })
    .returning();
  const car = { id: row!.id, plate, regular: customerId !== null };
  cars.push(car);
  return car;
}

for (const [name, phone, okToText] of CUSTOMERS) {
  // Most regulars joined weeks ago; a few are new this week.
  const joined = new Date(Date.now() - (chance(0.2) ? int(1, 6) : int(12, 70)) * DAY);
  const [row] = await db.insert(customers).values({ name, phone: normalizePhone(phone) ?? null, okToText, createdAt: joined }).returning();
  const count = chance(0.25) ? 2 : 1;
  for (let i = 0; i < count; i++) await addCar(row!.id);
}
for (let i = 0; i < 16; i++) await addCar(null); // walk-ins

// ---- jobs ---------------------------------------------------------------------------

type Shape = 'dispatched' | 'completed' | 'in_progress' | 'pending' | 'voided';

interface Plan {
  car: Car;
  shape: Shape;
  createdAt: Date;
  unassigned?: boolean;
  /** A finished job that has had part of its bill paid. */
  partPaid?: boolean;
}

async function writeJob(plan: Plan): Promise<void> {
  const { car, shape, createdAt } = plan;
  const by = chance(0.2) ? manager : cashier;
  const start = new Date(createdAt.getTime() + int(4, 14) * MIN);
  const done = new Date(start.getTime() + int(18, 55) * MIN);
  const out = new Date(done.getTime() + int(3, 20) * MIN);

  // One to three services. Most visits are a basic or full wash, sometimes with an extra.
  const chosen = new Set<number>();
  chosen.add(serviceRows[int(0, 1)]!.id);
  if (chance(0.4)) chosen.add(pick(serviceRows).id);
  if (chance(0.12)) chosen.add(pick(serviceRows).id);
  const lines = serviceRows.filter((s) => chosen.has(s.id));
  const subtotal = lines.reduce((sum, l) => sum + l.price, 0);
  const discount = chance(0.12) ? pick([500, 1000]) : 0;
  const total = subtotal - discount;

  const voidReason = pick(VOID_REASONS);
  const started = shape !== 'pending' && shape !== 'voided';
  const finished = shape === 'completed' || shape === 'dispatched';

  await db.transaction(async (tx) => {
    const [job] = await tx
      .insert(jobs)
      .values({
        vehicleId: car.id,
        createdBy: by,
        status: shape === 'voided' ? 'pending' : shape,
        discount,
        notes: chance(0.12) ? pick(NOTES) : null,
        createdAt,
        startedAt: started ? start : null,
        completedAt: finished ? done : null,
        dispatchedAt: shape === 'dispatched' ? out : null,
        ...(shape === 'voided' ? { voidedAt: new Date(createdAt.getTime() + int(3, 15) * MIN), voidedBy: manager, voidReason } : {}),
      })
      .returning();
    const jobId = job!.id;

    const audit: { at: Date; action: string; userId: number; before?: unknown; after?: unknown; note?: string }[] = [];
    const addAudit = (e: (typeof audit)[number]) => audit.push(e);
    const lineSummary: { service: string; price: number; attendants: string[] }[] = [];
    const crewIds = new Set<number>();

    for (const service of lines) {
      const [line] = await tx
        .insert(jobLines)
        .values({
          jobId,
          serviceId: service.id,
          priceAtSale: service.price,
          commissionKindAtSale: service.commissionKind,
          commissionValueAtSale: service.commissionValue,
          createdAt,
        })
        .returning();
      const crew = plan.unassigned ? [] : [...attendantRows].sort(() => rand() - 0.5).slice(0, chance(0.3) ? 2 : 1);
      if (crew.length > 0) {
        const shares = splitEvenly(10_000, crew.length);
        await tx.insert(jobLineAttendants).values(crew.map((a, i) => ({ jobLineId: line!.id, attendantId: a.id, shareBp: shares[i]! })));
      }
      lineSummary.push({ service: service.name, price: service.price, attendants: crew.map((c) => c.name) });
      for (const c of crew) crewIds.add(c.id);
    }
    if (finished) await earnCommissions(tx, jobId, done);
    // Now and then a customer tips the person who washed the car: kept at the till, or given straight to them.
    if (shape === 'dispatched' && crewIds.size > 0 && chance(0.25)) {
      const [attendantId] = [...crewIds];
      const held = chance(0.6);
      const amount = pick([200, 500, 500, 1000, 2000]);
      const [row] = await tx
        .insert(tips)
        .values({ attendantId: attendantId!, jobId, amount, kind: held ? 'held' : 'direct', recordedBy: by, idemKey: `demo-tip-${jobId}`, createdAt: out })
        .returning();
      await tx.insert(auditLogs).values({ at: out, userId: by, action: 'tip.record', recordTable: 'tips', recordId: row!.id, after: { amount, kind: held ? 'held' : 'direct', jobId } });
    }

    addAudit({ at: createdAt, action: 'job.create', userId: by, after: { plate: car.plate, services: lineSummary, discount } });
    if (started) addAudit({ at: start, action: 'job.status', userId: by, before: { status: 'pending' }, after: { status: 'in_progress' } });
    if (finished) addAudit({ at: done, action: 'job.status', userId: by, before: { status: 'in_progress' }, after: { status: 'completed' } });
    if (shape === 'voided') {
      addAudit({ at: new Date(createdAt.getTime() + 5 * MIN), action: 'job.void', userId: manager, before: { status: 'pending' }, note: voidReason });
    }
    await tx.insert(auditLogs).values(
      audit.map((a) => ({
        at: a.at,
        userId: a.userId,
        action: a.action,
        recordTable: 'jobs',
        recordId: jobId,
        before: a.before ?? null,
        after: a.after ?? null,
        note: a.note ?? null,
      })),
    );

    // Most dispatched cars were paid in full, in one go or as two part payments. A few left with a balance
    // (a manager let them go), and one of today's finished jobs has had a part payment.
    const owing = shape === 'dispatched' && total >= 4000 && chance(0.07);
    const parts =
      plan.partPaid || owing
        ? [Math.floor(total / 2 / 100) * 100]
        : shape === 'dispatched'
          ? total >= 6000 && chance(0.2)
            ? splitEvenly(total, 2)
            : [total]
          : [];
    for (const [i, amount] of parts.entries()) {
      const momo = chance(0.4);
      const at = shape === 'dispatched' ? out : done;
      const momoReference = momo ? `MP${int(100000000, 999999999)}` : null;
      const [paid] = await tx
        .insert(payments)
        .values({ jobId, method: momo ? 'momo' : 'cash', amount, momoReference, idemKey: `demo-${jobId}-${i}`, recordedBy: by, createdAt: at })
        .returning();
      await tx.insert(auditLogs).values({
        at,
        userId: by,
        action: 'payment.record',
        recordTable: 'payments',
        recordId: paid!.id,
        after: { method: momo ? 'momo' : 'cash', amount, momoReference },
      });
    }
    if (shape === 'dispatched') {
      const note = owing ? pick(['Regular customer, pays on Friday', 'Left his wallet, sending MoMo later', 'Company car, invoiced monthly']) : null;
      if (owing) {
        await tx.update(jobs).set({ dispatchOverrideBy: manager, dispatchOverrideNote: note }).where(eq(jobs.id, jobId));
      }
      await tx.insert(auditLogs).values({
        at: out,
        userId: owing ? manager : by,
        action: 'job.dispatch',
        recordTable: 'jobs',
        recordId: jobId,
        before: { status: 'completed' },
        after: { status: 'dispatched', owed: owing ? total - parts[0]! : 0 },
        note,
      });
    }
  });
}

// Today's board first, so the cars on it never clash with each other.
const free = cars.filter((c) => c.regular).concat(cars.filter((c) => !c.regular));
const today: Plan[] = [];
const take = () => free.splice(int(0, free.length - 1), 1)[0]!;
const now = Date.now();
for (const [ago, unassigned] of [[6, false], [14, true], [31, false]] as const) today.push({ car: take(), shape: 'pending', createdAt: new Date(now - ago * MIN), unassigned });
for (const ago of [22, 38, 51, 70]) today.push({ car: take(), shape: 'in_progress', createdAt: new Date(now - ago * MIN) });
for (const ago of [64, 95]) today.push({ car: take(), shape: 'completed', createdAt: new Date(now - ago * MIN), partPaid: ago === 95 });
const returning = [...free];

// Ten days of history, oldest first. About a dozen cars a day on weekdays, a little busier at the weekend.
const history: Plan[] = [];
for (let d = 10; d >= 1; d--) {
  const midnight = new Date(now);
  midnight.setUTCHours(0, 0, 0, 0);
  const day = new Date(midnight.getTime() - d * DAY);
  const weekend = [0, 6].includes(day.getUTCDay());
  const count = int(weekend ? 9 : 6, weekend ? 13 : 10);
  const times = Array.from({ length: count }, () => int(7 * 60 + 30, 16 * 60 + 30)).sort((a, b) => a - b);
  for (const minute of times) {
    history.push({
      car: pick(returning),
      shape: chance(0.06) ? 'voided' : 'dispatched',
      createdAt: new Date(day.getTime() + minute * MIN),
    });
  }
}

for (const plan of [...history, ...today]) await writeJob(plan);

// Attendants were paid out most of what they earned two days ago, and tips held for more than three days were handed over.
for (const person of attendantRows) {
  const { owed } = await balanceOf(db, person.id);
  const amount = Math.floor((owed * 0.7) / 100) * 100;
  if (amount > 0) {
    const at = new Date(now - 2 * DAY);
    const method = chance(0.5) ? 'cash' : 'momo';
    const [row] = await db
      .insert(commissionPayouts)
      .values({ attendantId: person.id, amount, method, paidBy: manager, idemKey: `demo-payout-${person.id}`, createdAt: at })
      .returning();
    await db.insert(auditLogs).values({ at, userId: manager, action: 'commission.payout', recordTable: 'commission_payouts', recordId: row!.id, after: { attendant: person.name, method, amount } });
    await relinkPayouts(db, person.id);
  }
  const old = await db
    .select({ id: tips.id, amount: tips.amount })
    .from(tips)
    .where(sql`${tips.attendantId} = ${person.id} and ${tips.kind} = 'held' and ${tips.handoutId} is null and ${tips.createdAt} < ${new Date(now - 3 * DAY)}`);
  if (old.length > 0) {
    const total = old.reduce((sum, t) => sum + t.amount, 0);
    const at = new Date(now - 3 * DAY + 5 * MIN);
    const [handout] = await db.insert(tipHandouts).values({ attendantId: person.id, amount: total, givenBy: manager, createdAt: at }).returning();
    await db.update(tips).set({ handoutId: handout!.id }).where(inArray(tips.id, old.map((t) => t.id)));
    await db.insert(auditLogs).values({ at, userId: manager, action: 'tip.handout', recordTable: 'tip_handouts', recordId: handout!.id, after: { attendant: person.name, amount: total, tips: old.length } });
  }
}

const counted = await db.execute<{ n: number }>(sql`select count(*)::int as n from jobs`);
const jobCount = counted.rows[0]?.n ?? 0;
console.log(`Loaded demo data: ${serviceRows.length} services, ${attendantRows.length} attendants, ${CUSTOMERS.length} customers, ${cars.length} cars. Jobs in the database: ${jobCount}.`);
await pool.end();
