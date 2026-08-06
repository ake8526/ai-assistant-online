import { NextResponse } from "next/server";
import { AuthError, resolveUser } from "@/lib/auth";
import { admin, assertConfigured } from "@/lib/supabaseServer";
import { startNewsOnboarding } from "@/lib/newsOnboarding";
import { getNewsPrefs } from "@/lib/newsPrefs";
import { runWithTrace, trace } from "@/lib/trace";

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
    return await runWithTrace({ upn, channel: "web" }, async () => {
      trace("receive", "เว็บ · ลิงก์บัญชี LINE");
      const { error } = await admin.from("line_links").upsert(
        { upn, line_user_id: lineUserId, display_name: String(body.display_name || ""), linked_at: new Date().toISOString() },
        { onConflict: "upn" }
      );
      if (error) {
        trace("error", "ลิงก์ LINE ไม่สำเร็จ", "error");
        return NextResponse.json({ error: error.message }, { status: 500 });
      }

      // First-time (or not yet finished) → welcome news onboarding on LINE
      let onboarding = false;
      try {
        const prefs = await getNewsPrefs(upn);
        if (!prefs.onboardingDone) {
          trace("compose", "เริ่ม onboarding ข่าว");
          await startNewsOnboarding(upn, "push");
          onboarding = true;
        }
      } catch (e) {
        console.warn("[line-link] onboarding push failed:", e);
      }

      trace("reply", onboarding ? "ลิงก์แล้ว · ส่ง onboarding" : "ลิงก์แล้ว");
      return NextResponse.json({ linked: true, upn, onboarding });
    });
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
