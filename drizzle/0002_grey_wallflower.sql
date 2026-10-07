ALTER TABLE "brands" ADD COLUMN "events_export_url" text;--> statement-breakpoint
ALTER TABLE "brands" ADD COLUMN "events_export_secret_ref" text;--> statement-breakpoint
ALTER TABLE "brands" ADD COLUMN "events_cursor" text;--> statement-breakpoint
ALTER TABLE "brands" ADD COLUMN "events_pulled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "customer_events" ADD COLUMN "attributed_channel" text;--> statement-breakpoint
ALTER TABLE "customer_events" ADD COLUMN "plan" text;--> statement-breakpoint
CREATE INDEX "idx_customer_events_unattributed" ON "customer_events" USING btree ("brand_id") WHERE attribution_method is null;