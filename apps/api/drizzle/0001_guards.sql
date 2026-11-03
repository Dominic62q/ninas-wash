-- Database-level guards: rules the app cannot break even by mistake.
-- More cross-row rules (no overpayment, closed-day lock, payments only voidable) arrive with the phases that use them.

-- 1. The audit log can only ever be added to.
CREATE FUNCTION forbid_audit_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only: % is not allowed', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER audit_logs_no_update_delete
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION forbid_audit_change();
--> statement-breakpoint
CREATE TRIGGER audit_logs_no_truncate
  BEFORE TRUNCATE ON audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_change();
--> statement-breakpoint

-- 2. Records that matter are voided, never deleted.
CREATE FUNCTION forbid_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are voided, never deleted', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER users_no_delete BEFORE DELETE ON users FOR EACH ROW EXECUTE FUNCTION forbid_delete();
--> statement-breakpoint
CREATE TRIGGER jobs_no_delete BEFORE DELETE ON jobs FOR EACH ROW EXECUTE FUNCTION forbid_delete();
--> statement-breakpoint
CREATE TRIGGER job_lines_no_delete BEFORE DELETE ON job_lines FOR EACH ROW EXECUTE FUNCTION forbid_delete();
--> statement-breakpoint
CREATE TRIGGER job_line_attendants_no_delete BEFORE DELETE ON job_line_attendants FOR EACH ROW EXECUTE FUNCTION forbid_delete();
--> statement-breakpoint
CREATE TRIGGER payments_no_delete BEFORE DELETE ON payments FOR EACH ROW EXECUTE FUNCTION forbid_delete();
--> statement-breakpoint
CREATE TRIGGER commissions_no_delete BEFORE DELETE ON commissions FOR EACH ROW EXECUTE FUNCTION forbid_delete();
--> statement-breakpoint
CREATE TRIGGER commission_payouts_no_delete BEFORE DELETE ON commission_payouts FOR EACH ROW EXECUTE FUNCTION forbid_delete();
--> statement-breakpoint
CREATE TRIGGER tips_no_delete BEFORE DELETE ON tips FOR EACH ROW EXECUTE FUNCTION forbid_delete();
--> statement-breakpoint
CREATE TRIGGER tip_handouts_no_delete BEFORE DELETE ON tip_handouts FOR EACH ROW EXECUTE FUNCTION forbid_delete();
--> statement-breakpoint
CREATE TRIGGER expenses_no_delete BEFORE DELETE ON expenses FOR EACH ROW EXECUTE FUNCTION forbid_delete();
--> statement-breakpoint
CREATE TRIGGER daily_closes_no_delete BEFORE DELETE ON daily_closes FOR EACH ROW EXECUTE FUNCTION forbid_delete();
