import express from "express";
import cors from "cors";
import { metrics } from "@opentelemetry/api";
import { createLogger } from "@otel-tryout/shared/logger";
import { corsOptions, randomLatency, failRequested } from "@otel-tryout/shared/http";
import { requireAuth } from "@otel-tryout/shared/auth";

const log = createLogger("fraud-service");
const meter = metrics.getMeter("fraud-service");
const checkCounter = meter.createCounter("fraud_checks_total", {
  description: "Number of fraud checks",
});

const app = express();
app.use(cors(corsOptions));
app.use(express.json());

app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.post("/check", requireAuth(), async (req, res) => {
  await randomLatency(10, 90);

  if (failRequested(req, "x-fail-fraud")) {
    checkCounter.add(1, { result: "error" });
    log.error("fraud check failed (simulated)");
    return res.status(500).json({ error: "fraud engine unavailable" });
  }

  const amount = Number(req.body?.amount ?? 0);
  // Large transfers and a small random slice get flagged.
  const score = Math.min(1, amount / 10000 + Math.random() * 0.2);
  const approved = score < 0.8;

  checkCounter.add(1, { result: approved ? "approved" : "denied" });
  log.info({ amount, score: score.toFixed(2), approved }, "fraud check complete");
  res.json({ approved, score });
});

const PORT = 4005;
app.listen(PORT, () => log.info(`fraud-service listening on :${PORT}`));
