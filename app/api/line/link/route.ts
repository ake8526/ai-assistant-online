import { NextResponse } from "next/server";
import { AuthError, resolveUser } from "@/lib/auth";
import { admin, assertConfigured } from "@/lib/supabaseServer";

// POST { line_user_id } + Bearer → link the LINE account to the signed-in M365 user
export async function POST(req: Request) {
  try {
    assertConfigured();
    const upn = await resolveUser(req);
    const body = await req.json();
    const lineUserId = String(body.line_user_id || "").trim();
    if (!lineUserId.startsWith("U")) {
      return NextResponse.json({ error: "valid line_user_id required" }, { status: 400 });
    }
    const { error } = await admin.from("line_links").upsert(
      { upn, line_user_id: lineUserId, display_name: String(body.display_name || ""), linked_at: new Date().toISOString() },
      { onConflict: "upn" }
    );
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ linked: true, upn });
  } catch (e) {
    const status = e instanceof AuthError ? 401 : 500;
    return NextResponse.json({ error: String(e instanceof AuthError ? e.message : e) }, { status });
  }
}

// DELETE + Bearer → unlink the signed-in user's LINE link
export async function DELETE(req: Request) {
  try {
    assertConfigured();
    const upn = await resolveUser(req);
    await admin.from("line_links").delete().eq("upn", upn);
    return NextResponse.json({ linked: false });
  } catch (e) {
    const status = e instanceof AuthError ? 401 : 500;
    return NextResponse.json({ error: String(e instanceof AuthError ? e.message : e) }, { status });
  }
}
