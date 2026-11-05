-- "Share receipt": one unguessable link token per job, so a customer can open their receipt without signing in.
CREATE TABLE "job_receipt_links" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "job_receipt_links_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"job_id" bigint NOT NULL,
	"token" text NOT NULL,
	"created_by" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_receipt_links_job_id_unique" UNIQUE("job_id"),
	CONSTRAINT "job_receipt_links_token_unique" UNIQUE("token"),
	CONSTRAINT "job_receipt_links_token_long" CHECK (length("token") >= 20)
);--> statement-breakpoint
ALTER TABLE "job_receipt_links" ADD CONSTRAINT "job_receipt_links_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_receipt_links" ADD CONSTRAINT "job_receipt_links_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
