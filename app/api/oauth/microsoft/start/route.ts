import { NextResponse } from "next/server";
import { AuthError, verifyToken } from "@/lib/auth";
import {
  buildMicrosoftAuthUrl,
  isMicrosoftOAuthConfigured,
} from "@/lib/msGraphOAuth";

// GET /api/oauth/microsoft/start?token=<idToken>&back=/account
export async function GET(req: Request) {
  const url = new URL(req.url);
  const token = url.searchParams.get("token") || "";
  const back = url.searchParams.get("back") || "/account";
  const destBase = `${url.origin}${back.startsWith("/") ? back : "/account"}`;

  if (!isMicrosoftOAuthConfigured()) {
    return NextResponse.redirect(`${destBase}?ms=need_oauth`);
  }

  let upn = "";
  try {
    if (!token) throw new AuthError("Missing token");
    upn = await verifyToken(token);
  } catch {
    return NextResponse.redirect(`${destBase}?ms=need_login`);
  }

  const state = Buffer.from(JSON.stringify({ upn, back }), "utf-8").toString("base64url");
  return NextResponse.redirect(buildMicrosoftAuthUrl(state));
}
