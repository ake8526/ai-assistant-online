import { NextResponse } from "next/server";
import { checkCronSecret } from "@/lib/auth";
import { nudgePendingMeetingInvites } from "@/lib/meetingInvite";
import { assertConfigured } from "@/lib/supabaseServer";

export const maxDuration = 60;

/** GET/POST ?key=CRON_SECRET — hourly follow-up for unanswered LINE meeting requests. */
async function run(req: Request) {
  try {
    assertConfigured();
    if (!checkCronSecret(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const result = await nudgePendingMeetingInvites();
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
