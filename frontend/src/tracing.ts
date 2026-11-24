import { WebTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-web";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { ZoneContextManager } from "@opentelemetry/context-zone";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { FetchInstrumentation } from "@opentelemetry/instrumentation-fetch";
import { Resource } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

const COLLECTOR_URL = "http://localhost:4318/v1/traces";

// The backend services the browser calls. The fetch instrumentation only adds
// the W3C `traceparent` header to cross-origin requests on this allow-list, so
// the browser span and the server spans join into one trace.
const BACKENDS = [/http:\/\/localhost:400[1-6]/];

const provider = new WebTracerProvider({
  resource: new Resource({ [ATTR_SERVICE_NAME]: "frontend" }),
  spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter({ url: COLLECTOR_URL }))],
});

provider.register({ contextManager: new ZoneContextManager() });

registerInstrumentations({
  instrumentations: [
    new FetchInstrumentation({
      propagateTraceHeaderCorsUrls: BACKENDS,
      clearTimingResources: true,
    }),
  ],
});
