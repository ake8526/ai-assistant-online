import { NextResponse } from "next/server";
import { AuthError, checkCronSecret, requireUserOrCron } from "@/lib/auth";
import { assertConfigured } from "@/lib/supabaseServer";
import { buildDigest } from "@/lib/digest";
import { runWithTrace, trace } from "@/lib/trace";

export const maxDuration = 60;
export type { Story } from "@/lib/digest";

export async function GET(req: Request) {
  try {
    assertConfigured();
    const upn = await requireUserOrCron(req);
    const channel = checkCronSecret(req) ? "cron" : "web";
    const { stories, skipped, note } = await runWithTrace({ upn, channel }, async () => {
      trace("receive", channel === "cron" ? "cron · สรุปข่าว" : "เว็บ · สรุปข่าว");
      const d = await buildDigest(upn);
      trace("reply", `สรุปข่าว ${d.stories.length} เรื่อง`);
      return d;
    });
    return NextResponse.json({ ok: true, user: upn, count: stories.length, stories, skipped, ...(note ? { note } : {}) });
  } catch (e) {
    const status = e instanceof AuthError ? 401 : 500;
    return NextResponse.json({ error: String(e instanceof AuthError ? e.message : e) }, { status });
  }
}
