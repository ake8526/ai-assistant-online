import { NextResponse } from "next/server";
import { admin, assertConfigured } from "@/lib/supabaseServer";
import { exchangeCode } from "@/lib/youtube";

// GET /api/oauth/google/callback?code=...&state=<base64url upn>
export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code") || "";
  const state = url.searchParams.get("state") || "";
  let upn = "";
  try { upn = Buffer.from(state, "base64url").toString("utf-8").toLowerCase().trim(); } catch { /* bad state */ }

  const back = (m: string) => NextResponse.redirect(`${url.origin}/consents?yt=${encodeURIComponent(m)}`);
  if (!code || !upn) return back("error");

  try {
    assertConfigured();
    const tok = await exchangeCode(code);
    if (!tok.refresh_token) return back("no_refresh"); // user must revoke + reconsent to get one
    await admin.from("oauth_tokens").upsert(
      { owner_upn: upn, provider: "google", refresh_token: tok.refresh_token, scope: tok.scope || "", updated_at: new Date().toISOString() },
      { onConflict: "owner_upn,provider" }
    );
    // also auto-enable the YouTube source consent
    await admin.from("consents").upsert(
      { owner_upn: upn, capability: "src_youtube", granted: true, updated_at: new Date().toISOString() },
      { onConflict: "owner_upn,capability" }
    );
    return back("connected");
  } catch (e) {
    console.error("google callback", e);
    return back("error");
  }
}
