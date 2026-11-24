import express from "express";
import cors from "cors";
import { metrics } from "@opentelemetry/api";
import { createLogger } from "@otel-tryout/shared/logger";
import { corsOptions, randomLatency, failRequested } from "@otel-tryout/shared/http";
import { requireAuth } from "@otel-tryout/shared/auth";

const log = createLogger("account-service");
const meter = metrics.getMeter("account-service");
const lookupCounter = meter.createCounter("account_lookups_total", {
  description: "Number of account lookups",
});

const app = express();
app.use(cors(corsOptions));
app.use(express.json());

app.get("/health", (_req, res) => res.json({ status: "ok" }));

// requireAuth verifies the JWT locally and checks revocation with auth
// (cached). The account is derived from the verified subject, so a caller can
// only ever resolve their own account.
app.get("/account", requireAuth({ scope: "account:read" }), async (req, res) => {
  await randomLatency();

  if (failRequested(req, "x-fail-account")) {
    lookupCounter.add(1, { result: "error" });
    log.error("account lookup failed (simulated)");
    return res.status(500).json({ error: "account database unavailable" });
  }

  const userId = req.auth!.userId;
  const name = userId.replace("user-", "").replace(/^\w/, (c) => c.toUpperCase());
  const account = {
    accountId: `acct-${userId.replace("user-", "")}`,
    userId,
    name,
    tier: "standard",
  };

  lookupCounter.add(1, { result: "success" });
  log.info({ account }, "account resolved");
  res.json(account);
});

const PORT = 4002;
app.listen(PORT, () => log.info(`account-service listening on :${PORT}`));
