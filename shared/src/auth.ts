import jwt from "jsonwebtoken";
import { randomUUID } from "node:crypto";
import type { Request, Response, NextFunction } from "express";

const SECRET = process.env.JWT_SECRET ?? "dev-secret-change-me";
const ISSUER = process.env.JWT_ISSUER ?? "authentication-service";
const AUDIENCE = process.env.JWT_AUDIENCE ?? "otel-tryout";
const AUTH_URL = process.env.AUTH_URL ?? "http://localhost:4001";
const ACCESS_TTL_SECONDS = 15 * 60;
const INTROSPECT_CACHE_TTL_MS = 15_000;

export interface AccessClaims {
  sub: string;
  scope: string;
  jti: string;
  iss: string;
  aud: string;
  iat: number;
  exp: number;
}

export interface AuthContext {
  userId: string;
  scopes: string[];
  jti: string;
  token: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

export function signAccessToken(userId: string, scopes: string[]) {
  const jti = randomUUID();
  const token = jwt.sign({ scope: scopes.join(" ") }, SECRET, {
    algorithm: "HS256",
    subject: userId,
    issuer: ISSUER,
    audience: AUDIENCE,
    expiresIn: ACCESS_TTL_SECONDS,
    jwtid: jti,
  });
  return { token, jti, expiresIn: ACCESS_TTL_SECONDS };
}

export function verifyAccessToken(token: string): AccessClaims {
  return jwt.verify(token, SECRET, {
    algorithms: ["HS256"],
    issuer: ISSUER,
    audience: AUDIENCE,
  }) as AccessClaims;
}

export interface Introspection {
  active: boolean;
  sub?: string;
  scope?: string;
  exp?: number;
}

// Per-process cache of introspection results, keyed by token id. Keeps the
// hybrid fast: a service only re-checks revocation with auth once per TTL,
// unless the caller forces a live check (sensitive operations).
const introspectCache = new Map<string, { result: Introspection; cachedAt: number }>();

async function introspect(token: string, jti: string, force: boolean): Promise<Introspection> {
  const now = Date.now();
  if (!force) {
    const cached = introspectCache.get(jti);
    if (cached && now - cached.cachedAt < INTROSPECT_CACHE_TTL_MS) return cached.result;
  }
  const res = await fetch(`${AUTH_URL}/introspect`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  const result = (await res.json()) as Introspection;
  introspectCache.set(jti, { result, cachedAt: now });
  return result;
}

export interface RequireAuthOptions {
  // Scope the caller must hold, e.g. "transfer".
  scope?: string;
  // "always" forces a live revocation check with auth (use for money moves);
  // "cached" (default) accepts a recent cached result.
  introspect?: "always" | "cached";
}

export function requireAuth(opts: RequireAuthOptions = {}) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const token = (req.header("authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!token) return res.status(401).json({ error: "missing bearer token" });

    let claims: AccessClaims;
    try {
      claims = verifyAccessToken(token);
    } catch {
      return res.status(401).json({ error: "invalid or expired token" });
    }

    const intro = await introspect(token, claims.jti, opts.introspect === "always");
    if (!intro.active) return res.status(401).json({ error: "token revoked" });

    const scopes = claims.scope ? claims.scope.split(" ") : [];
    if (opts.scope && !scopes.includes(opts.scope)) {
      return res.status(403).json({ error: `missing required scope: ${opts.scope}` });
    }

    req.auth = { userId: claims.sub, scopes, jti: claims.jti, token };
    next();
  };
}
