ALTER TABLE "commission_payouts" ADD COLUMN "idem_key" text;--> statement-breakpoint
ALTER TABLE "commission_payouts" ADD COLUMN "voided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "commission_payouts" ADD COLUMN "voided_by" bigint;--> statement-breakpoint
ALTER TABLE "commission_payouts" ADD COLUMN "void_reason" text;--> statement-breakpoint
ALTER TABLE "tips" ADD COLUMN "idem_key" text;--> statement-breakpoint
ALTER TABLE "tips" ADD COLUMN "voided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tips" ADD COLUMN "voided_by" bigint;--> statement-breakpoint
ALTER TABLE "tips" ADD COLUMN "void_reason" text;--> statement-breakpoint
ALTER TABLE "commission_payouts" ADD CONSTRAINT "commission_payouts_voided_by_users_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tips" ADD CONSTRAINT "tips_voided_by_users_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_payouts" ADD CONSTRAINT "commission_payouts_idem_key_unique" UNIQUE("idem_key");--> statement-breakpoint
ALTER TABLE "tips" ADD CONSTRAINT "tips_idem_key_unique" UNIQUE("idem_key");--> statement-breakpoint
ALTER TABLE "commission_payouts" ADD CONSTRAINT "commission_payouts_void_complete" CHECK (("commission_payouts"."voided_at" IS NULL) = ("commission_payouts"."voided_by" IS NULL) AND ("commission_payouts"."voided_at" IS NULL) = ("commission_payouts"."void_reason" IS NULL));--> statement-breakpoint
ALTER TABLE "tips" ADD CONSTRAINT "tips_void_complete" CHECK (("tips"."voided_at" IS NULL) = ("tips"."voided_by" IS NULL) AND ("tips"."voided_at" IS NULL) = ("tips"."void_reason" IS NULL));
--> statement-breakpoint
-- Guards for commissions, payouts, tips and handouts. Money records are voided, never edited.

-- 1. A commission's amount is fixed when it is earned. It can only be reversed (never back), or linked to a payout.
CREATE FUNCTION commissions_guard_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.line_attendant_id IS DISTINCT FROM OLD.line_attendant_id
     OR NEW.amount IS DISTINCT FROM OLD.amount
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a commission cannot be edited'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status = 'reversed' AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'a reversed commission cannot be brought back'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER commissions_no_edit BEFORE UPDATE ON commissions FOR EACH ROW EXECUTE FUNCTION commissions_guard_update();
--> statement-breakpoint

-- 2. A payout is never edited. To correct one, void it and enter it again. A voided payout stays voided.
CREATE FUNCTION commission_payouts_guard_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'a voided payout cannot be changed'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.attendant_id IS DISTINCT FROM OLD.attendant_id
     OR NEW.amount IS DISTINCT FROM OLD.amount
     OR NEW.method IS DISTINCT FROM OLD.method
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
CREATE TRIGGER commission_payouts_no_edit BEFORE UPDATE ON commission_payouts FOR EACH ROW EXECUTE FUNCTION commission_payouts_guard_update();
--> statement-breakpoint

-- 3. Payouts never add up to more than the attendant has earned. The attendant row is locked first, so two people paying at once cannot both fit.
CREATE FUNCTION commission_payouts_guard_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  earned integer;
  paid_out integer;
BEGIN
  PERFORM 1 FROM attendants WHERE id = NEW.attendant_id FOR UPDATE;
  SELECT coalesce(sum(c.amount), 0) INTO earned
    FROM commissions c
    JOIN job_line_attendants jla ON jla.id = c.line_attendant_id
    JOIN job_lines jl ON jl.id = jla.job_line_id
    WHERE jla.attendant_id = NEW.attendant_id AND c.status = 'earned';
  SELECT coalesce(sum(amount), 0) INTO paid_out
    FROM commission_payouts WHERE attendant_id = NEW.attendant_id AND voided_at IS NULL;
  IF NEW.voided_at IS NULL AND paid_out + NEW.amount > earned THEN
    RAISE EXCEPTION 'payouts cannot be more than has been earned'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER commission_payouts_no_overpay BEFORE INSERT ON commission_payouts FOR EACH ROW EXECUTE FUNCTION commission_payouts_guard_insert();
--> statement-breakpoint

-- 4. A tip is never edited. It can be handed out once, or voided while it is still held. A voided tip stays voided.
CREATE FUNCTION tips_guard_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'a voided tip cannot be changed'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.attendant_id IS DISTINCT FROM OLD.attendant_id
     OR NEW.job_id IS DISTINCT FROM OLD.job_id
     OR NEW.amount IS DISTINCT FROM OLD.amount
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.recorded_by IS DISTINCT FROM OLD.recorded_by
     OR NEW.idem_key IS DISTINCT FROM OLD.idem_key
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a tip cannot be edited: void it and enter it again'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.handout_id IS NOT NULL AND (NEW.handout_id IS DISTINCT FROM OLD.handout_id OR NEW.voided_at IS NOT NULL) THEN
    RAISE EXCEPTION 'a tip that was handed out cannot be changed'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER tips_no_edit BEFORE UPDATE ON tips FOR EACH ROW EXECUTE FUNCTION tips_guard_update();
--> statement-breakpoint

-- 5. A handout is a receipt. It is never edited.
CREATE FUNCTION forbid_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows cannot be edited', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER tip_handouts_no_edit BEFORE UPDATE ON tip_handouts FOR EACH ROW EXECUTE FUNCTION forbid_update();
