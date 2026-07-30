import { NextResponse } from "next/server";
import { AuthError, requireUser } from "@/lib/auth";
import { freeRanges, formatFree } from "@/lib/scheduling";
import { fmtDateTime, fmtTime, periodRange, wallIso } from "@/lib/time";

export const maxDuration = 60;

// POST { email, who?, period? } → free slots for a person (used by "ดูตาราง..." chips)
export async function POST(req: Request) {
  try {
    const upn = await requireUser(req);
    const body = await req.json();
    const email = String(body.email || "").trim();
    if (!email) return NextResponse.json({ error: "email required" }, { status: 400 });
    const who = String(body.who || email);
    const period = String(body.period || "week");

    const { start, end, label } = periodRange(period);
    const ranges = await freeRanges(email, start, end, upn);
    const slots = ranges.map((r) => ({
      start: wallIso(r.start),
      end: wallIso(r.end),
      label: `${fmtDateTime(r.start)}-${fmtTime(r.end)}`,
    }));
    const reply = slots.length
      ? `🗓️ เวลาว่างของ ${who} (${label}) 👇 เลือกช่วงเพื่อจองได้เลยครับ`
      : formatFree(ranges, label, who);
    return NextResponse.json({ intent: "availability", reply, person: { mail: email, displayName: who }, slots });
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 401 });
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
