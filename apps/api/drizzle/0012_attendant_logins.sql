-- An attendant can have a login of their own. The login is an ordinary user, tied to one attendant,
-- and what it may do comes from its role like everyone else's.
ALTER TABLE "users" ADD COLUMN "attendant_id" bigint;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_attendant_id_unique" UNIQUE("attendant_id");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_attendant_id_attendants_id_fk" FOREIGN KEY ("attendant_id") REFERENCES "public"."attendants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- A role to start from: it can see their own washes and what they have earned, and nothing else.
INSERT INTO "roles" ("name", "locked", "permissions") VALUES ('Attendant', false, ARRAY['self.view']::text[]) ON CONFLICT ("name") DO NOTHING;
