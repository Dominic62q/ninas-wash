import { and, eq, inArray, isNull } from 'drizzle-orm';
import { can, type Permission } from '@niinas/shared';
import type { DbOrTx } from '../db/client.js';
import { attendants, jobLineAttendants, jobLines, jobs, services, vehicles } from '../db/schema.js';
import { HttpError } from './errors.js';

/**
 * One person does one service at a time. "Busy" means on a service of a job that is in progress (started, not finished).
 * A job that is only booked does not hold anybody, so a pending job can be set up freely.
 *
 * `crew` is the person on each service being started, added or assigned (one entry each, repeats allowed so a
 * second service for the same person is caught). `onJob` is who is already on the job's other services.
 * Returns what to tell the cashier, or null when all is well.
 */
export async function busyProblem(tx: DbOrTx, { jobId, crew, onJob = [] }: { jobId: number | null; crew: number[]; onJob?: number[] }): Promise<string | null> {
  if (crew.length === 0) return null;

  const all = [...onJob, ...crew];
  const repeated = all.find((id, i) => all.indexOf(id) !== i);
  if (repeated !== undefined) {
    const [person] = await tx.select({ name: attendants.name }).from(attendants).where(eq(attendants.id, repeated));
    return `${person?.name ?? 'Someone'} is already on another service of this job. One person does one service at a time.`;
  }

  const busyNow = await tx
    .select({ name: attendants.name, plate: vehicles.plate, service: services.name, jobId: jobs.id })
    .from(jobLineAttendants)
    .innerJoin(jobLines, eq(jobLines.id, jobLineAttendants.jobLineId))
    .innerJoin(jobs, eq(jobs.id, jobLines.jobId))
    .innerJoin(services, eq(services.id, jobLines.serviceId))
    .innerJoin(attendants, eq(attendants.id, jobLineAttendants.attendantId))
    .leftJoin(vehicles, eq(vehicles.id, jobs.vehicleId))
    .where(and(inArray(jobLineAttendants.attendantId, crew), eq(jobs.status, 'in_progress'), isNull(jobs.voidedAt), isNull(jobLines.removedAt)));
  // A job being started is not "busy" with itself.
  const hit = busyNow.find((b) => b.jobId !== jobId);
  if (!hit) return null;
  return `${hit.name} is busy on ${hit.plate ? hit.plate.toUpperCase() : 'a walk-in job'} (${hit.service}). One person does one service at a time.`;
}

/**
 * Turns a busy problem into an error, unless a manager gave a reason to go ahead anyway.
 * Returns true when the rule was overridden, so the caller writes it into the activity log.
 */
export function acceptBusy(problem: string | null, note: string | null | undefined, permissions: readonly Permission[]): boolean {
  if (!problem) return false;
  if (!note) throw new HttpError(409, 'attendant_busy', problem);
  if (!can(permissions, 'job.override_busy')) throw new HttpError(403, 'forbidden', 'Only a manager can put someone on a second service. Ask a manager.');
  return true;
}
