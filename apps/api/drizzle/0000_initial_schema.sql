CREATE TYPE "public"."car_type" AS ENUM('saloon', 'suv', 'pickup', 'van', 'other');--> statement-breakpoint
CREATE TYPE "public"."close_status" AS ENUM('closed', 'reopened');--> statement-breakpoint
CREATE TYPE "public"."commission_kind" AS ENUM('percent', 'fixed');--> statement-breakpoint
CREATE TYPE "public"."commission_status" AS ENUM('earned', 'reversed');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('pending', 'in_progress', 'completed', 'dispatched');--> statement-breakpoint
CREATE TYPE "public"."pay_method" AS ENUM('cash', 'momo');--> statement-breakpoint
CREATE TYPE "public"."role" AS ENUM('cashier', 'manager', 'owner');--> statement-breakpoint
CREATE TYPE "public"."tip_kind" AS ENUM('direct', 'held');--> statement-breakpoint
CREATE TABLE "attendants" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "attendants_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"name" text NOT NULL,
	"phone" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "audit_logs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"user_id" bigint,
	"action" text NOT NULL,
	"record_table" text,
	"record_id" bigint,
	"before" jsonb,
	"after" jsonb,
	"note" text,
	"ip" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "commission_payouts" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "commission_payouts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"attendant_id" bigint NOT NULL,
	"amount" integer NOT NULL,
	"method" "pay_method" NOT NULL,
	"paid_by" bigint NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commission_payouts_amount_positive" CHECK ("commission_payouts"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "commissions" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "commissions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"line_attendant_id" bigint NOT NULL,
	"amount" integer NOT NULL,
	"status" "commission_status" DEFAULT 'earned' NOT NULL,
	"payout_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reversed_at" timestamp with time zone,
	CONSTRAINT "commissions_line_attendant_id_unique" UNIQUE("line_attendant_id"),
	CONSTRAINT "commissions_amount_not_negative" CHECK ("commissions"."amount" >= 0),
	CONSTRAINT "commissions_reversal_consistent" CHECK (("commissions"."status" = 'reversed') = ("commissions"."reversed_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "customers_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"name" text NOT NULL,
	"phone" text,
	"ok_to_text" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "daily_closes" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "daily_closes_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"day" date NOT NULL,
	"opening_float" integer NOT NULL,
	"expected_cash" integer NOT NULL,
	"counted_cash" integer NOT NULL,
	"difference" integer GENERATED ALWAYS AS (counted_cash - expected_cash) STORED,
	"momo_total" integer NOT NULL,
	"status" "close_status" DEFAULT 'closed' NOT NULL,
	"closed_by" bigint NOT NULL,
	"closed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reopened_by" bigint,
	"reopened_at" timestamp with time zone,
	"reopen_reason" text,
	CONSTRAINT "daily_closes_day_unique" UNIQUE("day"),
	CONSTRAINT "daily_closes_amounts_not_negative" CHECK ("daily_closes"."opening_float" >= 0 AND "daily_closes"."counted_cash" >= 0 AND "daily_closes"."momo_total" >= 0),
	CONSTRAINT "daily_closes_reopen_complete" CHECK (("daily_closes"."reopened_at" IS NULL) = ("daily_closes"."reopened_by" IS NULL) AND ("daily_closes"."reopened_at" IS NULL) = ("daily_closes"."reopen_reason" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "expenses" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "expenses_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"category" text NOT NULL,
	"amount" integer NOT NULL,
	"method" "pay_method" NOT NULL,
	"receipt_file" text,
	"spent_on" date DEFAULT current_date NOT NULL,
	"note" text,
	"entered_by" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_by" bigint,
	"void_reason" text,
	CONSTRAINT "expenses_amount_positive" CHECK ("expenses"."amount" > 0),
	CONSTRAINT "expenses_void_complete" CHECK (("expenses"."voided_at" IS NULL) = ("expenses"."voided_by" IS NULL) AND ("expenses"."voided_at" IS NULL) = ("expenses"."void_reason" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "job_line_attendants" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "job_line_attendants_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"job_line_id" bigint NOT NULL,
	"attendant_id" bigint NOT NULL,
	"share_bp" integer NOT NULL,
	CONSTRAINT "job_line_attendants_once" UNIQUE("job_line_id","attendant_id"),
	CONSTRAINT "job_line_attendants_share_range" CHECK ("job_line_attendants"."share_bp" BETWEEN 1 AND 10000)
);
--> statement-breakpoint
CREATE TABLE "job_lines" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "job_lines_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"job_id" bigint NOT NULL,
	"service_id" bigint NOT NULL,
	"price_at_sale" integer NOT NULL,
	"commission_kind_at_sale" "commission_kind" NOT NULL,
	"commission_value_at_sale" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_lines_price_not_negative" CHECK ("job_lines"."price_at_sale" >= 0),
	CONSTRAINT "job_lines_commission_not_negative" CHECK ("job_lines"."commission_value_at_sale" >= 0)
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "jobs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"vehicle_id" bigint NOT NULL,
	"created_by" bigint NOT NULL,
	"status" "job_status" DEFAULT 'pending' NOT NULL,
	"discount" integer DEFAULT 0 NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"dispatched_at" timestamp with time zone,
	"dispatch_override_by" bigint,
	"dispatch_override_note" text,
	"voided_at" timestamp with time zone,
	"voided_by" bigint,
	"void_reason" text,
	CONSTRAINT "jobs_discount_not_negative" CHECK ("jobs"."discount" >= 0),
	CONSTRAINT "jobs_void_complete" CHECK (("jobs"."voided_at" IS NULL) = ("jobs"."voided_by" IS NULL) AND ("jobs"."voided_at" IS NULL) = ("jobs"."void_reason" IS NULL)),
	CONSTRAINT "jobs_override_complete" CHECK (("jobs"."dispatch_override_by" IS NULL) = ("jobs"."dispatch_override_note" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "payments_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"job_id" bigint NOT NULL,
	"method" "pay_method" NOT NULL,
	"amount" integer NOT NULL,
	"momo_reference" text,
	"idem_key" text NOT NULL,
	"recorded_by" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_by" bigint,
	"void_reason" text,
	CONSTRAINT "payments_idem_key_unique" UNIQUE("idem_key"),
	CONSTRAINT "payments_amount_positive" CHECK ("payments"."amount" > 0),
	CONSTRAINT "payments_momo_needs_reference" CHECK ("payments"."method" <> 'momo' OR length(btrim(coalesce("payments"."momo_reference", ''))) > 0),
	CONSTRAINT "payments_void_complete" CHECK (("payments"."voided_at" IS NULL) = ("payments"."voided_by" IS NULL) AND ("payments"."voided_at" IS NULL) = ("payments"."void_reason" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "services" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "services_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"name" text NOT NULL,
	"price" integer NOT NULL,
	"commission_kind" "commission_kind" NOT NULL,
	"commission_value" integer NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "services_name_unique" UNIQUE("name"),
	CONSTRAINT "services_price_not_negative" CHECK ("services"."price" >= 0),
	CONSTRAINT "services_commission_in_range" CHECK ("services"."commission_value" >= 0 AND ("services"."commission_kind" <> 'percent' OR "services"."commission_value" <= 10000))
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tip_handouts" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "tip_handouts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"attendant_id" bigint NOT NULL,
	"amount" integer NOT NULL,
	"given_by" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tip_handouts_amount_positive" CHECK ("tip_handouts"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "tips" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "tips_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"attendant_id" bigint NOT NULL,
	"job_id" bigint,
	"amount" integer NOT NULL,
	"kind" "tip_kind" NOT NULL,
	"handout_id" bigint,
	"recorded_by" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tips_amount_positive" CHECK ("tips"."amount" > 0),
	CONSTRAINT "tips_only_held_are_handed_out" CHECK ("tips"."handout_id" IS NULL OR "tips"."kind" = 'held')
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "users_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"name" text NOT NULL,
	"username" text NOT NULL,
	"role" "role" NOT NULL,
	"password_hash" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_login_at" timestamp with time zone,
	CONSTRAINT "users_username_unique" UNIQUE("username"),
	CONSTRAINT "users_username_lowercase" CHECK ("users"."username" = lower("users"."username"))
);
--> statement-breakpoint
CREATE TABLE "vehicles" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "vehicles_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"plate" text NOT NULL,
	"plate_key" text NOT NULL,
	"customer_id" bigint,
	"make_model" text,
	"car_type" "car_type",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vehicles_plate_key_unique" UNIQUE("plate_key"),
	CONSTRAINT "vehicles_plate_key_clean" CHECK ("vehicles"."plate_key" ~ '^[A-Z0-9]+$')
);
--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_payouts" ADD CONSTRAINT "commission_payouts_attendant_id_attendants_id_fk" FOREIGN KEY ("attendant_id") REFERENCES "public"."attendants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_payouts" ADD CONSTRAINT "commission_payouts_paid_by_users_id_fk" FOREIGN KEY ("paid_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commissions" ADD CONSTRAINT "commissions_line_attendant_id_job_line_attendants_id_fk" FOREIGN KEY ("line_attendant_id") REFERENCES "public"."job_line_attendants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commissions" ADD CONSTRAINT "commissions_payout_id_commission_payouts_id_fk" FOREIGN KEY ("payout_id") REFERENCES "public"."commission_payouts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_closes" ADD CONSTRAINT "daily_closes_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_closes" ADD CONSTRAINT "daily_closes_reopened_by_users_id_fk" FOREIGN KEY ("reopened_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_entered_by_users_id_fk" FOREIGN KEY ("entered_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_voided_by_users_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_line_attendants" ADD CONSTRAINT "job_line_attendants_job_line_id_job_lines_id_fk" FOREIGN KEY ("job_line_id") REFERENCES "public"."job_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_line_attendants" ADD CONSTRAINT "job_line_attendants_attendant_id_attendants_id_fk" FOREIGN KEY ("attendant_id") REFERENCES "public"."attendants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_lines" ADD CONSTRAINT "job_lines_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_lines" ADD CONSTRAINT "job_lines_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_dispatch_override_by_users_id_fk" FOREIGN KEY ("dispatch_override_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_voided_by_users_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_voided_by_users_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tip_handouts" ADD CONSTRAINT "tip_handouts_attendant_id_attendants_id_fk" FOREIGN KEY ("attendant_id") REFERENCES "public"."attendants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tip_handouts" ADD CONSTRAINT "tip_handouts_given_by_users_id_fk" FOREIGN KEY ("given_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tips" ADD CONSTRAINT "tips_attendant_id_attendants_id_fk" FOREIGN KEY ("attendant_id") REFERENCES "public"."attendants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tips" ADD CONSTRAINT "tips_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tips" ADD CONSTRAINT "tips_handout_id_tip_handouts_id_fk" FOREIGN KEY ("handout_id") REFERENCES "public"."tip_handouts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tips" ADD CONSTRAINT "tips_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_logs_record_idx" ON "audit_logs" USING btree ("record_table","record_id");--> statement-breakpoint
CREATE INDEX "audit_logs_at_idx" ON "audit_logs" USING btree ("at");--> statement-breakpoint
CREATE INDEX "audit_logs_user_idx" ON "audit_logs" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "audit_logs_id_idx" ON "audit_logs" USING btree ("id");--> statement-breakpoint
CREATE INDEX "commission_payouts_attendant_idx" ON "commission_payouts" USING btree ("attendant_id");--> statement-breakpoint
CREATE INDEX "commissions_payout_idx" ON "commissions" USING btree ("payout_id");--> statement-breakpoint
CREATE INDEX "expenses_spent_on_idx" ON "expenses" USING btree ("spent_on");--> statement-breakpoint
CREATE INDEX "job_line_attendants_attendant_idx" ON "job_line_attendants" USING btree ("attendant_id");--> statement-breakpoint
CREATE INDEX "job_lines_job_idx" ON "job_lines" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "jobs_status_idx" ON "jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "jobs_created_idx" ON "jobs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "jobs_vehicle_idx" ON "jobs" USING btree ("vehicle_id");--> statement-breakpoint
CREATE INDEX "payments_job_idx" ON "payments" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "payments_created_idx" ON "payments" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "tip_handouts_attendant_idx" ON "tip_handouts" USING btree ("attendant_id");--> statement-breakpoint
CREATE INDEX "tips_attendant_idx" ON "tips" USING btree ("attendant_id");--> statement-breakpoint
CREATE INDEX "tips_job_idx" ON "tips" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "vehicles_customer_idx" ON "vehicles" USING btree ("customer_id");