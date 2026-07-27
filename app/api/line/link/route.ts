import { NextResponse } from "next/server";
import { admin, assertConfigured } from "@/lib/supabaseServer";

// POST { line_user_id }  ?upn=<m365 upn>  → link the LINE account to the M365 user
export async function POST(req: Request) {
  try {
    assertConfigured();
    const upn = (new URL(req.url).searchParams.get("upn") || "").toLowerCase().trim();
    const body = await req.json();
    const lineUserId = String(body.line_user_id || "").trim();
    if (!upn || !lineUserId.startsWith("U")) {
      return NextResponse.json({ error: "upn and valid line_user_id required" }, { status: 400 });
    }
    const { error } = await admin.from("line_links").upsert(
      { upn, line_user_id: lineUserId, display_name: String(body.display_name || ""), linked_at: new Date().toISOString() },
      { onConflict: "upn" }
    );
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ linked: true, upn });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    assertConfigured();
    const upn = (new URL(req.url).searchParams.get("upn") || "").toLowerCase().trim();
    if (!upn) return NextResponse.json({ error: "upn required" }, { status: 400 });
    await admin.from("line_links").delete().eq("upn", upn);
    return NextResponse.json({ linked: false });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
