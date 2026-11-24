import express from "express";
import cors from "cors";
import { metrics } from "@opentelemetry/api";
import { createLogger } from "@otel-tryout/shared/logger";
import { corsOptions, randomLatency, failRequested } from "@otel-tryout/shared/http";
import { requireAuth } from "@otel-tryout/shared/auth";

const log = createLogger("payment-service");
const meter = metrics.getMeter("payment-service");
const paymentCounter = meter.createCounter("payments_received_total", {
  description: "Number of incoming payments",
});
const paymentHistogram = meter.createHistogram("payment_amount", {
  description: "Incoming payment amounts",
});

const BALANCE_URL = process.env.BALANCE_URL ?? "http://localhost:4003";

const app = express();
app.use(cors(corsOptions));
app.use(express.json());

function forwardFailFlags(req: express.Request, names: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const n of names) {
    const v = req.header(n);
    if (v) out[n] = v;
  }
  return out;
}

app.get("/health", (_req, res) => res.json({ status: "ok" }));

// An incoming payment credits the account. Amount is randomized when not given.
app.post("/receive", requireAuth({ introspect: "always" }), async (req, res) => {
  await randomLatency();

  if (failRequested(req, "x-fail-payment")) {
    paymentCounter.add(1, { result: "error" });
    log.error("payment failed (simulated)");
    return res.status(500).json({ error: "payment processor unavailable" });
  }

  const amount = Number(req.body?.amount) || Math.round((10 + Math.random() * 490) * 100) / 100;

  // payment -> balance -> account -> auth
  const creditRes = await fetch(`${BALANCE_URL}/credit`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      authorization: req.header("authorization") ?? "",
      ...forwardFailFlags(req, ["x-fail-balance", "x-fail-account"]),
    },
    body: JSON.stringify({ amount }),
  });
  if (!creditRes.ok) {
    paymentCounter.add(1, { result: "error" });
    log.error("payment failed: balance credit error");
    return res.status(502).json({ error: "balance service unavailable" });
  }

  const { balance } = (await creditRes.json()) as { balance: number };
  paymentCounter.add(1, { result: "received" });
  paymentHistogram.record(amount);
  log.info({ amount, balance }, "payment received");
  res.json({ status: "received", amount, balance });
});

const PORT = 4008;
app.listen(PORT, () => log.info(`payment-service listening on :${PORT}`));
