import { NextResponse } from "next/server";
import { checkCronSecret } from "@/lib/auth";
import { buildMeetingPrep, resolveAgendaEntry } from "@/lib/brief";
import { sendLine } from "@/lib/line";
import { withDelegatedGraph } from "@/lib/msGraphOAuth";
import { assertConfigured } from "@/lib/supabaseServer";

export const maxDuration = 120;

/** Cron/helper: prep agenda index and push to LINE. ?upn=&i=1&force=1 */
async function run(req: Request) {
  try {
    assertConfigured();
    if (!checkCronSecret(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const url = new URL(req.url);
    const upn = (url.searchParams.get("upn") || "").toLowerCase().trim();
    const idx = Number(url.searchParams.get("i") || "1");
    if (!upn) return NextResponse.json({ error: "upn required" }, { status: 400 });
    if (!idx || idx < 1) return NextResponse.json({ error: "i (index) required" }, { status: 400 });

    const entry = await resolveAgendaEntry(upn, idx);
    if (!entry) {
      return NextResponse.json({ ok: false, error: "agenda index not found — send morning brief first" }, { status: 404 });
    }

    const { result: reply } = await withDelegatedGraph(upn, () =>
      buildMeetingPrep(upn, entry.eventId, entry.event)
    );
    await sendLine(upn, "", reply);
    return NextResponse.json({ ok: true, upn, index: idx, subject: entry.event.subject || null });
  } catch (e) {
    return NextResponse.json({ error: String(e).slice(0, 300) }, { status: 500 });
  }
}

export async function GET(req: Request) {
  return run(req);
}
export async function POST(req: Request) {
  return run(req);
}
