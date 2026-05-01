import { Request, Response, NextFunction } from "express";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { ensureAppUser } from "../lib/supabase";

const tenantId = process.env.AZURE_TENANT_ID ?? "";
const audience = process.env.AZURE_API_CLIENT_ID ?? "";
const issuer = tenantId
  ? `https://login.microsoftonline.com/${tenantId}/v2.0`
  : "";
const jwks = tenantId
  ? createRemoteJWKSet(new URL(`${issuer}/discovery/v2.0/keys`))
  : null;

type EntraClaims = {
  oid?: string;
  sub?: string;
  preferred_username?: string;
  email?: string;
  upn?: string;
};

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const auth = req.headers.authorization ?? "";
  if (!auth.startsWith("Bearer ")) {
    res.status(401).json({ detail: "Missing or invalid Authorization header" });
    return;
  }
  if (!jwks || !tenantId || !audience) {
    res.status(500).json({ detail: "Server auth is not configured" });
    return;
  }

  try {
    const token = auth.slice(7).trim();
    const { payload } = await jwtVerify(token, jwks, {
      issuer,
      audience: [audience, `api://${audience}`],
    });
    const claims = payload as EntraClaims;
    const userId = claims.oid ?? claims.sub;
    const userEmail =
      claims.preferred_username ?? claims.email ?? claims.upn ?? "";

    if (!userId) {
      res.status(401).json({ detail: "Token is missing a user id" });
      return;
    }

    const normalizedEmail = userEmail.toLowerCase();
    await ensureAppUser({ id: userId, email: normalizedEmail });
    res.locals.userId = userId;
    res.locals.userEmail = normalizedEmail;
    res.locals.token = token;
    next();
  } catch {
    res.status(401).json({ detail: "Invalid or expired token" });
  }
}
