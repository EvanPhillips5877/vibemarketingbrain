import { existsSync } from "node:fs";
import path from "node:path";
import cookieParser from "cookie-parser";
import express, { type ErrorRequestHandler, type Express } from "express";
import { googleIdentityProvider, type IdentityProvider } from "./auth/google.js";
import { attachSession, requireCsrf } from "./auth/middleware.js";
import { authRouter } from "./auth/routes.js";
import type { Config } from "./config.js";
import type { Db } from "./db/client.js";
import { aiClientFor, AiOutputInvalid, type AiClient } from "./ai/client.js";
import { AdapterRegistry } from "./channels/registry.js";
import { brandsRouter } from "./routes/brands.js";
import { analysisRouter } from "./routes/analysis.js";
import { creativeRouter } from "./routes/creative.js";
import { missionsRouter } from "./routes/missions.js";
import { commandRouter } from "./routes/command.js";
import { learningsRouter } from "./routes/learnings.js";
import { factsRouter } from "./routes/facts.js";
import { proposalsRouter } from "./routes/proposals.js";
import { meRouter } from "./routes/me.js";

export interface AppDeps {
  config: Config;
  db: Db;
  registry?: AdapterRegistry;
  ai?: AiClient;
  /** Override for tests. Defaults to Google in google mode, none in dev mode. */
  identity?: IdentityProvider | null;
}

// Listen-free so tests drive the real app through supertest.
export function createApp(deps: AppDeps): Express {
  const { config, db } = deps;
  const identity =
    deps.identity !== undefined
      ? deps.identity
      : config.auth.mode === "google"
        ? googleIdentityProvider(config.auth.clientId, config.auth.clientSecret)
        : null;

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", config.isProduction ? 1 : false);
  app.use(express.json({ limit: "1mb" }));
  app.use(cookieParser());

  app.get("/health", (_req, res) => {
    res.json({ ok: true, env: config.env });
  });

  app.use(attachSession(db, config.allowedEmails));
  app.use("/api", requireCsrf);

  app.use(authRouter({ config, db, identity }));
  app.use(meRouter(config));
  const registry = deps.registry ?? new AdapterRegistry(config);
  app.use(brandsRouter(db, registry));
  app.use(proposalsRouter(db, registry));
  const ai = deps.ai ?? aiClientFor(db, config.anthropicApiKey);
  app.use(factsRouter(db, ai));
  app.use(analysisRouter(db, ai));
  app.use(creativeRouter(db, ai));
  app.use(missionsRouter(db, ai));
  app.use(commandRouter(db, ai));
  app.use(learningsRouter(db));

  app.all("/api/{*rest}", (_req, res) => {
    res.status(404).json({ error: "not found" });
  });

  // The built web app, when it exists (production image). Dev uses Vite's
  // own server with a proxy to this one.
  const webDist = path.resolve(process.cwd(), "dist/web");
  if (existsSync(webDist)) {
    app.use(express.static(webDist, { index: false }));
    app.get("/{*rest}", (req, res, next) => {
      if (req.path.startsWith("/auth/")) {
        next();
        return;
      }
      res.sendFile(path.join(webDist, "index.html"));
    });
  }

  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    // Never echo the error: it may carry a token or a connection string.
    console.error(err);
    if (res.headersSent) return;
    if (err instanceof AiOutputInvalid) {
      res.status(422).json({ error: `The model could not stay within the platform limits after a retry (${err.fn}). ${err.issues.slice(0, 3).join("; ")}` });
      return;
    }
    res.status(500).json({ error: "internal error" });
  };
  app.use(onError);

  return app;
}
