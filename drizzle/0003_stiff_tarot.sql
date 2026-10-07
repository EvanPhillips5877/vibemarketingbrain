CREATE TABLE "brand_pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"brand_id" uuid NOT NULL,
	"url" text NOT NULL,
	"title" text,
	"description" text,
	"headings" text[] DEFAULT '{}'::text[] NOT NULL,
	"text" text DEFAULT '' NOT NULL,
	"http_status" integer,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "uq_brand_facts_live_key";--> statement-breakpoint
ALTER TABLE "brand_pages" ADD CONSTRAINT "brand_pages_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_brand_pages_url" ON "brand_pages" USING btree ("brand_id","url");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_brand_facts_key_status" ON "brand_facts" USING btree ("brand_id","category","key","status") WHERE status <> 'retired';