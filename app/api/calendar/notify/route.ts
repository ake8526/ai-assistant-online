import { NextResponse } from "next/server";
import { checkCronSecret } from "@/lib/auth";
import { notifyNewAppointments } from "@/lib/calendarNotify";
import { nudgePendingMeetingInvites } from "@/lib/meetingInvite";
import { admin, assertConfigured } from "@/lib/supabaseServer";
import { runWithTrace, trace } from "@/lib/trace";

export const maxDuration = 120;

// GET/POST — poll calendars for newly-created appointments and push LINE.
// Also nudges unanswered LINE meeting holds (~hourly; safe to call every few minutes).
async function run(req: Request) {
  try {
    assertConfigured();
    if (!checkCronSecret(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

    const { data } = await admin.from("line_links").select("upn");
    const users = (data || []).map((r) => r.upn);
    const results: Record<string, unknown> = {};
    for (const upn of users) {
      results[upn] = await runWithTrace({ upn, channel: "cron" }, async () => {
        trace("receive", "cron · แจ้งนัดใหม่");
        const res = await notifyNewAppointments(upn);
        if (res.notified > 0) trace("reply", `แจ้งนัดใหม่ ${res.notified} รายการ`);
        else trace("fetch", `ตรวจปฏิทิน · ${res.checked} นัด`);
        return res;
      });
    }
    const inviteNudge = await runWithTrace({ channel: "cron" }, async () => {
      trace("receive", "cron · เตือนนัดค้างตอบ");
      const res = await nudgePendingMeetingInvites();
      if (res.nudged > 0 || res.hostAlerts > 0) {
        trace("reply", `เตือน ${res.nudged} · แจ้งโฮสต์ ${res.hostAlerts}`);
      }
      return res;
    });
    return NextResponse.json({ ok: true, results, inviteNudge });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

export async function GET(req: Request) {
  return run(req);
}

export async function POST(req: Request) {
  return run(req);
}
