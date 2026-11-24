import express from "express";
import cors from "cors";
import { metrics } from "@opentelemetry/api";
import { createLogger } from "@otel-tryout/shared/logger";
import { corsOptions } from "@otel-tryout/shared/http";

const log = createLogger("load-generator");
const meter = metrics.getMeter("load-generator");
const flowCounter = meter.createCounter("loadgen_flows_total", {
  description: "Synthetic flows run by the load generator",
});

const AUTH = process.env.AUTH_URL ?? "http://localhost:4001";
const BALANCE = process.env.BALANCE_URL ?? "http://localhost:4003";
const TRANSACTION = process.env.TRANSACTION_URL ?? "http://localhost:4004";
const PAYMENT = process.env.PAYMENT_URL ?? "http://localhost:4008";
const CREDENTIALS = { username: "ricardo", password: "password123" };

type FaultKey = "login" | "account" | "balance" | "transaction" | "fraud" | "notification" | "payment";

interface State {
  running: boolean;
  intervalMs: number;
  faults: Record<FaultKey, boolean>;
}

const state: State = {
  running: false,
  intervalMs: 1500,
  faults: { login: false, account: false, balance: false, transaction: false, fraud: false, notification: false, payment: false },
};

let token: string | null = null;

// Fault toggles map to the per-service x-fail-* headers the generated requests
// carry. A toggle left on means that service errors on every generated call.
function faultHeaders(): Record<string, string> {
  const f = state.faults;
  const h: Record<string, string> = {};
  if (f.account) h["x-fail-account"] = "true";
  if (f.balance) h["x-fail-balance"] = "true";
  if (f.transaction) h["x-fail-transaction"] = "true";
  if (f.fraud) h["x-fail-fraud"] = "true";
  if (f.notification) h["x-fail-notification"] = "true";
  if (f.payment) h["x-fail-payment"] = "true";
  return h;
}

async function login(): Promise<boolean> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (state.faults.login) headers["x-fail-login"] = "true";
  const res = await fetch(`${AUTH}/login`, {
    method: "POST",
    headers,
    body: JSON.stringify(CREDENTIALS),
  });
  flowCounter.add(1, { flow: "login", result: res.ok ? "ok" : "error" });
  if (!res.ok) {
    token = null;
    return false;
  }
  token = ((await res.json()) as { accessToken: string }).accessToken;
  return true;
}

async function ensureToken(): Promise<boolean> {
  if (token) return true;
  return login();
}

async function checkBalance(): Promise<void> {
  if (!(await ensureToken())) return;
  const res = await fetch(`${BALANCE}/balance`, {
    headers: { authorization: `Bearer ${token}`, ...faultHeaders() },
  });
  if (res.status === 401) token = null;
  flowCounter.add(1, { flow: "balance", result: res.ok ? "ok" : "error" });
}

async function transfer(): Promise<void> {
  if (!(await ensureToken())) return;
  const amount = Math.round((20 + Math.random() * 480) * 100) / 100;
  const res = await fetch(`${TRANSACTION}/transfer`, {
    method: "POST",
    headers: { "Content-Type": "application/json", authorization: `Bearer ${token}`, ...faultHeaders() },
    body: JSON.stringify({ amount }),
  });
  if (res.status === 401) token = null;
  flowCounter.add(1, { flow: "transfer", result: res.ok ? "ok" : "error" });
}

async function receivePayment(): Promise<void> {
  if (!(await ensureToken())) return;
  const amount = Math.round((10 + Math.random() * 490) * 100) / 100;
  const res = await fetch(`${PAYMENT}/receive`, {
    method: "POST",
    headers: { "Content-Type": "application/json", authorization: `Bearer ${token}`, ...faultHeaders() },
    body: JSON.stringify({ amount }),
  });
  if (res.status === 401) token = null;
  flowCounter.add(1, { flow: "payment", result: res.ok ? "ok" : "error" });
}

async function runRandomFlow(): Promise<void> {
  const r = Math.random();
  if (r < 0.15) await login();
  else if (r < 0.45) await checkBalance();
  else if (r < 0.75) await transfer();
  else await receivePayment();
}

async function tick(): Promise<void> {
  if (state.running) {
    try {
      await runRandomFlow();
    } catch (err) {
      log.warn({ err: String(err) }, "flow error (target service down?)");
    }
  }
  setTimeout(tick, state.running ? state.intervalMs : 500);
}
void tick();

const app = express();
app.use(cors(corsOptions));
app.use(express.json());

app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.get("/control", (_req, res) => res.json(state));

app.post("/control", (req, res) => {
  const body = req.body ?? {};
  if (typeof body.running === "boolean") state.running = body.running;
  if (typeof body.intervalMs === "number") {
    state.intervalMs = Math.max(200, Math.min(10000, body.intervalMs));
  }
  if (body.faults && typeof body.faults === "object") {
    for (const key of Object.keys(state.faults) as FaultKey[]) {
      if (typeof body.faults[key] === "boolean") state.faults[key] = body.faults[key];
    }
  }
  log.info({ running: state.running, intervalMs: state.intervalMs, faults: state.faults }, "control updated");
  res.json(state);
});

const PORT = 4007;
app.listen(PORT, () => log.info(`load-generator listening on :${PORT}`));
