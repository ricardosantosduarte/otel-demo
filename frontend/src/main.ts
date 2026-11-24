import "./tracing.ts";
import { trace, context, SpanStatusCode } from "@opentelemetry/api";

const AUTH = "http://localhost:4001";
const BALANCE = "http://localhost:4003";
const TRANSACTION = "http://localhost:4004";
const PAYMENT = "http://localhost:4008";
const LOADGEN = "http://localhost:4007";
const tracer = trace.getTracer("frontend");

const out = document.getElementById("output") as HTMLPreElement;
let token: string | null = null;

function render(data: unknown) {
  out.textContent = JSON.stringify(data, null, 2);
}

// ---- manual tester ----------------------------------------------------------

const FAULT_HEADER: Record<string, string> = {
  login: "x-fail-login",
  account: "x-fail-account",
  balance: "x-fail-balance",
  transaction: "x-fail-transaction",
  fraud: "x-fail-fraud",
  notification: "x-fail-notification",
  payment: "x-fail-payment",
};

// Single source of truth for outages: the generator's fault state (polled
// below). Manual requests honor the same switches as the generated traffic.
let currentFaults: Record<string, boolean> = {};

function manualFailHeaders(): Record<string, string> {
  const h: Record<string, string> = {};
  for (const [key, on] of Object.entries(currentFaults)) {
    if (on && FAULT_HEADER[key]) h[FAULT_HEADER[key]] = "true";
  }
  return h;
}

async function runFlow(name: string, fn: () => Promise<void>) {
  const span = tracer.startSpan(name);
  try {
    await context.with(trace.setSpan(context.active(), span), fn);
  } catch (err) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
    render({ error: String(err) });
  } finally {
    span.end();
  }
}

document.getElementById("loginBtn")!.addEventListener("click", () => {
  runFlow("ui.login", async () => {
    const username = (document.getElementById("username") as HTMLInputElement).value;
    const password = (document.getElementById("password") as HTMLInputElement).value;
    const res = await fetch(`${AUTH}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...manualFailHeaders() },
      body: JSON.stringify({ username, password }),
    });
    if (!res.ok) {
      token = null;
      render({ error: `login failed (${res.status})` });
      return;
    }
    const data = (await res.json()) as { accessToken: string; userId: string; scopes: string[] };
    token = data.accessToken;
    render({ loggedIn: true, userId: data.userId, scopes: data.scopes });
  });
});

document.getElementById("balanceBtn")!.addEventListener("click", () => {
  runFlow("ui.check-balance", async () => {
    if (!token) return render({ error: "log in first" });
    const res = await fetch(`${BALANCE}/balance`, {
      headers: { authorization: `Bearer ${token}`, ...manualFailHeaders() },
    });
    render(await res.json());
  });
});

document.getElementById("transferBtn")!.addEventListener("click", () => {
  runFlow("ui.transfer", async () => {
    if (!token) return render({ error: "log in first" });
    const res = await fetch(`${TRANSACTION}/transfer`, {
      method: "POST",
      headers: { "Content-Type": "application/json", authorization: `Bearer ${token}`, ...manualFailHeaders() },
      body: JSON.stringify({ amount: 250 }),
    });
    render(await res.json());
  });
});

document.getElementById("receiveBtn")!.addEventListener("click", () => {
  runFlow("ui.receive-payment", async () => {
    if (!token) return render({ error: "log in first" });
    const res = await fetch(`${PAYMENT}/receive`, {
      method: "POST",
      headers: { "Content-Type": "application/json", authorization: `Bearer ${token}`, ...manualFailHeaders() },
      body: JSON.stringify({}),
    });
    render(await res.json());
  });
});

// ---- load generator control -------------------------------------------------

interface GenState {
  running: boolean;
  intervalMs: number;
  faults: Record<string, boolean>;
}

const genStatus = document.getElementById("genStatus") as HTMLSpanElement;
const genToggle = document.getElementById("genToggle") as HTMLButtonElement;
const genRate = document.getElementById("genRate") as HTMLSelectElement;

function applyGenState(s: GenState) {
  genStatus.className = `pill ${s.running ? "running" : "stopped"}`;
  genStatus.innerHTML = `<span class="dot"></span>${s.running ? "running" : "stopped"}`;
  genToggle.textContent = s.running ? "Stop" : "Start";
  genRate.value = String(s.intervalMs);
  currentFaults = s.faults;
  document.querySelectorAll<HTMLInputElement>("#outageFaults input[data-fault]").forEach((el) => {
    el.checked = !!s.faults[el.dataset.fault!];
  });
}

async function postGen(patch: Partial<GenState>) {
  try {
    const res = await fetch(`${LOADGEN}/control`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    applyGenState((await res.json()) as GenState);
  } catch {
    genStatus.className = "pill stopped";
    genStatus.innerHTML = `<span class="dot"></span>generator offline`;
  }
}

genToggle.addEventListener("click", () => {
  postGen({ running: genToggle.textContent === "Start" });
});
genRate.addEventListener("change", () => postGen({ intervalMs: Number(genRate.value) }));
document.querySelectorAll<HTMLInputElement>("#outageFaults input[data-fault]").forEach((el) => {
  el.addEventListener("change", () => postGen({ faults: { [el.dataset.fault!]: el.checked } }));
});

async function pollGen() {
  try {
    const res = await fetch(`${LOADGEN}/control`);
    applyGenState((await res.json()) as GenState);
  } catch {
    genStatus.className = "pill stopped";
    genStatus.innerHTML = `<span class="dot"></span>generator offline`;
  }
}
pollGen();
setInterval(pollGen, 3000);
