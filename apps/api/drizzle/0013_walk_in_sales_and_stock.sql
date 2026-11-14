-- Walk-in sales and shelf items (PM request, 13 Nov 2026).
-- Items (dusters, car shine, drinks) live in the services table with kind = 'item': a price, no commission, and a stock count.
-- A walk-in sale is a job with kind = 'sale' and no car. Its payments are ordinary payments, so the daily close,
-- reports and receipts count it with no changes there.
-- Written by hand: drizzle-kit's snapshot is behind the database (it still lists the dropped pay_method and role enums).

CREATE TYPE "public"."service_kind" AS ENUM('service', 'item');--> statement-breakpoint
CREATE TYPE "public"."job_kind" AS ENUM('wash', 'sale');--> statement-breakpoint
CREATE TYPE "public"."stock_reason" AS ENUM('delivery', 'sale', 'void', 'count');--> statement-breakpoint

ALTER TABLE "services" ADD COLUMN "kind" "service_kind" DEFAULT 'service' NOT NULL;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "stock" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_stock_not_negative" CHECK ("services"."stock" >= 0);--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_item_no_commission" CHECK ("services"."kind" <> 'item' OR "services"."commission_value" = 0);--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_stock_items_only" CHECK ("services"."kind" = 'item' OR "services"."stock" = 0);--> statement-breakpoint

ALTER TABLE "jobs" ADD COLUMN "kind" "job_kind" DEFAULT 'wash' NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ALTER COLUMN "vehicle_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_car_matches_kind" CHECK (("jobs"."kind" = 'wash') = ("jobs"."vehicle_id" IS NOT NULL));--> statement-breakpoint

CREATE TABLE "stock_moves" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "stock_moves_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"service_id" bigint NOT NULL,
	"change" integer NOT NULL,
	"reason" "stock_reason" NOT NULL,
	"job_id" bigint,
	"after" integer NOT NULL,
	"note" text,
	"by" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_moves_change_not_zero" CHECK ("stock_moves"."change" <> 0),
	CONSTRAINT "stock_moves_after_not_negative" CHECK ("stock_moves"."after" >= 0),
	CONSTRAINT "stock_moves_job_for_sales" CHECK (("stock_moves"."reason" IN ('sale', 'void')) = ("stock_moves"."job_id" IS NOT NULL))
);--> statement-breakpoint
ALTER TABLE "stock_moves" ADD CONSTRAINT "stock_moves_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_moves" ADD CONSTRAINT "stock_moves_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_moves" ADD CONSTRAINT "stock_moves_by_users_id_fk" FOREIGN KEY ("by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stock_moves_service_idx" ON "stock_moves" USING btree ("service_id","created_at");--> statement-breakpoint
CREATE INDEX "stock_moves_job_idx" ON "stock_moves" USING btree ("job_id");--> statement-breakpoint

-- The stock history is a record like the audit log: added to, never edited or deleted.
CREATE FUNCTION forbid_stock_move_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'stock_moves is append-only: % is not allowed (correct a mistake with a count)', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER stock_moves_no_update_delete BEFORE UPDATE OR DELETE ON stock_moves FOR EACH ROW EXECUTE FUNCTION forbid_stock_move_change();--> statement-breakpoint
CREATE TRIGGER stock_moves_no_truncate BEFORE TRUNCATE ON stock_moves FOR EACH STATEMENT EXECUTE FUNCTION forbid_stock_move_change();
