import { NextResponse } from "next/server";
import { AuthError, resolveUser } from "@/lib/auth";
import { admin, assertConfigured } from "@/lib/supabaseServer";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

// GET:
//  - ?line_user_id=U...  → public check used by LIFF before M365 login
//  - Bearer (optional ?upn=) → status for the signed-in user
export async function GET(req: Request) {
  try {
    assertConfigured();
    const url = new URL(req.url);
    const lineUserId = (url.searchParams.get("line_user_id") || "").trim();

    if (lineUserId) {
      const { data } = await admin
        .from("line_links")
        .select("upn, line_user_id, display_name")
        .eq("line_user_id", lineUserId)
        .maybeSingle();
      return NextResponse.json({
        linked: !!data?.line_user_id,
        upn: data?.upn || null,
        display_name: data?.display_name || null,
      }, { headers: NO_STORE });
    }

    const upn = await resolveUser(req);
    const { data } = await admin
      .from("line_links")
      .select("upn, line_user_id, display_name")
      .eq("upn", upn)
      .maybeSingle();
    return NextResponse.json({
      linked: !!data?.line_user_id,
      upn: data?.upn || null,
      display_name: data?.display_name || null,
    }, { headers: NO_STORE });
  } catch (e) {
    const status = e instanceof AuthError ? 401 : 500;
    return NextResponse.json({ error: String(e instanceof AuthError ? e.message : e) }, { status });
  }
}
