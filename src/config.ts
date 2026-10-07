import { z } from "zod";

// Everything the process needs from its environment, validated once at boot.
// Integrations are mocked whenever their key is absent, so the whole app
// runs and tests offline. Production is the only environment allowed to
// refuse to start over a missing value.
const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(5100),
  PUBLIC_BASE_URL: z.string().url().default("http://localhost:5100"),
  DATABASE_URL: z.string().min(1),
  APP_SECRET: z.string().min(16, "APP_SECRET must be at least 16 characters"),
  ALLOWED_EMAILS: z.string().default(""),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  JOBS_ENABLED: z.enum(["true", "false"]).default("false"),
  ANTHROPIC_API_KEY: z.string().optional(),
  META_ACCESS_TOKEN: z.string().optional(),
  GOOGLE_ADS_DEVELOPER_TOKEN: z.string().optional(),
  GOOGLE_ADS_REFRESH_TOKEN: z.string().optional(),
});

export type AuthMode = "google" | "dev";

export interface Config {
  env: "development" | "test" | "production";
  isProduction: boolean;
  port: number;
  publicBaseUrl: string;
  databaseUrl: string;
  appSecret: string;
  allowedEmails: string[];
  auth:
    | { mode: "google"; clientId: string; clientSecret: string }
    | { mode: "dev" };
  jobsEnabled: boolean;
  mock: { ai: boolean; meta: boolean; googleAds: boolean };
}

function present(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`);
    throw new Error(`Invalid environment:\n${lines.join("\n")}`);
  }
  const e = parsed.data;
  const isProduction = e.NODE_ENV === "production";

  const allowedEmails = e.ALLOWED_EMAILS.split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
  if (isProduction && allowedEmails.length === 0) {
    throw new Error("ALLOWED_EMAILS must list at least one address in production");
  }

  let auth: Config["auth"];
  if (present(e.GOOGLE_CLIENT_ID) && present(e.GOOGLE_CLIENT_SECRET)) {
    auth = { mode: "google", clientId: e.GOOGLE_CLIENT_ID, clientSecret: e.GOOGLE_CLIENT_SECRET };
  } else if (isProduction) {
    // The dev sign-in form takes any allowlisted address on faith. It must
    // never exist on a public host.
    throw new Error("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are required in production");
  } else {
    auth = { mode: "dev" };
  }

  return {
    env: e.NODE_ENV,
    isProduction,
    port: e.PORT,
    publicBaseUrl: e.PUBLIC_BASE_URL.replace(/\/$/, ""),
    databaseUrl: e.DATABASE_URL,
    appSecret: e.APP_SECRET,
    allowedEmails,
    auth,
    jobsEnabled: e.JOBS_ENABLED === "true",
    mock: {
      ai: !present(e.ANTHROPIC_API_KEY),
      meta: !present(e.META_ACCESS_TOKEN),
      googleAds: !(present(e.GOOGLE_ADS_DEVELOPER_TOKEN) && present(e.GOOGLE_ADS_REFRESH_TOKEN)),
    },
  };
}
