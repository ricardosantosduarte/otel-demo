import { startTelemetry } from "@otel-tryout/shared/telemetry";

startTelemetry("fraud-service");

await import("./app.ts");
