import { NextResponse } from "next/server";
import { admin, assertConfigured } from "@/lib/supabaseServer";

export async function GET(req: Request) {
  try {
    assertConfigured();
    const upn = (new URL(req.url).searchParams.get("upn") || "").toLowerCase().trim();
    if (!upn) return NextResponse.json({ error: "upn required" }, { status: 400 });
    const { data } = await admin.from("line_links").select("line_user_id").eq("upn", upn).single();
    return NextResponse.json({ linked: !!data?.line_user_id });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
