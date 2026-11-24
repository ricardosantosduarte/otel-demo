import { startTelemetry } from "@otel-tryout/shared/telemetry";

startTelemetry("payment-service");

await import("./app.ts");
