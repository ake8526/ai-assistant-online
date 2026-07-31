// Detect newly-created calendar appointments and push a LINE notice.
// Strategy: poll upcoming events every cron tick; first run seeds IDs without
// notifying (avoid flooding); later runs notify only for never-seen event IDs.
import { GraphEvent, getEventsRange, TIMEZONE } from "@/lib/graph";
import { sendLine } from "@/lib/line";
import { getSetting, setSetting } from "@/lib/store";
import { admin } from "@/lib/supabaseServer";
import { addMinutes, nowWall, wallIso } from "@/lib/time";

const LOOKAHEAD_DAYS = 14;
const SEED_KEY = "calendar_notify_seeded";

async function wasNotified(ownerUpn: string, eventId: string): Promise<boolean> {
  const { data } = await admin
    .from("calendar_notified")
    .select("event_id")
    .eq("owner_upn", ownerUpn)
    .eq("event_id", eventId)
    .maybeSingle();
  return !!data;
}

async function markNotified(ownerUpn: string, eventId: string, subject: string): Promise<void> {
  await admin.from("calendar_notified").upsert(
    { owner_upn: ownerUpn, event_id: eventId, subject, notified_at: new Date().toISOString() },
    { onConflict: "owner_upn,event_id", ignoreDuplicates: true }
  );
}

function fmtWhen(ev: GraphEvent): string {
  const start = ev.start?.dateTime || "";
  // Graph returns local wall time when Prefer timezone is set — show as-is
  if (!start) return "?";
  const [date, time] = start.split("T");
  const [y, m, d] = (date || "").split("-");
  const hm = (time || "").slice(0, 5);
  if (!y || !m || !d) return start.slice(0, 16);
  return `${d}/${m}/${y} ${hm}`;
}

function formatNewEvent(ev: GraphEvent): string {
  const subject = ev.subject || "(ไม่มีหัวข้อ)";
  const lines = [
    "📅 มีนัดใหม่เข้ามา",
    "",
    `📌 ${fmtWhen(ev)} — ${subject}`,
  ];
  if (ev.location?.displayName) lines.push(`📍 ${ev.location.displayName}`);
  if (ev.onlineMeeting?.joinUrl) lines.push(`🔗 ${ev.onlineMeeting.joinUrl}`);
  const org = ev.organizer?.emailAddress?.name || ev.organizer?.emailAddress?.address;
  if (org) lines.push(`👤 จัดโดย: ${org}`);
  const people = (ev.attendees || [])
    .map((a) => a.emailAddress?.name || a.emailAddress?.address)
    .filter(Boolean)
    .slice(0, 8);
  if (people.length) lines.push(`👥 ผู้เข้าร่วม: ${people.join(", ")}`);
  lines.push("", `⏱ เขตเวลา ${TIMEZONE}`);
  return lines.join("\n");
}

export type CalendarNotifyResult = {
  checked: number;
  seeded: number;
  notified: number;
  skipped: number;
  error?: string;
};

/** Scan upcoming calendar; notify LINE for brand-new events. */
export async function notifyNewAppointments(upn: string): Promise<CalendarNotifyResult> {
  const out: CalendarNotifyResult = { checked: 0, seeded: 0, notified: 0, skipped: 0 };
  try {
    const now = nowWall();
    const end = addMinutes(now, LOOKAHEAD_DAYS * 24 * 60);
    const events = await getEventsRange(upn, wallIso(now), wallIso(end));
    out.checked = events.length;

    const seeded = (await getSetting(upn, SEED_KEY)) === "1";
    if (!seeded) {
      for (const ev of events) {
        const id = ev.id;
        if (!id) continue;
        await markNotified(upn, id, ev.subject || "");
        out.seeded += 1;
      }
      await setSetting(upn, SEED_KEY, "1");
      return out;
    }

    for (const ev of events) {
      const id = ev.id;
      if (!id) {
        out.skipped += 1;
        continue;
      }
      if (await wasNotified(upn, id)) {
        out.skipped += 1;
        continue;
      }
      try {
        await sendLine(upn, "", formatNewEvent(ev));
        await markNotified(upn, id, ev.subject || "");
        out.notified += 1;
      } catch (e) {
        out.error = String(e).slice(0, 150);
        // still mark so we don't retry-spam a broken push forever for this event
        await markNotified(upn, id, ev.subject || "");
      }
    }
  } catch (e) {
    out.error = String(e).slice(0, 200);
  }
  return out;
}
