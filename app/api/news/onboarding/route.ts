import { NextResponse } from "next/server";
import { AuthError, checkCronSecret, requireUser } from "@/lib/auth";
import { startNewsOnboarding } from "@/lib/newsOnboarding";
import { getNewsPrefs, resetNewsOnboarding } from "@/lib/newsPrefs";
import { admin, assertConfigured } from "@/lib/supabaseServer";

export const dynamic = "force-dynamic";

/**
 * POST — start / reset news onboarding.
 * Cron: ?key=CRON_SECRET&upn=...&reset=1  (simulate new user)
 * User: Bearer → start for self
 */
export async function POST(req: Request) {
  try {
    assertConfigured();
    const url = new URL(req.url);
    const reset = url.searchParams.get("reset") === "1";

    if (checkCronSecret(req)) {
      let upn = (url.searchParams.get("upn") || "").trim().toLowerCase();
      if (!upn) {
        const { data } = await admin.from("line_links").select("upn").limit(1);
        upn = data?.[0]?.upn || "";
      }
      if (!upn) return NextResponse.json({ error: "no linked user" }, { status: 400 });
      if (reset) await resetNewsOnboarding(upn);
      await startNewsOnboarding(upn, "push");
      const prefs = await getNewsPrefs(upn);
      return NextResponse.json({ ok: true, upn, prefs, mode: "simulated_new_user" });
    }

    const upn = await requireUser(req);
    if (reset) await resetNewsOnboarding(upn);
    await startNewsOnboarding(upn, "push");
    return NextResponse.json({ ok: true, upn });
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 401 });
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
