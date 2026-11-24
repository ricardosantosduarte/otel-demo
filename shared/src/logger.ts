import pino from "pino";

export function createLogger(serviceName: string) {
  return pino({
    name: serviceName,
    level: process.env.LOG_LEVEL ?? "info",
    // Pretty output on the console; the OTel pino instrumentation separately
    // ships structured records (with trace_id/span_id) to the collector.
    transport: {
      target: "pino-pretty",
      options: { colorize: true, translateTime: "HH:MM:ss" },
    },
  });
}
