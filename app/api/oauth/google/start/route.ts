import { NextResponse } from "next/server";
import { AuthError, verifyToken } from "@/lib/auth";
import { buildAuthUrl, isConfigured } from "@/lib/youtube";

// GET /api/oauth/google/start?token=<idToken>&back=/consents
// Redirect browsers can't send Authorization headers, so the ID token is
// passed as ?token= (verified server-side) instead of trusting ?upn=.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const token = url.searchParams.get("token") || "";
  const back = url.searchParams.get("back") || "/account";
  const destBase = `${url.origin}${back.startsWith("/") ? back : "/account"}`;

  if (!isConfigured()) {
    return NextResponse.redirect(`${destBase}?yt=need_google_oauth`);
  }

  let upn = "";
  try {
    if (!token) throw new AuthError("Missing token");
    upn = await verifyToken(token);
  } catch {
    return NextResponse.redirect(`${destBase}?yt=need_login`);
  }

  const state = Buffer.from(JSON.stringify({ upn, back }), "utf-8").toString("base64url");
  return NextResponse.redirect(buildAuthUrl(state));
}
