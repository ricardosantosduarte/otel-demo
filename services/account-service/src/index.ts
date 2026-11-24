import { startTelemetry } from "@otel-tryout/shared/telemetry";

startTelemetry("account-service");

await import("./app.ts");
