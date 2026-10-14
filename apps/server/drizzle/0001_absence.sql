CREATE TABLE "absence_periods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"person_id" uuid NOT NULL,
	"type_id" uuid NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date,
	"start_half" boolean DEFAULT false NOT NULL,
	"end_half" boolean DEFAULT false NOT NULL,
	"status" text NOT NULL,
	"comment" text,
	"substitute_person_id" uuid,
	"requested_by_user_id" uuid,
	"decided_by_user_id" uuid,
	"decided_at" timestamp with time zone,
	"decision_comment" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "absence_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"absence_type_id" uuid NOT NULL,
	"name" text NOT NULL,
	"annual_entitlement" real NOT NULL,
	"carryover_max" real DEFAULT 0 NOT NULL,
	"carryover_expiry" text DEFAULT '03-31' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"allow_negative" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "absence_policy_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"person_id" uuid NOT NULL,
	"policy_id" uuid NOT NULL,
	"valid_from" date NOT NULL,
	"entitlement_override" real
);
--> statement-breakpoint
CREATE TABLE "absence_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"category" text NOT NULL,
	"unit" text DEFAULT 'DAY' NOT NULL,
	"requires_approval" boolean DEFAULT true NOT NULL,
	"counts_against_balance" boolean DEFAULT false NOT NULL,
	"allows_substitute" boolean DEFAULT false NOT NULL,
	"allows_half_days" boolean DEFAULT true NOT NULL,
	"certificate_required_after_days" integer,
	"color" text DEFAULT '#3b82f6' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "balance_adjustments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"person_id" uuid NOT NULL,
	"type_id" uuid NOT NULL,
	"year" integer NOT NULL,
	"amount" real NOT NULL,
	"reason" text NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "custom_holidays" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"date" date NOT NULL,
	"name" text NOT NULL,
	"region" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "absence_periods" ADD CONSTRAINT "absence_periods_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "absence_periods" ADD CONSTRAINT "absence_periods_type_id_absence_types_id_fk" FOREIGN KEY ("type_id") REFERENCES "public"."absence_types"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "absence_periods" ADD CONSTRAINT "absence_periods_substitute_person_id_persons_id_fk" FOREIGN KEY ("substitute_person_id") REFERENCES "public"."persons"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "absence_policies" ADD CONSTRAINT "absence_policies_absence_type_id_absence_types_id_fk" FOREIGN KEY ("absence_type_id") REFERENCES "public"."absence_types"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "absence_policy_assignments" ADD CONSTRAINT "absence_policy_assignments_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "absence_policy_assignments" ADD CONSTRAINT "absence_policy_assignments_policy_id_absence_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."absence_policies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "balance_adjustments" ADD CONSTRAINT "balance_adjustments_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "balance_adjustments" ADD CONSTRAINT "balance_adjustments_type_id_absence_types_id_fk" FOREIGN KEY ("type_id") REFERENCES "public"."absence_types"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "absence_periods_person_idx" ON "absence_periods" USING btree ("person_id","start_date");--> statement-breakpoint
CREATE INDEX "absence_periods_status_idx" ON "absence_periods" USING btree ("status");--> statement-breakpoint
CREATE INDEX "policy_assignments_person_idx" ON "absence_policy_assignments" USING btree ("person_id");