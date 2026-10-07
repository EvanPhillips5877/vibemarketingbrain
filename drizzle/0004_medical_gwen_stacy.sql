CREATE TABLE "analysis_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"brand_id" uuid NOT NULL,
	"kind" text DEFAULT 'morning' NOT NULL,
	"window_from" date NOT NULL,
	"window_to" date NOT NULL,
	"pack" jsonb NOT NULL,
	"findings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"analysis" jsonb NOT NULL,
	"dropped" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ai_run_id" uuid,
	"is_mock" boolean DEFAULT false NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "analysis_reports" ADD CONSTRAINT "analysis_reports_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_analysis_reports_brand_created" ON "analysis_reports" USING btree ("brand_id","created_at");