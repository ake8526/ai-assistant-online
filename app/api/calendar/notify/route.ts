import { NextResponse } from "next/server";
import { checkCronSecret } from "@/lib/auth";
import { notifyNewAppointments } from "@/lib/calendarNotify";
import { nudgePendingMeetingInvites } from "@/lib/meetingInvite";
import { admin, assertConfigured } from "@/lib/supabaseServer";
import { runWithTrace, trace } from "@/lib/trace";
import { isJobPaused } from "@/lib/opsPause";

export const maxDuration = 120;

// GET/POST — poll calendars for newly-created appointments and push LINE.
// Also nudges unanswered LINE meeting holds (~hourly; safe to call every few minutes).
async function run(req: Request) {
  try {
    assertConfigured();
    if (!checkCronSecret(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

    // Paused from /monitor/log — poll nothing until the pause lapses.
    if (await isJobPaused("calendar")) return NextResponse.json({ ok: true, paused: "calendar" });

    const { data } = await admin.from("line_links").select("upn");
    const users = (data || []).map((r) => r.upn);
    const results: Record<string, unknown> = {};
    for (const upn of users) {
      results[upn] = await runWithTrace({ upn, channel: "cron" }, async () => {
        trace("receive", "cron · แจ้งนัดใหม่");
        const res = await notifyNewAppointments(upn);
        if (res.notified > 0) trace("reply", `แจ้งนัดใหม่ ${res.notified} รายการ`);
        // Nothing new to announce is a finished run, so say so — ending on a
        // fetch made every quiet poll look like a job that died mid-flight.
        else trace("reply", `ไม่มีนัดใหม่ · ตรวจ ${res.checked} นัด`, "skip");
        return res;
      });
    }
    // This route also carries the invite nudge, which has its own pause.
    if (await isJobPaused("nudge")) {
      return NextResponse.json({ ok: true, results, inviteNudge: "paused" });
    }
    const inviteNudge = await runWithTrace({ channel: "cron" }, async () => {
      trace("receive", "cron · เตือนนัดค้างตอบ");
      const res = await nudgePendingMeetingInvites();
      if (res.nudged > 0 || res.hostAlerts > 0) {
        trace("reply", `เตือน ${res.nudged} · แจ้งโฮสต์ ${res.hostAlerts}`);
      } else {
        trace("reply", "ไม่มีนัดค้างตอบ", "skip");
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
