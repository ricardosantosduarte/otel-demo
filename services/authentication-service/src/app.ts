import express from "express";
import cors from "cors";
import { scryptSync, randomBytes, timingSafeEqual } from "node:crypto";
import { metrics } from "@opentelemetry/api";
import { createLogger } from "@otel-tryout/shared/logger";
import { corsOptions, randomLatency, failRequested } from "@otel-tryout/shared/http";
import { signAccessToken, verifyAccessToken } from "@otel-tryout/shared/auth";

const log = createLogger("authentication-service");
const meter = metrics.getMeter("authentication-service");
const loginCounter = meter.createCounter("auth_logins_total", {
  description: "Number of login attempts",
});

interface User {
  userId: string;
  salt: string;
  hash: string;
  scopes: string[];
}

function makeUser(username: string, password: string, scopes: string[]): [string, User] {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return [username, { userId: `user-${username}`, salt, hash, scopes }];
}

// In-memory user table (passwords hashed with scrypt). Demo credentials:
//   ricardo / password123  — full access
//   viewer  / viewer123    — read-only (no transfer scope)
const users = new Map<string, User>([
  makeUser("ricardo", "password123", ["account:read", "balance:read", "balance:write", "transfer"]),
  makeUser("viewer", "viewer123", ["account:read", "balance:read"]),
]);

function verifyPassword(user: User, password: string): boolean {
  const candidate = scryptSync(password, user.salt, 64);
  const stored = Buffer.from(user.hash, "hex");
  return candidate.length === stored.length && timingSafeEqual(candidate, stored);
}

const REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000;
interface RefreshRecord {
  userId: string;
  scopes: string[];
  expiresAt: number;
}
const refreshTokens = new Map<string, RefreshRecord>();
const revokedJti = new Set<string>();

function issueRefreshToken(userId: string, scopes: string[]): string {
  const refreshToken = randomBytes(32).toString("hex");
  refreshTokens.set(refreshToken, { userId, scopes, expiresAt: Date.now() + REFRESH_TTL_MS });
  return refreshToken;
}

const app = express();
app.use(cors(corsOptions));
app.use(express.json());

app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.post("/login", async (req, res) => {
  await randomLatency();
  if (failRequested(req, "x-fail-login")) {
    loginCounter.add(1, { result: "error" });
    log.error("login failed (simulated)");
    return res.status(500).json({ error: "authentication backend unavailable" });
  }

  const username = (req.body?.username as string) ?? "";
  const password = (req.body?.password as string) ?? "";
  const user = users.get(username);

  if (!user || !verifyPassword(user, password)) {
    loginCounter.add(1, { result: "invalid_credentials" });
    log.warn({ username }, "login failed: invalid credentials");
    return res.status(401).json({ error: "invalid credentials" });
  }

  const access = signAccessToken(user.userId, user.scopes);
  const refreshToken = issueRefreshToken(user.userId, user.scopes);

  loginCounter.add(1, { result: "success" });
  log.info({ userId: user.userId, jti: access.jti }, "login succeeded");
  res.json({
    accessToken: access.token,
    refreshToken,
    expiresIn: access.expiresIn,
    userId: user.userId,
    scopes: user.scopes,
  });
});

app.post("/refresh", async (req, res) => {
  await randomLatency(5, 40);
  const refreshToken = (req.body?.refreshToken as string) ?? "";
  const record = refreshTokens.get(refreshToken);

  if (!record || record.expiresAt < Date.now()) {
    refreshTokens.delete(refreshToken);
    log.warn("refresh failed: unknown or expired refresh token");
    return res.status(401).json({ error: "invalid refresh token" });
  }

  // Rotate: the old refresh token is spent, a new one is issued.
  refreshTokens.delete(refreshToken);
  const access = signAccessToken(record.userId, record.scopes);
  const newRefresh = issueRefreshToken(record.userId, record.scopes);

  log.info({ userId: record.userId, jti: access.jti }, "token refreshed");
  res.json({ accessToken: access.token, refreshToken: newRefresh, expiresIn: access.expiresIn });
});

// RFC 7662-style introspection: other services call this to check revocation.
app.post("/introspect", async (req, res) => {
  await randomLatency(2, 20);
  const token = (req.body?.token as string) ?? "";
  try {
    const claims = verifyAccessToken(token);
    if (revokedJti.has(claims.jti)) return res.json({ active: false });
    res.json({ active: true, sub: claims.sub, scope: claims.scope, exp: claims.exp });
  } catch {
    res.json({ active: false });
  }
});

// Revoke the presented access token (by jti) and its refresh token.
app.post("/logout", async (req, res) => {
  await randomLatency(5, 30);
  const token = (req.header("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const refreshToken = (req.body?.refreshToken as string) ?? "";

  try {
    const claims = verifyAccessToken(token);
    revokedJti.add(claims.jti);
    log.info({ userId: claims.sub, jti: claims.jti }, "access token revoked");
  } catch {
    // Nothing to revoke if the token is already invalid.
  }
  if (refreshToken) refreshTokens.delete(refreshToken);

  res.json({ loggedOut: true });
});

const PORT = 4001;
app.listen(PORT, () => log.info(`authentication-service listening on :${PORT}`));
