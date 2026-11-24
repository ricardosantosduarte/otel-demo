import express from "express";
import cors from "cors";
import { metrics } from "@opentelemetry/api";
import { createLogger } from "@otel-tryout/shared/logger";
import { corsOptions, randomLatency, failRequested } from "@otel-tryout/shared/http";
import { requireAuth } from "@otel-tryout/shared/auth";

const log = createLogger("notification-service");
const meter = metrics.getMeter("notification-service");
const sentCounter = meter.createCounter("notifications_sent_total", {
  description: "Number of notifications sent",
});

const app = express();
app.use(cors(corsOptions));
app.use(express.json());

app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.post("/notify", requireAuth(), async (req, res) => {
  await randomLatency(5, 50);

  if (failRequested(req, "x-fail-notification")) {
    sentCounter.add(1, { result: "error" });
    log.error("notification send failed (simulated)");
    return res.status(500).json({ error: "notification provider unavailable" });
  }

  const message = (req.body?.message as string) ?? "";
  sentCounter.add(1, { result: "success" });
  log.info({ message }, "notification sent");
  res.json({ sent: true });
});

const PORT = 4006;
app.listen(PORT, () => log.info(`notification-service listening on :${PORT}`));
