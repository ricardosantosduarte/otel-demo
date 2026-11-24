import { startTelemetry } from "@otel-tryout/shared/telemetry";

startTelemetry("balance-service");

await import("./app.ts");
