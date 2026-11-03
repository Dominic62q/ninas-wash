CREATE TYPE "public"."sms_credit_kind" AS ENUM('topup', 'adjust');--> statement-breakpoint
CREATE TYPE "public"."sms_event" AS ENUM('job_booked', 'job_ready', 'payment_received', 'manual');--> statement-breakpoint
CREATE TYPE "public"."sms_status" AS ENUM('sent', 'failed', 'skipped');--> statement-breakpoint
CREATE TABLE "sms_credit_entries" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "sms_credit_entries_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"kind" "sms_credit_kind" NOT NULL,
	"credits" integer NOT NULL,
	"note" text,
	"created_by" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sms_messages" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "sms_messages_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"event" "sms_event" NOT NULL,
	"status" "sms_status" NOT NULL,
	"phone" text NOT NULL,
	"body" text NOT NULL,
	"segments" integer NOT NULL,
	"gateway_code" text,
	"gateway_ref" text,
	"error" text,
	"customer_id" bigint,
	"job_id" bigint,
	"sent_by" bigint,
	"idem_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sms_messages_idem_key_unique" UNIQUE("idem_key"),
	CONSTRAINT "sms_messages_segments_not_negative" CHECK ("sms_messages"."segments" >= 0)
);
--> statement-breakpoint
CREATE TABLE "sms_templates" (
	"event" "sms_event" PRIMARY KEY NOT NULL,
	"body" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"updated_by" bigint,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sms_credit_entries" ADD CONSTRAINT "sms_credit_entries_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_messages" ADD CONSTRAINT "sms_messages_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_messages" ADD CONSTRAINT "sms_messages_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_messages" ADD CONSTRAINT "sms_messages_sent_by_users_id_fk" FOREIGN KEY ("sent_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_templates" ADD CONSTRAINT "sms_templates_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sms_messages_created_idx" ON "sms_messages" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "sms_messages_customer_idx" ON "sms_messages" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "sms_messages_job_idx" ON "sms_messages" USING btree ("job_id");
--> statement-breakpoint
-- Guards for customer texts. The send record and the credit record are history: they are never edited or deleted.
CREATE TRIGGER sms_messages_no_delete BEFORE DELETE ON sms_messages FOR EACH ROW EXECUTE FUNCTION forbid_delete();
--> statement-breakpoint
CREATE TRIGGER sms_credit_entries_no_delete BEFORE DELETE ON sms_credit_entries FOR EACH ROW EXECUTE FUNCTION forbid_delete();
--> statement-breakpoint
CREATE TRIGGER sms_messages_no_edit BEFORE UPDATE ON sms_messages FOR EACH ROW EXECUTE FUNCTION forbid_update();
--> statement-breakpoint
CREATE TRIGGER sms_credit_entries_no_edit BEFORE UPDATE ON sms_credit_entries FOR EACH ROW EXECUTE FUNCTION forbid_update();
