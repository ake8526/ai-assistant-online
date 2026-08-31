import { NextResponse } from "next/server";
import { AuthError, requireUser } from "@/lib/auth";
import { getEventsRange } from "@/lib/graph";
import { getUserGraphToken } from "@/lib/graphAuth";
import { calendarConsentNeededMessage, withDelegatedGraph } from "@/lib/msGraphOAuth";
import { addDays, endOfDay, nowWall, parseWall, startOfDay, wallIso } from "@/lib/time";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

/**
 * GET /api/calendar/events?from=&to=&graphToken=
 *
 * The app's calendar tab needs the week as data, not as a sentence — /api/command
 * only ever returned prose. Reads through the signed-in user's own Graph rights
 * (same as Outlook), so it shows exactly what they are allowed to see.
 */
export async function GET(req: Request) {
  try {
    const upn = await requireUser(req);
    const url = new URL(req.url);
    const live = url.searchParams.get("graphToken") || "";

    const fromParam = url.searchParams.get("from");
    const toParam = url.searchParams.get("to");
    const today = nowWall();
    const start = (fromParam && parseWall(fromParam)) || startOfDay(today);
    const end = (toParam && parseWall(toParam)) || endOfDay(addDays(today, 6));

    const { result, asUser } = await withDelegatedGraph(
      upn,
      async () => {
        if (!getUserGraphToken()) return { needConsent: true as const };
        const events = await getEventsRange(upn, wallIso(start), wallIso(end));
        return {
          events: events.map((e) => ({
            id: e.id || "",
            subject: e.subject || "(ไม่มีหัวเรื่อง)",
            start: e.start?.dateTime || "",
            end: e.end?.dateTime || "",
            allDay: !!e.isAllDay,
            location: e.location?.displayName || "",
            attendees: (e.attendees || []).length,
            organizer: e.organizer?.emailAddress?.name || "",
            joinUrl: e.onlineMeeting?.joinUrl || "",
            webLink: e.webLink || "",
            showAs: e.showAs || "",
          })),
        };
      },
      live
    );

    if (!asUser || "needConsent" in result) {
      return NextResponse.json(
        { error: "calendar_consent_required", reply: calendarConsentNeededMessage(), events: [] },
        { status: 200 }
      );
    }

    return NextResponse.json({
      from: wallIso(start),
      to: wallIso(end),
      ...result,
    });
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 401 });
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
