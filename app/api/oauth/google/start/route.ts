import { NextResponse } from "next/server";
import { buildAuthUrl, isConfigured } from "@/lib/youtube";

// GET /api/oauth/google/start?upn=...  → redirect to Google account picker + consent
export async function GET(req: Request) {
  const url = new URL(req.url);
  const upn = (url.searchParams.get("upn") || "").toLowerCase().trim();
  const back = url.searchParams.get("back") || "/account";

  if (!isConfigured()) {
    const dest = `${url.origin}${back.startsWith("/") ? back : "/account"}?yt=need_google_oauth`;
    return NextResponse.redirect(dest);
  }
  if (!upn) {
    return NextResponse.redirect(`${url.origin}/account?yt=need_login`);
  }

  // state = upn + return path so callback can send the user back
  const state = Buffer.from(JSON.stringify({ upn, back }), "utf-8").toString("base64url");
  return NextResponse.redirect(buildAuthUrl(state));
}
