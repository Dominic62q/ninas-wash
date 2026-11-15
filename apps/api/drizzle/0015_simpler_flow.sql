-- MoMo no longer insists on a reference: the cashier can still type one, but a payment saves without it.
UPDATE "payment_methods" SET "requires_reference" = false WHERE "name" = 'MoMo';--> statement-breakpoint
-- Managers get the two new job permissions (correct a job before payment, put someone on a second service). Roles are data, so the list is updated here.
UPDATE "roles" SET "permissions" = "permissions" || ARRAY['job.edit', 'job.override_busy']::text[] WHERE "name" = 'Manager' AND "locked" = false AND NOT ("permissions" @> ARRAY['job.edit']::text[]);
