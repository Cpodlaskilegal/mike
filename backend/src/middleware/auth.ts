import { Request, Response, NextFunction } from "express";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { ensureAppUser } from "../lib/supabase";

const tenantId = process.env.AZURE_TENANT_ID ?? "";
const audience = process.env.AZURE_API_CLIENT_ID ?? "";
const requiredDelegatedScope =
  process.env.AZURE_API_SCOPE_NAME?.trim() || "access_as_user";
const issuer = tenantId
  ? `https://login.microsoftonline.com/${tenantId}/v2.0`
  : "";
const jwks = tenantId
  ? createRemoteJWKSet(
      new URL(`https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`),
    )
  : null;

type EntraClaims = {
  oid?: string;
  sub?: string;
  preferred_username?: string;
  email?: string;
  upn?: string;
  scp?: string;
};

export function hasDelegatedScope(
  claim: unknown,
  requiredScope = requiredDelegatedScope,
): boolean {
  return (
    typeof claim === "string" &&
    claim.split(/\s+/).some((scope) => scope === requiredScope)
  );
}

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
    if (!hasDelegatedScope(claims.scp)) {
      res.status(403).json({
        code: "insufficient_scope",
        detail: "The access token is missing Docket's delegated user scope.",
      });
      return;
    }

    const normalizedEmail = userEmail.toLowerCase();
    const appUser = await ensureAppUser({ id: userId, email: normalizedEmail });
    if (appUser.docketDataStatus === "deleted") {
      res.status(403).json({
        code: "docket_data_deleted",
        detail:
          "Docket data for this Microsoft Entra identity has been deleted. This does not delete the Entra account.",
      });
      return;
    }
    res.locals.userId = userId;
    res.locals.userEmail = normalizedEmail;
    // Keep the already-validated, request-scoped user assertion in memory for
    // downstream delegated APIs. It is never persisted or returned to chat.
    res.locals.token = token;
    next();
  } catch (error) {
    console.warn("[auth] token validation failed", {
      reason: error instanceof Error ? error.message : "unknown",
    });
    res.status(401).json({ detail: "Invalid or expired token" });
  }
}
