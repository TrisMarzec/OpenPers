ALTER TABLE "company" ADD COLUMN "logo_key" text;--> statement-breakpoint
ALTER TABLE "company" ADD COLUMN "logo_mime" text;--> statement-breakpoint
ALTER TABLE "company" ADD COLUMN "logo_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "persons" ADD COLUMN "photo_key" text;--> statement-breakpoint
ALTER TABLE "persons" ADD COLUMN "photo_mime" text;--> statement-breakpoint
ALTER TABLE "persons" ADD COLUMN "photo_updated_at" timestamp with time zone;