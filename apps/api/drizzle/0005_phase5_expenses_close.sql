ALTER TABLE "daily_closes" ADD COLUMN "note" text;--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "idem_key" text;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_idem_key_unique" UNIQUE("idem_key");--> statement-breakpoint
-- Guards for expenses and the daily close. Money records are voided, never edited.

-- 1. An expense is never edited. To correct one, void it and enter it again. A voided expense stays voided.
CREATE FUNCTION expenses_guard_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'a voided expense cannot be changed'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.category IS DISTINCT FROM OLD.category
     OR NEW.amount IS DISTINCT FROM OLD.amount
     OR NEW.method IS DISTINCT FROM OLD.method
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
CREATE TRIGGER expenses_no_edit BEFORE UPDATE ON expenses FOR EACH ROW EXECUTE FUNCTION expenses_guard_update();
--> statement-breakpoint

-- 2. A closed day can only be reopened (with who and why, nothing else touched). A reopened day can only be closed again.
-- The day itself never moves.
CREATE FUNCTION daily_closes_guard_update() RETURNS trigger LANGUAGE plpgsql AS $$
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
       OR NEW.momo_total IS DISTINCT FROM OLD.momo_total
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
--> statement-breakpoint
CREATE TRIGGER daily_closes_no_edit BEFORE UPDATE ON daily_closes FOR EACH ROW EXECUTE FUNCTION daily_closes_guard_update();
