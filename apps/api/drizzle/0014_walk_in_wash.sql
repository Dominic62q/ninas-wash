-- A wash for a walk-in customer can be booked with no number plate (13 Nov 2026).
-- Before, a wash always had a car. Now only a sale is forbidden from having one.
ALTER TABLE "jobs" DROP CONSTRAINT "jobs_car_matches_kind";--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_sale_has_no_car" CHECK ("jobs"."kind" = 'wash' OR "jobs"."vehicle_id" IS NULL);
