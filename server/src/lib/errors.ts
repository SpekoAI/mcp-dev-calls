/**
 * Demo-server error model. Every error carries an HTTP status and an actionable
 * `next_step`; routes serialize it to `{ error, next_step }` so the MCP tier can
 * relay a self-correcting message to the coding agent.
 */
export class AppError extends Error {
  readonly statusCode: number;
  readonly nextStep: string | undefined;
  /** Upstream machine code (e.g. the platform's AGENT_NOT_FOUND) preserved for callers that branch on it. */
  readonly code: string | undefined;
  constructor(message: string, opts: { statusCode?: number; nextStep?: string; code?: string } = {}) {
    super(message);
    this.name = "AppError";
    this.statusCode = opts.statusCode ?? 500;
    this.nextStep = opts.nextStep;
    this.code = opts.code;
  }
}

/** A pre-dial / business-rule rejection (HTTP 422). */
export class RejectionError extends AppError {
  constructor(message: string, nextStep?: string, code?: string) {
    super(message, { statusCode: 422, nextStep, code });
    this.name = "RejectionError";
  }
}

const PUBLIC_ERROR_CODES = new Set(["CALL_ME_NOT_CONFIGURED"]);

export function publicErrorCode(error: AppError): string | null {
  return error.code && PUBLIC_ERROR_CODES.has(error.code) ? error.code : null;
}

export function withNextStep(message: string, nextStep: string): string {
  return `${message}; next_step=${nextStep}`;
}
