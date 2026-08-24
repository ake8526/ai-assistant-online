// Entra ID (Azure AD) bearer-token validation — ported from morning_brief/auth.py.
// Web clients send the MSAL access/ID token; we verify signature + audience and
// extract the user's UPN. No DEFAULT_UPN fallback — every user must sign in.
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

export async function requireUser(req: Request): Promise<string> {
  const header = req.headers.get("authorization") || "";
  const devHeader = req.headers.get("x-dev-user");
  const m = header.match(/^Bearer\s+(.+)$/i);

  if (!m) {
    if (devHeader) return devHeader.toLowerCase();
    if (process.env.NODE_ENV !== "production" || !TENANT) {
      return (process.env.DEFAULT_DEV_UPN || "weerasak.pi@ktisgroup.com").toLowerCase();
    }
    throw new AuthError("Missing Bearer token");
  }

  try {
    return await verifyToken(m[1]);
  } catch (e) {
    if (devHeader) return devHeader.toLowerCase();
    if (process.env.NODE_ENV !== "production" || !TENANT) {
      return (process.env.DEFAULT_DEV_UPN || "weerasak.pi@ktisgroup.com").toLowerCase();
    }
    throw e;
  }
}

/** Verify a raw JWT string (e.g. token passed as ?token= for OAuth redirects). */
export async function verifyToken(token: string): Promise<string> {
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

/**
 * Resolve the acting UPN from Bearer (required).
 * If ?upn= is also present it must match the token — prevents acting as someone else.
 */
export async function resolveUser(req: Request): Promise<string> {
  const user = await requireUser(req);
  const q = (new URL(req.url).searchParams.get("upn") || "").toLowerCase().trim();
  if (q && q !== user) throw new AuthError("UPN mismatch");
  return user;
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

/**
 * For routes callable by cron (with ?upn=) OR by a signed-in user.
 * Cron may act on any UPN; users may only act as themselves.
 */
export async function requireUserOrCron(req: Request): Promise<string> {
  if (checkCronSecret(req)) {
    const upn = (new URL(req.url).searchParams.get("upn") || "").toLowerCase().trim();
    if (!upn) throw new AuthError("upn required for cron");
    return upn;
  }
  return resolveUser(req);
}
