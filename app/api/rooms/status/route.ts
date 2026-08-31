import { NextResponse } from "next/server";
import { AuthError, requireUser } from "@/lib/auth";
import { getSchedule } from "@/lib/graph";
import { getUserGraphToken } from "@/lib/graphAuth";
import { KNOWN_MEETING_ROOMS } from "@/lib/meetingRooms";
import { calendarConsentNeededMessage, withDelegatedGraph } from "@/lib/msGraphOAuth";
import { endOfDay, fmtTime, nowWall, parseWall, startOfDay, wallIso } from "@/lib/time";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

const SLOT_MIN = 30;

type Busy = { start: string; end: string; label: string };

/**
 * availabilityView is one character per SLOT_MIN interval: '0' free, anything
 * else taken. Collapse runs of taken slots into windows so the app can say
 * "ไม่ว่าง 09:30 – 10:30" instead of showing 48 cells.
 */
function busyWindows(view: string, dayStart: Date): { busy: Busy[]; takenSlots: number } {
  const busy: Busy[] = [];
  let runStart = -1;
  let taken = 0;
  const at = (slot: number) => new Date(dayStart.getTime() + slot * SLOT_MIN * 60_000);

  for (let i = 0; i <= view.length; i++) {
    const isBusy = i < view.length && view[i] !== "0";
    if (isBusy) taken++;
    if (isBusy && runStart < 0) runStart = i;
    if (!isBusy && runStart >= 0) {
      const s = at(runStart);
      const e = at(i);
      busy.push({ start: wallIso(s), end: wallIso(e), label: `${fmtTime(s)} – ${fmtTime(e)}` });
      runStart = -1;
    }
  }
  return { busy, takenSlots: taken };
}

/**
 * GET /api/rooms/status?date=&graphToken=
 *
 * Real room mailboxes from lib/meetingRooms, real free/busy from Graph. Only the
 * rooms actually configured there are returned — there is one today.
 */
export async function GET(req: Request) {
  try {
    const upn = await requireUser(req);
    const url = new URL(req.url);
    const live = url.searchParams.get("graphToken") || "";
    const dateParam = url.searchParams.get("date");
    const base = (dateParam && parseWall(dateParam)) || nowWall();
    const dayStart = startOfDay(base);
    const dayEnd = endOfDay(base);

    const { result, asUser } = await withDelegatedGraph(
      upn,
      async () => {
        if (!getUserGraphToken()) return { needConsent: true as const };
        const emails = KNOWN_MEETING_ROOMS.map((r) => r.email);
        const schedules = await getSchedule(upn, emails, wallIso(dayStart), wallIso(dayEnd), SLOT_MIN);

        const rooms = KNOWN_MEETING_ROOMS.map((room, i) => {
          const sched = schedules[i];
          const view = String(sched?.availabilityView || "");
          const { busy, takenSlots } = busyWindows(view, dayStart);
          const slots = view.length || 1;
          return {
            email: room.email,
            name: room.name,
            busy,
            free: busy.length === 0,
            loadPct: Math.round((takenSlots / slots) * 100),
            error: sched?.error?.message || "",
          };
        });
        return { rooms };
      },
      live
    );

    if (!asUser || "needConsent" in result) {
      return NextResponse.json(
        { error: "calendar_consent_required", reply: calendarConsentNeededMessage(), rooms: [] },
        { status: 200 }
      );
    }

    return NextResponse.json({ date: wallIso(dayStart), ...result });
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 401 });
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
