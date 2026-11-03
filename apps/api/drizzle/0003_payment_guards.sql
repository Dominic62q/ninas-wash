-- Payment guards: money records the app cannot bend even by mistake.

-- 1. A payment is never edited. To correct one, void it and enter it again. A voided payment stays voided.
CREATE FUNCTION payments_guard_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'a voided payment cannot be changed'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.job_id IS DISTINCT FROM OLD.job_id
     OR NEW.method IS DISTINCT FROM OLD.method
     OR NEW.amount IS DISTINCT FROM OLD.amount
     OR NEW.momo_reference IS DISTINCT FROM OLD.momo_reference
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
CREATE TRIGGER payments_no_edit BEFORE UPDATE ON payments FOR EACH ROW EXECUTE FUNCTION payments_guard_update();
--> statement-breakpoint

-- 2. Payments never add up to more than the job costs. The job row is locked first, so two people paying at once cannot both fit.
CREATE FUNCTION payments_guard_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  job_total integer;
  already_paid integer;
BEGIN
  PERFORM 1 FROM jobs WHERE id = NEW.job_id FOR UPDATE;
  SELECT greatest(coalesce((SELECT sum(price_at_sale) FROM job_lines WHERE job_id = NEW.job_id), 0) - j.discount, 0)
    INTO job_total FROM jobs j WHERE j.id = NEW.job_id;
  SELECT coalesce(sum(amount), 0) INTO already_paid FROM payments WHERE job_id = NEW.job_id AND voided_at IS NULL;
  IF NEW.voided_at IS NULL AND already_paid + NEW.amount > job_total THEN
    RAISE EXCEPTION 'payments cannot be more than the job costs'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER payments_no_overpay BEFORE INSERT ON payments FOR EACH ROW EXECUTE FUNCTION payments_guard_insert();
