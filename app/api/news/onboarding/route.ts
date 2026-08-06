import { NextResponse } from "next/server";
import { AuthError, checkCronSecret, requireUser } from "@/lib/auth";
import {
  previewBriefNotifySetup,
  previewNewsNotifySetup,
  pushSetupCompleteSummary,
  startNewsOnboarding,
} from "@/lib/newsOnboarding";
import { getNewsPrefs, resetNewsOnboarding } from "@/lib/newsPrefs";
import { resolveLinkedUpn } from "@/lib/line";
import { admin, assertConfigured } from "@/lib/supabaseServer";
import { runWithTrace, trace } from "@/lib/trace";

export const dynamic = "force-dynamic";

/**
 * POST — start / reset news onboarding.
 * Cron: ?key=CRON_SECRET&upn=...&reset=1  (simulate new user)
 * Cron: ?key=CRON_SECRET&upn=...&preview=notify|brief|done
 * User: Bearer → start for self
 */
export async function POST(req: Request) {
  try {
    assertConfigured();
    const url = new URL(req.url);
    const reset = url.searchParams.get("reset") === "1";
    const preview = (url.searchParams.get("preview") || "").trim();

    if (checkCronSecret(req)) {
      let upn = (url.searchParams.get("upn") || "").trim();
      if (upn) {
        const resolved = await resolveLinkedUpn(upn);
        if (!resolved) return NextResponse.json({ error: `upn not linked: ${upn}` }, { status: 404 });
        upn = resolved;
      } else {
        const { data } = await admin.from("line_links").select("upn").limit(1);
        upn = data?.[0]?.upn || "";
      }
      if (!upn) return NextResponse.json({ error: "no linked user" }, { status: 400 });
      return await runWithTrace({ upn, channel: "cron" }, async () => {
        trace("receive", preview ? `cron · preview ${preview}` : "cron · onboarding ข่าว");
        if (preview === "notify") {
          await previewNewsNotifySetup(upn);
          trace("reply", "preview notify");
          return NextResponse.json({ ok: true, upn, mode: "preview_notify" });
        }
        if (preview === "brief") {
          await previewBriefNotifySetup(upn);
          trace("reply", "preview brief");
          return NextResponse.json({ ok: true, upn, mode: "preview_brief" });
        }
        if (preview === "done") {
          await pushSetupCompleteSummary(upn);
          trace("reply", "preview done");
          return NextResponse.json({ ok: true, upn, mode: "preview_done" });
        }
        if (reset) await resetNewsOnboarding(upn);
        await startNewsOnboarding(upn, "push");
        const prefs = await getNewsPrefs(upn);
        trace("reply", "ส่ง onboarding");
        return NextResponse.json({ ok: true, upn, prefs, mode: "simulated_new_user" });
      });
    }

    const upn = await requireUser(req);
    return await runWithTrace({ upn, channel: "web" }, async () => {
      trace("receive", preview ? `เว็บ · preview ${preview}` : "เว็บ · onboarding ข่าว");
      if (preview === "notify") {
        await previewNewsNotifySetup(upn);
        trace("reply", "preview notify");
        return NextResponse.json({ ok: true, upn, mode: "preview_notify" });
      }
      if (preview === "brief") {
        await previewBriefNotifySetup(upn);
        trace("reply", "preview brief");
        return NextResponse.json({ ok: true, upn, mode: "preview_brief" });
      }
      if (preview === "done") {
        await pushSetupCompleteSummary(upn);
        trace("reply", "preview done");
        return NextResponse.json({ ok: true, upn, mode: "preview_done" });
      }
      if (reset) await resetNewsOnboarding(upn);
      await startNewsOnboarding(upn, "push");
      trace("reply", "ส่ง onboarding");
      return NextResponse.json({ ok: true, upn });
    });
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 401 });
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
