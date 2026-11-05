-- Ways of paying become data instead of two fixed words. Cash and MoMo are created first, with the ids 1 and 2,
-- and every payment, expense and payout is pointed at the one it used. Changing a column's type rewrites the table
-- without firing the "never edited" guards, so history is carried over untouched.
CREATE TABLE "payment_methods" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "payment_methods_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"name" text NOT NULL,
	"in_drawer" boolean DEFAULT false NOT NULL,
	"requires_reference" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_methods_name_not_blank" CHECK (length(btrim("name")) > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "payment_methods_name_unique" ON "payment_methods" (lower("name"));
--> statement-breakpoint
INSERT INTO "payment_methods" ("name", "in_drawer", "requires_reference", "sort_order") VALUES ('Cash', true, false, 1), ('MoMo', false, true, 2);
--> statement-breakpoint
DO $$
BEGIN
	IF (SELECT "id" FROM "payment_methods" WHERE "name" = 'Cash') <> 1 OR (SELECT "id" FROM "payment_methods" WHERE "name" = 'MoMo') <> 2 THEN
		RAISE EXCEPTION 'the starting payment methods did not get the ids 1 and 2';
	END IF;
END $$;
--> statement-breakpoint

ALTER TABLE "payments" DROP CONSTRAINT "payments_momo_needs_reference";
--> statement-breakpoint
ALTER TABLE "payments" ALTER COLUMN "method" TYPE bigint USING (CASE "method"::text WHEN 'cash' THEN 1 ELSE 2 END)::bigint;
--> statement-breakpoint
ALTER TABLE "payments" RENAME COLUMN "method" TO "method_id";
--> statement-breakpoint
ALTER TABLE "payments" RENAME COLUMN "momo_reference" TO "reference";
--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_method_id_payment_methods_id_fk" FOREIGN KEY ("method_id") REFERENCES "public"."payment_methods"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_reference_not_blank" CHECK ("reference" IS NULL OR length(btrim("reference")) > 0);
--> statement-breakpoint

ALTER TABLE "expenses" ALTER COLUMN "method" TYPE bigint USING (CASE "method"::text WHEN 'cash' THEN 1 ELSE 2 END)::bigint;
--> statement-breakpoint
ALTER TABLE "expenses" RENAME COLUMN "method" TO "method_id";
--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_method_id_payment_methods_id_fk" FOREIGN KEY ("method_id") REFERENCES "public"."payment_methods"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "commission_payouts" ALTER COLUMN "method" TYPE bigint USING (CASE "method"::text WHEN 'cash' THEN 1 ELSE 2 END)::bigint;
--> statement-breakpoint
ALTER TABLE "commission_payouts" RENAME COLUMN "method" TO "method_id";
--> statement-breakpoint
ALTER TABLE "commission_payouts" ADD CONSTRAINT "commission_payouts_method_id_payment_methods_id_fk" FOREIGN KEY ("method_id") REFERENCES "public"."payment_methods"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "daily_closes" RENAME COLUMN "momo_total" TO "other_total";
--> statement-breakpoint
DROP TYPE "public"."pay_method";
--> statement-breakpoint

-- The "never edited" guards named the old columns. Same rules, new names.
CREATE OR REPLACE FUNCTION payments_guard_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'a voided payment cannot be changed'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.job_id IS DISTINCT FROM OLD.job_id
     OR NEW.method_id IS DISTINCT FROM OLD.method_id
     OR NEW.amount IS DISTINCT FROM OLD.amount
     OR NEW.reference IS DISTINCT FROM OLD.reference
     OR NEW.idem_key IS DISTINCT FROM OLD.idem_key
     OR NEW.recorded_by IS DISTINCT FROM OLD.recorded_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a payment cannot be edited: void it and enter it again'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION commission_payouts_guard_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'a voided payout cannot be changed'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.attendant_id IS DISTINCT FROM OLD.attendant_id
     OR NEW.amount IS DISTINCT FROM OLD.amount
     OR NEW.method_id IS DISTINCT FROM OLD.method_id
     OR NEW.paid_by IS DISTINCT FROM OLD.paid_by
     OR NEW.note IS DISTINCT FROM OLD.note
     OR NEW.idem_key IS DISTINCT FROM OLD.idem_key
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a payout cannot be edited: void it and enter it again'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION expenses_guard_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'a voided expense cannot be changed'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.category IS DISTINCT FROM OLD.category
     OR NEW.amount IS DISTINCT FROM OLD.amount
     OR NEW.method_id IS DISTINCT FROM OLD.method_id
     OR NEW.receipt_file IS DISTINCT FROM OLD.receipt_file
     OR NEW.spent_on IS DISTINCT FROM OLD.spent_on
     OR NEW.note IS DISTINCT FROM OLD.note
     OR NEW.entered_by IS DISTINCT FROM OLD.entered_by
     OR NEW.idem_key IS DISTINCT FROM OLD.idem_key
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'an expense cannot be edited: void it and enter it again'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION daily_closes_guard_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.day IS DISTINCT FROM OLD.day THEN
    RAISE EXCEPTION 'a daily close cannot move to another day'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status = 'closed' THEN
    IF NEW.status IS DISTINCT FROM 'reopened' THEN
      RAISE EXCEPTION 'a closed day can only be reopened'
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW.opening_float IS DISTINCT FROM OLD.opening_float
       OR NEW.expected_cash IS DISTINCT FROM OLD.expected_cash
       OR NEW.counted_cash IS DISTINCT FROM OLD.counted_cash
       OR NEW.other_total IS DISTINCT FROM OLD.other_total
       OR NEW.note IS DISTINCT FROM OLD.note
       OR NEW.closed_by IS DISTINCT FROM OLD.closed_by
       OR NEW.closed_at IS DISTINCT FROM OLD.closed_at THEN
      RAISE EXCEPTION 'a closed day cannot be edited: reopen it first'
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW.reopened_at IS NULL OR NEW.reopened_by IS NULL OR NEW.reopen_reason IS NULL THEN
      RAISE EXCEPTION 'reopening a day needs who and why'
        USING ERRCODE = 'restrict_violation';
    END IF;
  ELSE
    IF NEW.status IS DISTINCT FROM 'closed' THEN
      RAISE EXCEPTION 'a reopened day can only be closed again'
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW.reopened_at IS DISTINCT FROM OLD.reopened_at
       OR NEW.reopened_by IS DISTINCT FROM OLD.reopened_by
       OR NEW.reopen_reason IS DISTINCT FROM OLD.reopen_reason THEN
      RAISE EXCEPTION 'who reopened a day is kept'
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
