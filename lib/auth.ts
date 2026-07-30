// Entra ID (Azure AD) bearer-token validation — ported from morning_brief/auth.py.
// Web clients send the MSAL access/ID token; we verify signature + audience and
// extract the user's UPN. No dev fallback online.
import { createRemoteJWKSet, jwtVerify } from "jose";

const TENANT = process.env.TENANT_ID || process.env.NEXT_PUBLIC_AZURE_TENANT_ID || "";
const CLIENT_ID = process.env.GRAPH_CLIENT_ID || process.env.NEXT_PUBLIC_AZURE_CLIENT_ID || "";

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

function getJwks() {
  if (!jwks) {
    jwks = createRemoteJWKSet(
      new URL(`https://login.microsoftonline.com/${TENANT || "common"}/discovery/v2.0/keys`)
    );
  }
  return jwks;
}

export class AuthError extends Error {}

/** Verify the Authorization: Bearer token and return the caller's UPN (lowercased). */
export async function requireUser(req: Request): Promise<string> {
  const header = req.headers.get("authorization") || "";
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (!m) throw new AuthError("Missing Bearer token");
  const token = m[1];

  const audiences = [CLIENT_ID, `api://${CLIENT_ID}`].filter(Boolean);
  try {
    const { payload } = await jwtVerify(token, getJwks(), { audience: audiences });
    const upn =
      (payload.preferred_username as string) ||
      (payload.upn as string) ||
      (payload.email as string) ||
      (payload.sub as string) ||
      "";
    if (!upn) throw new AuthError("Token missing user identifier");
    return upn.toLowerCase();
  } catch (e) {
    if (e instanceof AuthError) throw e;
    throw new AuthError(`Token validation failed: ${String(e).slice(0, 150)}`);
  }
}

/** Check the cron secret for scheduled endpoints.
 * Accepts ?key=, x-cron-secret header, or Authorization: Bearer <CRON_SECRET>
 * (the form Vercel Cron sends automatically when the CRON_SECRET env is set). */
export function checkCronSecret(req: Request): boolean {
  const secret = process.env.CRON_SECRET || "";
  if (!secret) return false;
  const url = new URL(req.url);
  const bearer = (req.headers.get("authorization") || "").match(/^Bearer\s+(.+)$/i)?.[1] || "";
  const provided = req.headers.get("x-cron-secret") || url.searchParams.get("key") || bearer;
  return provided === secret;
}
