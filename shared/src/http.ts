import type { CorsOptions } from "cors";
import type { Request } from "express";

// Allow the browser frontend to call the services and to read/send the W3C
// trace-context headers so the trace stitches together across the chain.
export const corsOptions: CorsOptions = {
  origin: true,
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "traceparent",
    "tracestate",
    "x-fail-login",
    "x-fail-account",
    "x-fail-balance",
    "x-fail-transaction",
    "x-fail-fraud",
    "x-fail-notification",
    "x-fail-payment",
  ],
  exposedHeaders: ["traceparent", "tracestate"],
};

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A little random latency makes the spans visibly different in Tempo.
export function randomLatency(min = 20, max = 120): Promise<void> {
  return sleep(min + Math.floor(Math.random() * (max - min)));
}

// The frontend can send a per-service header (e.g. `x-fail-account: true`) to
// force that service to error, so you can see red traces and error-rate
// metrics on demand.
export function failRequested(req: Request, header: string): boolean {
  return req.header(header) === "true";
}
