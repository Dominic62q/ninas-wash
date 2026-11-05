-- Expense categories become data, and an expense can carry photos of the paper receipt.
-- An expense keeps its category's name as text, so history reads the same and the "never edited" guard is untouched.
CREATE TABLE "expense_categories" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "expense_categories_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"name" text NOT NULL,
	"needs_note" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "expense_categories_name_not_blank" CHECK (length(btrim("name")) > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "expense_categories_name_unique" ON "expense_categories" (lower("name"));
--> statement-breakpoint
INSERT INTO "expense_categories" ("name", "needs_note", "sort_order") VALUES
	('Water', false, 1), ('Electricity', false, 2), ('Soap & chemicals', false, 3), ('Cloths & brushes', false, 4),
	('Fuel', false, 5), ('Repairs', false, 6), ('Transport', false, 7), ('Food', false, 8), ('Airtime & data', false, 9),
	('Wages', false, 10), ('Rent', false, 11), ('Other', true, 12);
--> statement-breakpoint
-- Anything already written down under a name that is not in the list stays readable: it is kept, switched off.
INSERT INTO "expense_categories" ("name", "active", "sort_order")
	SELECT DISTINCT ON (lower("category")) "category", false, 100 FROM "expenses"
	WHERE lower("category") NOT IN (SELECT lower("name") FROM "expense_categories");
--> statement-breakpoint

CREATE TABLE "expense_receipts" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "expense_receipts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"expense_id" bigint NOT NULL,
	"content_type" text NOT NULL,
	"size" integer NOT NULL,
	"data" bytea NOT NULL,
	"uploaded_by" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "expense_receipts_size_positive" CHECK ("size" > 0)
);
--> statement-breakpoint
ALTER TABLE "expense_receipts" ADD CONSTRAINT "expense_receipts_expense_id_expenses_id_fk" FOREIGN KEY ("expense_id") REFERENCES "public"."expenses"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "expense_receipts" ADD CONSTRAINT "expense_receipts_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "expense_receipts_expense_idx" ON "expense_receipts" ("expense_id");
--> statement-breakpoint

-- A receipt photo is evidence: it can be added to, never changed or removed.
CREATE FUNCTION expense_receipts_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'a receipt photo cannot be changed or removed'
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER expense_receipts_no_update BEFORE UPDATE ON "expense_receipts" FOR EACH ROW EXECUTE FUNCTION expense_receipts_guard();
--> statement-breakpoint
CREATE TRIGGER expense_receipts_no_delete BEFORE DELETE ON "expense_receipts" FOR EACH ROW EXECUTE FUNCTION expense_receipts_guard();
