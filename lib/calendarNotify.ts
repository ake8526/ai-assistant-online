// Detect newly-created calendar appointments and push a LINE notice.
// Strategy: poll upcoming events every cron tick; the first run records the IDs
// without notifying (never flood on install); later runs notify only IDs never
// seen before.
//
// The seen-set lives in `settings` like `news_seen` does. It used to live in a
// `calendar_notified` table whose migration was never run: every write failed,
// the error was discarded, so every poll re-announced every upcoming meeting.
// Anything that needs a manual SQL step can be forgotten the same way, so this
// now uses a store that ships with the app — and a failed write throws instead
// of quietly turning the dedupe off.
import { createHash } from "crypto";
import { GraphEvent, getEventsRange, TIMEZONE } from "@/lib/graph";
import { sendLine } from "@/lib/line";
import { getSetting, setSetting } from "@/lib/store";
import { addMinutes, nowWall, wallIso } from "@/lib/time";
import { addNotice } from "@/lib/inbox";

const LOOKAHEAD_DAYS = 14;
/** Absent = never seeded; a fresh key name so the old (empty) seed flag cannot
 *  make the first run after this fix announce two weeks of meetings at once. */
const SEEN_KEY = "calendar_seen";
const SEEN_MAX = 400;
/** Must exceed LOOKAHEAD_DAYS by a wide margin — an entry that ages out while
 *  its meeting is still upcoming would be announced a second time. */
const SEEN_TTL_MS = 45 * 24 * 60 * 60 * 1000;
/** Backstop: however broken the dedupe gets, one poll can never send more than
 *  this. The rest go out on the next poll. */
const MAX_NOTIFY_PER_RUN = 5;

type SeenEntry = [key: string, ts: number];

/** Graph event ids are long; store a short digest instead. */
function seenKey(eventId: string): string {
  return createHash("sha1").update(eventId, "utf8").digest("hex").slice(0, 16);
}

async function loadSeen(upn: string): Promise<SeenEntry[] | null> {
  const raw = await getSetting(upn, SEEN_KEY);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as SeenEntry[]) : null;
  } catch {
    return null;
  }
}

async function saveSeen(upn: string, entries: SeenEntry[]): Promise<void> {
  const cutoff = Date.now() - SEEN_TTL_MS;
  const kept = entries
    .filter(([, ts]) => ts >= cutoff)
    .sort((a, b) => b[1] - a[1])
    .slice(0, SEEN_MAX);
  await setSetting(upn, SEEN_KEY, JSON.stringify(kept));
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
  /** New events held back by MAX_NOTIFY_PER_RUN — they go out next poll. */
  capped?: number;
  error?: string;
};

/** Scan upcoming calendar; notify LINE for brand-new events. */
export async function notifyNewAppointments(upn: string): Promise<CalendarNotifyResult> {
  const out: CalendarNotifyResult = { checked: 0, seeded: 0, notified: 0, skipped: 0 };
  try {
    const now = nowWall();
    const end = addMinutes(now, LOOKAHEAD_DAYS * 24 * 60);
    const events = (await getEventsRange(upn, wallIso(now), wallIso(end))).filter((e) => e.id);
    out.checked = events.length;

    const stored = await loadSeen(upn);
    if (!stored) {
      await saveSeen(upn, events.map((ev) => [seenKey(ev.id as string), Date.now()] as SeenEntry));
      out.seeded = events.length;
      return out;
    }

    const seen = new Map<string, number>(stored);
    const fresh = events.filter((ev) => !seen.has(seenKey(ev.id as string)));
    out.skipped = events.length - fresh.length;
    if (!fresh.length) return out;

    const batch = fresh.slice(0, MAX_NOTIFY_PER_RUN);
    if (fresh.length > batch.length) out.capped = fresh.length - batch.length;

    try {
      for (const ev of batch) {
        // Mark first: a push that throws must not be retried on every poll.
        seen.set(seenKey(ev.id as string), Date.now());
        const text = formatNewEvent(ev);
        await addNotice(upn, { kind: "meeting", title: "📅 นัดใหม่ในปฏิทิน", body: text }).catch(() => {});
        await sendLine(upn, "", text);
        out.notified += 1;
      }
    } finally {
      // One write per run, and a failure here throws — the dedupe going quiet
      // is exactly the failure that caused the flood.
      await saveSeen(upn, Array.from(seen.entries()) as SeenEntry[]);
    }
  } catch (e) {
    out.error = String(e).slice(0, 200);
  }
  return out;
}
