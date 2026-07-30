import { NextResponse } from "next/server";
import { AuthError, requireUser } from "@/lib/auth";
import { deleteEvent } from "@/lib/graph";

// POST { event_id } → cancel/delete a calendar event
export async function POST(req: Request) {
  try {
    const upn = await requireUser(req);
    const body = await req.json();
    const eventId = String(body.event_id || "");
    if (!eventId) return NextResponse.json({ error: "event_id required" }, { status: 400 });
    try {
      await deleteEvent(upn, eventId);
      return NextResponse.json({ ok: true });
    } catch (e) {
      return NextResponse.json({ ok: false, error: String(e).slice(0, 200) });
    }
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 401 });
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
