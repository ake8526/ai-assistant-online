import { NextResponse } from "next/server";
import { admin, assertConfigured } from "@/lib/supabaseServer";
import { exchangeCode, getGoogleAccountFromAccessToken, getGoogleAccount } from "@/lib/youtube";

type OAuthState = { upn: string; back?: string };

function parseState(raw: string): OAuthState {
  try {
    const j = JSON.parse(Buffer.from(raw, "base64url").toString("utf-8"));
    if (j && typeof j.upn === "string") return { upn: j.upn.toLowerCase().trim(), back: j.back || "/account" };
  } catch { /* legacy: state was plain upn */ }
  try {
    return { upn: Buffer.from(raw, "base64url").toString("utf-8").toLowerCase().trim(), back: "/account" };
  } catch {
    return { upn: "", back: "/account" };
  }
}

// GET /api/oauth/google/callback?code=...&state=...
export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code") || "";
  const { upn, back } = parseState(url.searchParams.get("state") || "");
  const dest = (m: string) =>
    NextResponse.redirect(`${url.origin}${(back || "/account").startsWith("/") ? back || "/account" : "/account"}?yt=${encodeURIComponent(m)}`);

  if (!code || !upn) return dest("error");

  try {
    assertConfigured();
    const tok = await exchangeCode(code);
    if (!tok.refresh_token) return dest("no_refresh");

    await admin.from("oauth_tokens").upsert(
      {
        owner_upn: upn,
        provider: "google",
        refresh_token: tok.refresh_token,
        scope: tok.scope || "",
        updated_at: new Date().toISOString(),
      },
      { onConflict: "owner_upn,provider" }
    );

    try {
      const info = tok.access_token
        ? await getGoogleAccountFromAccessToken(tok.access_token)
        : await getGoogleAccount(tok.refresh_token);
      await admin
        .from("oauth_tokens")
        .update({
          account_email: info.email || null,
          account_name: info.name || null,
          account_channel: info.channel || null,
          updated_at: new Date().toISOString(),
        })
        .eq("owner_upn", upn)
        .eq("provider", "google");
    } catch { /* identity columns optional */ }

    await admin.from("consents").upsert(
      { owner_upn: upn, capability: "src_youtube", granted: true, updated_at: new Date().toISOString() },
      { onConflict: "owner_upn,capability" }
    );
    return dest("connected");
  } catch (e) {
    console.error("google callback", e);
    return dest("error");
  }
}
