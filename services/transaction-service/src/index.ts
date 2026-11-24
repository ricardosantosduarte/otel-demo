import { startTelemetry } from "@otel-tryout/shared/telemetry";

startTelemetry("transaction-service");

await import("./app.ts");
