import { NextResponse } from "next/server";
import { AuthError, requireUser } from "@/lib/auth";
import { ingestActionItems } from "@/lib/followup";
import { summarizeOne } from "@/lib/meetings";
import { assertConfigured } from "@/lib/supabaseServer";
import { runWithTrace, trace } from "@/lib/trace";

export const maxDuration = 60;

// POST { event_id } → summarize one chosen meeting + ingest its action items
export async function POST(req: Request) {
  try {
    assertConfigured();
    const upn = await requireUser(req);
    const body = await req.json();
    const eventId = String(body.event_id || "");
    if (!eventId) return NextResponse.json({ error: "event_id required" }, { status: 400 });
    const out = await runWithTrace({ upn, channel: "web" }, async () => {
      trace("receive", "เว็บ · สรุปประชุมหนึ่งนัด");
      const res = await summarizeOne(upn, eventId);
      let added = 0;
      if (res.ok) added = await ingestActionItems(res.action_items || []);
      trace("reply", res.ok ? `สรุปสำเร็จ · งาน ${added}` : "สรุปไม่สำเร็จ", res.ok ? "done" : "error");
      return { ...res, added };
    });
    return NextResponse.json(out);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 401 });
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
