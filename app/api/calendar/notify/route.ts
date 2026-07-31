import { NextResponse } from "next/server";
import { checkCronSecret } from "@/lib/auth";
import { notifyNewAppointments } from "@/lib/calendarNotify";
import { admin, assertConfigured } from "@/lib/supabaseServer";

export const maxDuration = 120;

// GET/POST — poll calendars for newly-created appointments and push LINE.
async function run(req: Request) {
  try {
    assertConfigured();
    if (!checkCronSecret(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

    const { data } = await admin.from("line_links").select("upn");
    const users = (data || []).map((r) => r.upn);
    const results: Record<string, unknown> = {};
    for (const upn of users) {
      results[upn] = await notifyNewAppointments(upn);
    }
    return NextResponse.json({ ok: true, results });
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
