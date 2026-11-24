import express from "express";
import cors from "cors";
import { metrics } from "@opentelemetry/api";
import { createLogger } from "@otel-tryout/shared/logger";
import { corsOptions, randomLatency, failRequested } from "@otel-tryout/shared/http";
import { requireAuth } from "@otel-tryout/shared/auth";

const log = createLogger("transaction-service");
const meter = metrics.getMeter("transaction-service");
const transferCounter = meter.createCounter("transfers_total", {
  description: "Number of transfer attempts",
});

const FRAUD_URL = process.env.FRAUD_URL ?? "http://localhost:4005";
const BALANCE_URL = process.env.BALANCE_URL ?? "http://localhost:4003";
const NOTIFY_URL = process.env.NOTIFY_URL ?? "http://localhost:4006";

const app = express();
app.use(cors(corsOptions));
app.use(express.json());

// Pass through only the downstream fail flags present on the request.
function forwardFailFlags(req: express.Request, names: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const n of names) {
    const v = req.header(n);
    if (v) out[n] = v;
  }
  return out;
}

app.get("/health", (_req, res) => res.json({ status: "ok" }));

// Money moves force a live revocation check (introspect: "always") and require
// the "transfer" scope.
app.post("/transfer", requireAuth({ scope: "transfer", introspect: "always" }), async (req, res) => {
  await randomLatency();
  const authHeader = req.header("authorization") ?? "";
  const amount = Number(req.body?.amount ?? 100);

  if (failRequested(req, "x-fail-transaction")) {
    transferCounter.add(1, { result: "error" });
    log.error("transfer failed (simulated)");
    return res.status(500).json({ error: "transaction ledger unavailable" });
  }

  // 1) Fraud check.
  const fraudRes = await fetch(`${FRAUD_URL}/check`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      authorization: authHeader,
      ...forwardFailFlags(req, ["x-fail-fraud"]),
    },
    body: JSON.stringify({ amount }),
  });
  if (fraudRes.status >= 500) {
    transferCounter.add(1, { result: "error" });
    log.error("transfer failed: fraud service error");
    return res.status(502).json({ error: "fraud service unavailable" });
  }
  const fraud = (await fraudRes.json()) as { approved: boolean; score: number };
  if (!fraud.approved) {
    transferCounter.add(1, { result: "denied" });
    log.warn({ amount, score: fraud.score }, "transfer denied by fraud check");
    return res.status(403).json({ error: "transfer denied", score: fraud.score });
  }

  // 2) Debit the account balance (balance -> account -> auth). The balance
  // service holds the money and deducts it, returning the new balance.
  const debitRes = await fetch(`${BALANCE_URL}/debit`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      authorization: authHeader,
      ...forwardFailFlags(req, ["x-fail-balance", "x-fail-account"]),
    },
    body: JSON.stringify({ amount }),
  });
  if (debitRes.status === 402) {
    const { balance } = (await debitRes.json()) as { balance: number };
    transferCounter.add(1, { result: "insufficient_funds" });
    log.warn({ amount, balance }, "transfer declined: insufficient funds");
    return res.status(402).json({ error: "insufficient funds", balance });
  }
  if (!debitRes.ok) {
    transferCounter.add(1, { result: "error" });
    log.error("transfer failed: balance debit error");
    return res.status(502).json({ error: "balance service unavailable" });
  }
  const { balance } = (await debitRes.json()) as { balance: number };

  // 3) Send a receipt notification.
  await fetch(`${NOTIFY_URL}/notify`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      authorization: authHeader,
      ...forwardFailFlags(req, ["x-fail-notification"]),
    },
    body: JSON.stringify({ message: `Transfer of $${amount} completed` }),
  });

  const transactionId = `txn-${Math.random().toString(36).slice(2, 10)}`;
  transferCounter.add(1, { result: "completed" });
  log.info({ transactionId, amount, balanceAfter: balance }, "transfer completed");
  res.json({ status: "completed", transactionId, amount, balanceAfter: balance });
});

const PORT = 4004;
app.listen(PORT, () => log.info(`transaction-service listening on :${PORT}`));
