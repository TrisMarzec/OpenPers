CREATE TABLE "feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"person_id" uuid NOT NULL,
	"author_person_id" uuid,
	"kind" text NOT NULL,
	"text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "goals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"person_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"due_date" date,
	"progress" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review_cycles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"period_start" date,
	"period_end" date,
	"due_date" date,
	"status" text DEFAULT 'draft' NOT NULL,
	"self_review" boolean DEFAULT true NOT NULL,
	"manager_review" boolean DEFAULT true NOT NULL,
	"peer_review" boolean DEFAULT false NOT NULL,
	"questions" jsonb NOT NULL,
	"participant_person_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"org_unit_id" uuid,
	"started_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review_releases" (
	"cycle_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"released_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_by_user_id" uuid,
	CONSTRAINT "review_releases_cycle_id_person_id_pk" PRIMARY KEY("cycle_id","person_id")
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cycle_id" uuid NOT NULL,
	"reviewee_id" uuid NOT NULL,
	"reviewer_person_id" uuid NOT NULL,
	"type" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"answers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"submitted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "survey_participants" (
	"survey_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"submitted_on" date NOT NULL,
	CONSTRAINT "survey_participants_survey_id_user_id_pk" PRIMARY KEY("survey_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "survey_responses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"survey_id" uuid NOT NULL,
	"org_unit_id" uuid,
	"answers" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "surveys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"intro" text,
	"anonymous" boolean DEFAULT true NOT NULL,
	"org_unit_id" uuid,
	"questions" jsonb NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"closes_at" date,
	"opened_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"reminder_sent_at" timestamp with time zone,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_author_person_id_persons_id_fk" FOREIGN KEY ("author_person_id") REFERENCES "public"."persons"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_releases" ADD CONSTRAINT "review_releases_cycle_id_review_cycles_id_fk" FOREIGN KEY ("cycle_id") REFERENCES "public"."review_cycles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_releases" ADD CONSTRAINT "review_releases_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_cycle_id_review_cycles_id_fk" FOREIGN KEY ("cycle_id") REFERENCES "public"."review_cycles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_reviewee_id_persons_id_fk" FOREIGN KEY ("reviewee_id") REFERENCES "public"."persons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_reviewer_person_id_persons_id_fk" FOREIGN KEY ("reviewer_person_id") REFERENCES "public"."persons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey_participants" ADD CONSTRAINT "survey_participants_survey_id_surveys_id_fk" FOREIGN KEY ("survey_id") REFERENCES "public"."surveys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey_responses" ADD CONSTRAINT "survey_responses_survey_id_surveys_id_fk" FOREIGN KEY ("survey_id") REFERENCES "public"."surveys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "feedback_person_idx" ON "feedback" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "goals_person_idx" ON "goals" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "reviews_cycle_reviewee_idx" ON "reviews" USING btree ("cycle_id","reviewee_id");--> statement-breakpoint
CREATE INDEX "reviews_reviewer_idx" ON "reviews" USING btree ("reviewer_person_id");--> statement-breakpoint
CREATE INDEX "survey_responses_survey_idx" ON "survey_responses" USING btree ("survey_id");--> statement-breakpoint
UPDATE "roles" SET "permissions" = "permissions" || '["performance.manage","surveys.manage"]'::jsonb WHERE "key" IN ('admin', 'hr') AND NOT ("permissions" @> '["performance.manage"]'::jsonb);
