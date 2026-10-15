CREATE TABLE "compensations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"person_id" uuid NOT NULL,
	"type" text NOT NULL,
	"amount_enc" text NOT NULL,
	"currency" text DEFAULT 'EUR' NOT NULL,
	"interval" text,
	"valid_from" date NOT NULL,
	"comment" text,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "roles" ADD COLUMN "field_access" jsonb;--> statement-breakpoint
ALTER TABLE "document_categories" ADD COLUMN "data_category" text DEFAULT 'employment' NOT NULL;--> statement-breakpoint
ALTER TABLE "attribute_definitions" ADD COLUMN "category" text DEFAULT 'employment' NOT NULL;--> statement-breakpoint
ALTER TABLE "compensations" ADD CONSTRAINT "compensations_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "compensations_person_idx" ON "compensations" USING btree ("person_id");--> statement-breakpoint
UPDATE "document_categories" SET "data_category" = 'compensation' WHERE "name" = 'Arbeitsvertrag';--> statement-breakpoint
UPDATE "document_categories" SET "data_category" = 'payroll' WHERE "name" = 'Gehaltsabrechnungen';--> statement-breakpoint
UPDATE "document_categories" SET "data_category" = 'personal' WHERE "name" = 'Bescheinigungen';--> statement-breakpoint
UPDATE "attribute_definitions" SET "category" = 'payroll' WHERE "sensitive" = 1;
