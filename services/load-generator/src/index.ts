import { startTelemetry } from "@otel-tryout/shared/telemetry";

startTelemetry("load-generator");

await import("./app.ts");
