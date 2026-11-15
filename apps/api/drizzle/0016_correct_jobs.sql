-- A service can be taken off a job before it is paid, without voiding the whole job. The line stays on record with who, when and why.
ALTER TABLE "job_lines" ADD COLUMN "removed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "job_lines" ADD COLUMN "removed_by" bigint;--> statement-breakpoint
ALTER TABLE "job_lines" ADD COLUMN "remove_reason" text;--> statement-breakpoint
ALTER TABLE "job_lines" ADD CONSTRAINT "job_lines_removed_by_users_id_fk" FOREIGN KEY ("removed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_lines" ADD CONSTRAINT "job_lines_removed_complete" CHECK (("removed_at" IS NULL) = ("removed_by" IS NULL) AND ("removed_at" IS NULL) = ("remove_reason" IS NULL));--> statement-breakpoint
-- Putting stock back, or taking more, when a line is removed or its quantity corrected.
ALTER TYPE "public"."stock_reason" ADD VALUE IF NOT EXISTS 'correction';--> statement-breakpoint
-- Sales, voids and corrections belong to a job; deliveries and counts do not. (Written without the new word, which cannot be used in the same step that adds it.)
ALTER TABLE "stock_moves" DROP CONSTRAINT "stock_moves_job_for_sales";--> statement-breakpoint
ALTER TABLE "stock_moves" ADD CONSTRAINT "stock_moves_job_for_sales" CHECK (("reason" IN ('delivery', 'count')) = ("job_id" IS NULL));
