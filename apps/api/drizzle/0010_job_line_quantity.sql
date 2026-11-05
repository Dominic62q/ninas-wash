-- A service on a job can be done more than once (three seats, two rugs). price_at_sale stays the whole line,
-- so every existing sum over it, and the guards around it, keep working. Old lines are quantity 1.
ALTER TABLE "job_lines" ADD COLUMN "quantity" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "job_lines" ADD CONSTRAINT "job_lines_quantity_range" CHECK ("job_lines"."quantity" between 1 and 50);
