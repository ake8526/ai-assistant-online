import { NextResponse } from "next/server";
import { AuthError, requireUser } from "@/lib/auth";
import { createEvent } from "@/lib/graph";
import { bookMeetingWithLineHold } from "@/lib/meetingInvite";
import { withDelegatedGraph } from "@/lib/msGraphOAuth";
import { addMinutes, parseWall, wallIso } from "@/lib/time";
import { runWithTrace, trace } from "@/lib/trace";

export const maxDuration = 60;

// POST { subject, start, end?, duration_min?, attendees[], graphToken? } → book a meeting
export async function POST(req: Request) {
  try {
    const upn = await requireUser(req);
    const body = await req.json();
    const start = parseWall(String(body.start || ""));
    if (!start) return NextResponse.json({ error: "start required" }, { status: 400 });
    const end = body.end ? parseWall(String(body.end)) : addMinutes(start, Number(body.duration_min || 30));
    if (!end) return NextResponse.json({ error: "invalid end" }, { status: 400 });
    const subject = String(body.subject || "ประชุม");
    const attendees = (body.attendees as string[]) || [];
    try {
      const live = typeof body.graphToken === "string" ? body.graphToken : "";
      const held = await runWithTrace({ upn, channel: "web" }, async () => {
        trace("receive", "เว็บ · จองประชุม");
        const res = await bookMeetingWithLineHold({
          organizerUpn: upn,
          subject,
          startIso: wallIso(start),
          endIso: wallIso(end),
          attendees,
          create: async () => {
            const { result: ev } = await withDelegatedGraph(
              upn,
              () => createEvent(upn, subject, wallIso(start), wallIso(end), attendees),
              live
            );
            return ev;
          },
        });
        trace("reply", res.mode === "proposed" ? "ส่งคำขอ LINE" : "จองปฏิทินแล้ว");
        return res;
      });
      return NextResponse.json({
        ok: true,
        mode: held.mode,
        join_url: undefined,
        web_link: undefined,
        line_notified: held.notified,
        held: held.mode === "proposed",
        note: held.note,
      });
    } catch (e) {
      return NextResponse.json({ ok: false, error: String(e).slice(0, 200) });
    }
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 401 });
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
