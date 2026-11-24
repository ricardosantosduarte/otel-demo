import { startTelemetry } from "@otel-tryout/shared/telemetry";

startTelemetry("notification-service");

await import("./app.ts");
