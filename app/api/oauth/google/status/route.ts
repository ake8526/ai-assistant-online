import { NextResponse } from "next/server";
import { admin, assertConfigured } from "@/lib/supabaseServer";
import { getGoogleAccount } from "@/lib/youtube";

/** GET /api/oauth/google/status?upn=... → which Google/YouTube account is linked */
export async function GET(req: Request) {
  try {
    assertConfigured();
    const upn = (new URL(req.url).searchParams.get("upn") || "").toLowerCase().trim();
    if (!upn) return NextResponse.json({ error: "upn required" }, { status: 400 });

    const { data: tok } = await admin
      .from("oauth_tokens")
      .select("refresh_token")
      .eq("owner_upn", upn)
      .eq("provider", "google")
      .maybeSingle();

    if (!tok?.refresh_token) {
      return NextResponse.json({ linked: false, email: null, name: null, channel: null });
    }

    let email: string | null = null;
    let name: string | null = null;
    let channel: string | null = null;

    // Prefer cached identity columns if migration was applied
    try {
      const { data: cached } = await admin
        .from("oauth_tokens")
        .select("account_email, account_name, account_channel")
        .eq("owner_upn", upn)
        .eq("provider", "google")
        .maybeSingle();
      email = cached?.account_email || null;
      name = cached?.account_name || null;
      channel = cached?.account_channel || null;
    } catch { /* columns missing */ }

    if (!email && !channel) {
      try {
        const info = await getGoogleAccount(tok.refresh_token);
        email = info.email || null;
        name = info.name || null;
        channel = info.channel || null;
        if (email || name || channel) {
          try {
            await admin
              .from("oauth_tokens")
              .update({
                account_email: email,
                account_name: name,
                account_channel: channel,
                updated_at: new Date().toISOString(),
              })
              .eq("owner_upn", upn)
              .eq("provider", "google");
          } catch { /* columns missing — display still works */ }
        }
      } catch {
        return NextResponse.json({
          linked: true,
          email: null,
          name: null,
          channel: null,
          note: "เชื่อมแล้ว แต่ดึงชื่อบัญชีไม่ได้ — ลองเชื่อม YouTube ใหม่",
        });
      }
    }

    return NextResponse.json({ linked: true, email, name, channel });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
