-- Roles become data: a name plus a list of permissions, instead of three fixed words in the code.
-- The owner role is locked (it can do everything and cannot be changed). Manager and Cashier start with
-- what they could do before, and the owner can change them from then on.
CREATE TABLE "roles" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "roles_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"name" text NOT NULL,
	"locked" boolean DEFAULT false NOT NULL,
	"permissions" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roles_name_unique" UNIQUE("name"),
	CONSTRAINT "roles_name_not_blank" CHECK (length(btrim("name")) > 0)
);
--> statement-breakpoint
INSERT INTO "roles" ("name", "locked", "permissions") VALUES
	('Owner', true, '{}'::text[]),
	('Manager', false, ARRAY['job.create', 'job.advance', 'job.dispatch', 'job.dispatch_with_balance', 'job.void', 'payment.record', 'payment.void', 'customer.manage', 'expense.create', 'expense.void', 'commission.view', 'commission.payout', 'tip.record', 'tip.handout', 'tip.void', 'dailyclose.close', 'dailyclose.see_expected', 'dailyclose.reopen', 'dashboard.view', 'audit.read', 'sms.view', 'sms.send', 'user.reset_password']::text[]),
	('Cashier', false, ARRAY['job.create', 'job.advance', 'job.dispatch', 'payment.record', 'customer.manage', 'expense.create', 'tip.record', 'dailyclose.close', 'dashboard.view']::text[]);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "role_id" bigint;
--> statement-breakpoint
UPDATE "users" SET "role_id" = (SELECT "id" FROM "roles" WHERE lower("roles"."name") = "users"."role"::text);
--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "role_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "users_role_idx" ON "users" ("role_id");
--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "role";
--> statement-breakpoint
DROP TYPE "public"."role";
--> statement-breakpoint
-- The owner role stays as it is, whatever anyone tries.
CREATE FUNCTION "roles_protect_owner"() RETURNS trigger AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN
		IF OLD."locked" THEN RAISE EXCEPTION 'The owner role cannot be removed'; END IF;
		RETURN OLD;
	END IF;
	IF OLD."locked" AND (NEW."locked" IS DISTINCT FROM OLD."locked" OR NEW."name" IS DISTINCT FROM OLD."name") THEN
		RAISE EXCEPTION 'The owner role cannot be changed';
	END IF;
	IF NEW."locked" AND NOT OLD."locked" THEN
		RAISE EXCEPTION 'Only the owner role is locked';
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "roles_protect_owner" BEFORE UPDATE OR DELETE ON "roles" FOR EACH ROW EXECUTE FUNCTION "roles_protect_owner"();
