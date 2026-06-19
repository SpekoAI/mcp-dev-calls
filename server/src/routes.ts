import type { NextFunction, Request, RequestHandler, Response, Router } from "express";
import { z } from "zod";
import { describeCall } from "./calls/getCall.js";
import { makeCall } from "./calls/makeCall.js";
import { checkReadiness } from "./calls/readiness.js";
import type { ServerContext } from "./http/context.js";
import { AppError } from "./lib/errors.js";
import { lookupBusiness } from "./lookup/index.js";

const lookupSchema = z.object({
  name: z.string().min(1),
  location: z.string().optional(),
});

const callSchema = z.object({
  dial_token: z.string().min(1),
  objective: z.string().min(1),
  caller_name: z.string().min(1),
  context: z.string().optional(),
  max_duration_seconds: z.number().int().optional(),
});

/** Express 5 forwards rejected promises to the error handler, but wrap explicitly to be safe. */
function asyncHandler(fn: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) {
    const detail = r.error.issues.map((i) => `${i.path.join(".") || "(body)"}: ${i.message}`).join("; ");
    throw new AppError(`Invalid request: ${detail}`, {
      statusCode: 400,
      nextStep: "Fix the listed request fields and retry.",
    });
  }
  return r.data;
}

export function registerRoutes(router: Router, ctx: ServerContext): void {
  router.post(
    "/lookup",
    asyncHandler(async (req, res) => {
      const { name, location } = parse(lookupSchema, req.body);
      const out = await lookupBusiness(
        { name, location: location ?? null },
        { cfg: ctx.cfg, bearerHash: ctx.bearerHash },
      );
      res.json(out);
    }),
  );

  router.post(
    "/call",
    asyncHandler(async (req, res) => {
      const b = parse(callSchema, req.body);
      const summary = await makeCall(
        {
          dialToken: b.dial_token,
          objective: b.objective,
          callerName: b.caller_name,
          context: b.context ?? null,
          maxDurationSeconds: b.max_duration_seconds,
        },
        { client: ctx.client, cfg: ctx.cfg, bearerHash: ctx.bearerHash },
      );
      res.json(summary);
    }),
  );

  router.get(
    "/readiness",
    asyncHandler(async (_req, res) => {
      const report = await checkReadiness(ctx.client);
      res.json(report);
    }),
  );

  // get_call — recovery/diagnosis for an existing call. Read-only; never re-dials.
  router.get(
    "/call/:id",
    asyncHandler(async (req, res) => {
      const id = String(req.params.id ?? "").trim();
      if (!id) {
        throw new AppError("Missing call id.", { statusCode: 400, nextStep: "Call GET /call/<call_id>." });
      }
      const summary = await describeCall(id, ctx.client);
      res.json(summary);
    }),
  );
}
