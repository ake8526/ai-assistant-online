import { NextResponse } from "next/server";
import { checkCronSecret } from "@/lib/auth";
import { nudgePendingMeetingInvites } from "@/lib/meetingInvite";
import { assertConfigured } from "@/lib/supabaseServer";
import { runWithTrace, trace } from "@/lib/trace";
import { jobSkipReason } from "@/lib/jobHealth";

export const maxDuration = 60;

/** GET/POST ?key=CRON_SECRET — hourly follow-up for unanswered LINE meeting requests. */
async function run(req: Request) {
  try {
    assertConfigured();
    if (!checkCronSecret(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const skip = await jobSkipReason("nudge");
    if (skip) return NextResponse.json({ ok: true, skipped: skip });
    const result = await runWithTrace({ channel: "cron" }, async () => {
      trace("receive", "cron · เตือนนัดค้างตอบ");
      const res = await nudgePendingMeetingInvites();
      if (res.nudged > 0 || res.hostAlerts > 0) {
        trace("reply", `เตือน ${res.nudged} · แจ้งโฮสต์ ${res.hostAlerts} · ค้างตอบ ${res.scanned} นัด`);
      } else {
        trace("reply", `ไม่มีนัดค้างตอบ · ตรวจคำขอนัด ${res.records} รายการ`, "skip");
      }
      return res;
    });
    return NextResponse.json({ ok: true, ...result });
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
