import { startTelemetry } from "@otel-tryout/shared/telemetry";

startTelemetry("authentication-service");

// Import the app only after the SDK is running, so auto-instrumentation
// can patch express/http as they load.
await import("./app.ts");
