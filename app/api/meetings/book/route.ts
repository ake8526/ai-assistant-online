import { NextResponse } from "next/server";
import { AuthError, requireUser } from "@/lib/auth";
import { createEvent } from "@/lib/graph";
import { withDelegatedGraph } from "@/lib/msGraphOAuth";
import { addMinutes, parseWall, wallIso } from "@/lib/time";

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
    try {
      const live = typeof body.graphToken === "string" ? body.graphToken : "";
      const { result: ev } = await withDelegatedGraph(
        upn,
        () =>
          createEvent(
            upn,
            String(body.subject || "ประชุม"),
            wallIso(start),
            wallIso(end),
            (body.attendees as string[]) || []
          ),
        live
      );
      return NextResponse.json({ ok: true, join_url: ev.onlineMeeting?.joinUrl, web_link: ev.webLink });
    } catch (e) {
      return NextResponse.json({ ok: false, error: String(e).slice(0, 200) });
    }
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 401 });
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
