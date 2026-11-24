import express from "express";
import cors from "cors";
import { metrics } from "@opentelemetry/api";
import { createLogger } from "@otel-tryout/shared/logger";
import { corsOptions, randomLatency, failRequested } from "@otel-tryout/shared/http";
import { requireAuth } from "@otel-tryout/shared/auth";

const log = createLogger("balance-service");
const meter = metrics.getMeter("balance-service");
const balanceHistogram = meter.createHistogram("balance_amount", {
  description: "Reported balance amounts",
});

const ACCOUNT_URL = process.env.ACCOUNT_URL ?? "http://localhost:4002";

// In-memory balances. Every account starts at the same amount and is debited
// on transfer. Lives only in this process variable — not persisted anywhere.
const STARTING_BALANCE = 5000;
const balances = new Map<string, number>();

function getBalance(accountId: string): number {
  if (!balances.has(accountId)) balances.set(accountId, STARTING_BALANCE);
  return balances.get(accountId)!;
}

type Account = { accountId: string; userId: string };

// Resolve the caller's account via account-service (account -> auth). Returns
// the account on success, or the upstream status to propagate on failure.
async function resolveAccount(
  req: express.Request,
): Promise<{ ok: true; account: Account } | { ok: false; status: number }> {
  const ar = await fetch(`${ACCOUNT_URL}/account`, {
    headers: {
      authorization: req.header("authorization") ?? "",
      ...(req.header("x-fail-account") ? { "x-fail-account": req.header("x-fail-account")! } : {}),
    },
  });
  if (!ar.ok) return { ok: false, status: ar.status };
  return { ok: true, account: (await ar.json()) as Account };
}

const app = express();
app.use(cors(corsOptions));
app.use(express.json());

app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.get("/balance", requireAuth({ scope: "balance:read" }), async (req, res) => {
  await randomLatency();

  if (failRequested(req, "x-fail-balance")) {
    log.error("balance lookup failed (simulated)");
    return res.status(500).json({ error: "balance ledger unavailable" });
  }

  const resolved = await resolveAccount(req);
  if (!resolved.ok) {
    log.warn("balance lookup failed: account resolution error");
    return res.status(resolved.status).json({ error: "could not resolve account" });
  }

  const balance = getBalance(resolved.account.accountId);
  balanceHistogram.record(balance);

  log.info({ accountId: resolved.account.accountId, balance }, "balance retrieved");
  res.json({ accountId: resolved.account.accountId, balance, currency: "USD" });
});

app.post("/debit", requireAuth({ scope: "balance:write" }), async (req, res) => {
  await randomLatency();

  if (failRequested(req, "x-fail-balance")) {
    log.error("debit failed (simulated)");
    return res.status(500).json({ error: "balance ledger unavailable" });
  }

  const resolved = await resolveAccount(req);
  if (!resolved.ok) {
    log.warn("debit failed: account resolution error");
    return res.status(resolved.status).json({ error: "could not resolve account" });
  }

  const { accountId } = resolved.account;
  const amount = Number(req.body?.amount ?? 0);
  const current = getBalance(accountId);

  if (amount > current) {
    log.warn({ accountId, amount, balance: current }, "debit declined: insufficient funds");
    return res.status(402).json({ error: "insufficient funds", balance: current });
  }

  const balance = Math.round((current - amount) * 100) / 100;
  balances.set(accountId, balance);
  balanceHistogram.record(balance);

  log.info({ accountId, amount, balance }, "account debited");
  res.json({ accountId, balance, currency: "USD" });
});

app.post("/credit", requireAuth({ scope: "balance:write" }), async (req, res) => {
  await randomLatency();

  if (failRequested(req, "x-fail-balance")) {
    log.error("credit failed (simulated)");
    return res.status(500).json({ error: "balance ledger unavailable" });
  }

  const resolved = await resolveAccount(req);
  if (!resolved.ok) {
    log.warn("credit failed: account resolution error");
    return res.status(resolved.status).json({ error: "could not resolve account" });
  }

  const { accountId } = resolved.account;
  const amount = Number(req.body?.amount ?? 0);
  const balance = Math.round((getBalance(accountId) + amount) * 100) / 100;
  balances.set(accountId, balance);
  balanceHistogram.record(balance);

  log.info({ accountId, amount, balance }, "account credited");
  res.json({ accountId, balance, currency: "USD" });
});

const PORT = 4003;
app.listen(PORT, () => log.info(`balance-service listening on :${PORT}`));
