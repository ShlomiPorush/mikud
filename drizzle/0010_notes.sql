CREATE TABLE "note_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"note_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"project_id" uuid,
	"author_kind" text NOT NULL,
	"author_label" text,
	"restored_from" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "note_versions_note_version_unique" UNIQUE("note_id","version"),
	CONSTRAINT "note_versions_author_kind_check" CHECK ("author_kind" in ('owner', 'agent', 'bot', 'sync', 'system')),
	CONSTRAINT "note_versions_version_check" CHECK ("note_versions"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" text NOT NULL,
	"created_by_label" text,
	"updated_by" text NOT NULL,
	"updated_by_label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notes_created_by_check" CHECK ("created_by" in ('owner', 'agent', 'bot', 'sync', 'system')),
	CONSTRAINT "notes_updated_by_check" CHECK ("updated_by" in ('owner', 'agent', 'bot', 'sync', 'system')),
	CONSTRAINT "notes_version_check" CHECK ("notes"."version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "telegram_updates" DROP CONSTRAINT "telegram_updates_outcome_check";--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "note_id" uuid;--> statement-breakpoint
ALTER TABLE "telegram_updates" ADD COLUMN "item_id" uuid;--> statement-breakpoint
ALTER TABLE "telegram_updates" ADD COLUMN "note_id" uuid;--> statement-breakpoint
ALTER TABLE "note_versions" ADD CONSTRAINT "note_versions_note_id_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "note_versions_author_created_idx" ON "note_versions" USING btree ("author_kind","created_at");--> statement-breakpoint
CREATE INDEX "notes_project_idx" ON "notes" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "notes_updated_idx" ON "notes" USING btree ("updated_at","id");--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_note_id_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."notes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_updates" ADD CONSTRAINT "telegram_updates_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_updates" ADD CONSTRAINT "telegram_updates_note_id_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."notes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_updates" ADD CONSTRAINT "telegram_updates_outcome_check" CHECK ("outcome" in ('item_created', 'note_created', 'ignored', 'refused'));