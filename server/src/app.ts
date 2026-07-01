import { timingSafeEqual } from "node:crypto";
import express from "express";
import type { ErrorRequestHandler, Request, Response } from "express";
import type { ServerContext } from "./http/context.js";
import { AppError } from "./lib/errors.js";
import { registerRoutes } from "./routes.js";

/** Constant-time string compare (equal length required) — avoids leaking the key via timing. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function buildApp(ctx: ServerContext): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "256kb" }));

  // Open health check (before any auth gate).
  app.get("/healthz", (_req: Request, res: Response) => {
    res.json({ ok: true, demo: ctx.cfg.demo.enabled });
  });

  // Optional shared-secret gate between the MCP tier and this server.
  if (ctx.cfg.internalKey) {
    app.use((req, res, next) => {
      const provided = req.headers["x-internal-key"];
      if (typeof provided !== "string" || !safeEqual(provided, ctx.cfg.internalKey as string)) {
        res.status(401).json({
          error: "Unauthorized: missing or incorrect x-internal-key",
          next_step: "Set MCP_INTERNAL_KEY to the same value on the MCP tier and the demo server.",
        });
        return;
      }
      next();
    });
  }

  const router = express.Router();
  registerRoutes(router, ctx);
  app.use(router);

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: "Not found", next_step: null });
  });

  const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
    const e = err instanceof AppError ? err : new AppError((err as Error)?.message ?? "Internal error");
    const message = e.nextStep ? `${e.message}; next_step=${e.nextStep}` : e.message;
    res.status(e.statusCode).json({ error: message, next_step: e.nextStep ?? null });
  };
  app.use(errorHandler);

  return app;
}
