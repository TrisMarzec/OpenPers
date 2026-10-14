ALTER TABLE "attendance_periods" ADD COLUMN "break_minutes" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "attendance_periods" ADD COLUMN "location" text;