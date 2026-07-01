import type { NextFunction, Request, RequestHandler, Response, Router } from "express";
import { z } from "zod";
import { callNumber } from "./calls/callNumber.js";
import { describeCall } from "./calls/getCall.js";
import { makeCall } from "./calls/makeCall.js";
import { checkReadiness } from "./calls/readiness.js";
import type { ServerContext } from "./http/context.js";
import { AppError } from "./lib/errors.js";
import { lookupBusiness } from "./lookup/index.js";

const lookupSchema = z.object({
  name: z.string().min(1),
  location: z.string().optional(),
  phone_number: z.string().optional(),
  utc_offset_minutes: z.number().int().optional(),
});

const callSchema = z.object({
  dial_token: z.string().min(1),
  objective: z.string().min(1),
  caller_name: z.string().min(1),
  context: z.string().optional(),
  behavior: z.string().optional(),
  max_duration_seconds: z.number().int().optional(),
});

const callNumberSchema = z.object({
  phone_number: z.string().min(1),
  objective: z.string().min(1),
  caller_name: z.string().min(1),
  context: z.string().optional(),
  behavior: z.string().optional(),
  recipient_name: z.string().optional(),
  utc_offset_minutes: z.number().int().optional(),
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
      const { name, location, phone_number, utc_offset_minutes } = parse(lookupSchema, req.body);
      const out = await lookupBusiness(
        {
          name,
          location: location ?? null,
          phoneNumber: phone_number ?? null,
          utcOffsetMinutes: utc_offset_minutes ?? null,
        },
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
          behavior: b.behavior ?? null,
          maxDurationSeconds: b.max_duration_seconds,
        },
        { client: ctx.client, cfg: ctx.cfg, bearerHash: ctx.bearerHash },
      );
      res.json(summary);
    }),
  );

  // call_number — direct personal dial (opt-in via SPEKO_ALLOW_DIRECT_DIAL). Allows mobiles;
  // keeps disclosure + quiet hours + objective screen + emergency/premium block.
  router.post(
    "/call-number",
    asyncHandler(async (req, res) => {
      const b = parse(callNumberSchema, req.body);
      const summary = await callNumber(
        {
          phoneNumber: b.phone_number,
          objective: b.objective,
          callerName: b.caller_name,
          context: b.context ?? null,
          behavior: b.behavior ?? null,
          recipientName: b.recipient_name ?? null,
          utcOffsetMinutes: b.utc_offset_minutes,
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
