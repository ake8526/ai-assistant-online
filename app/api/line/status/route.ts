import { NextResponse } from "next/server";
import { admin, assertConfigured } from "@/lib/supabaseServer";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

// GET ?upn=<m365 upn>  OR  ?line_user_id=U...  → is this account linked?
export async function GET(req: Request) {
  try {
    assertConfigured();
    const url = new URL(req.url);
    const upn = (url.searchParams.get("upn") || "").toLowerCase().trim();
    const lineUserId = (url.searchParams.get("line_user_id") || "").trim();
    if (!upn && !lineUserId) {
      return NextResponse.json({ error: "upn or line_user_id required" }, { status: 400 });
    }
    const query = admin.from("line_links").select("upn, line_user_id, display_name");
    const { data } = lineUserId
      ? await query.eq("line_user_id", lineUserId).maybeSingle()
      : await query.eq("upn", upn).maybeSingle();
    return NextResponse.json({
      linked: !!data?.line_user_id,
      upn: data?.upn || null,
      display_name: data?.display_name || null,
    }, { headers: NO_STORE });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
