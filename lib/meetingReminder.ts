/**
 * LINE push when a meeting starts within the user's lead-time window.
 * Dedupe lives in settings (same pattern as calendar_seen) — no SQL migration.
 */
import { createHash } from "crypto";
import { getEventsRange, type GraphEvent } from "@/lib/graph";
import { sendLine } from "@/lib/line";
import { getMeetingRemindMinutes } from "@/lib/remindPrefs";
import { getSetting, setSetting } from "@/lib/store";
import { addMinutes, nowWall, parseWall, wallIso } from "@/lib/time";
import { addNotice } from "@/lib/inbox";

const SEEN_KEY = "meeting_remind_seen";
const SEEN_MAX = 200;
const SEEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_PER_RUN = 5;

type SeenEntry = [key: string, ts: number];

function entryKey(eventId: string, start: string): string {
  return createHash("sha1").update(`${eventId}|${start}`, "utf8").digest("hex").slice(0, 16);
}

async function loadSeen(upn: string): Promise<SeenEntry[]> {
  const raw = await getSetting(upn, SEEN_KEY);
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as SeenEntry[]) : [];
  } catch {
    return [];
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
  if (!start) return "?";
  const [date, time] = start.split("T");
  const [y, m, d] = (date || "").split("-");
  const hm = (time || "").slice(0, 5);
  if (!y || !m || !d) return start.slice(0, 16);
  return `${d}/${m}/${y} ${hm}`;
}

function formatUpcoming(ev: GraphEvent, minutes: number): string {
  const subject = ev.subject || "(ไม่มีหัวข้อ)";
  const lines = [
    `⏰ อีกประมาณ ${minutes} นาทีจะถึงเวลานัด`,
    "",
    `📌 ${fmtWhen(ev)} — ${subject}`,
  ];
  if (ev.location?.displayName) lines.push(`📍 ${ev.location.displayName}`);
  if (ev.onlineMeeting?.joinUrl) lines.push(`🔗 ${ev.onlineMeeting.joinUrl}`);
  return lines.join("\n");
}

export type MeetingRemindResult = {
  checked: number;
  notified: number;
  skipped: number;
  disabled?: boolean;
};

/** Push LINE for meetings starting within the user's remind window. */
export async function notifyUpcomingMeetings(upn: string): Promise<MeetingRemindResult> {
  const out: MeetingRemindResult = { checked: 0, notified: 0, skipped: 0 };
  const minutes = await getMeetingRemindMinutes(upn);
  if (minutes <= 0) {
    out.disabled = true;
    return out;
  }

  const now = nowWall();
  const windowEnd = addMinutes(now, minutes);
  // Look a little past the window so clock skew / poll lag does not miss one.
  const scanEnd = addMinutes(now, minutes + 5);
  const events = (await getEventsRange(upn, wallIso(now), wallIso(scanEnd))).filter((e) => e.id);
  out.checked = events.length;

  const due: GraphEvent[] = [];
  for (const ev of events) {
    const start = parseWall(ev.start?.dateTime || "");
    if (!start) continue;
    if (start.getTime() < now.getTime()) continue;
    if (start.getTime() > windowEnd.getTime()) continue;
    due.push(ev);
  }
  if (!due.length) return out;

  const seen = new Map(await loadSeen(upn));
  const fresh = due.filter((ev) => !seen.has(entryKey(ev.id as string, ev.start?.dateTime || "")));
  out.skipped = due.length - fresh.length;
  if (!fresh.length) return out;

  const batch = fresh.slice(0, MAX_PER_RUN);
  const nowTs = Date.now();
  for (const ev of batch) {
    const startIso = ev.start?.dateTime || "";
    const start = parseWall(startIso);
    const lead = start ? Math.max(1, Math.round((start.getTime() - now.getTime()) / 60_000)) : minutes;
    try {
      const text = formatUpcoming(ev, lead);
      // เข้ากล่องในแอปด้วย ไม่ใช่ไป LINE ทางเดียว (กล่องยิง push ต่อให้เอง)
      await addNotice(upn, { kind: "meeting", title: "⏰ ใกล้ถึงเวลานัด", body: text }).catch(() => {});
      await sendLine(upn, "⏰ ใกล้ถึงเวลานัด", text);
      seen.set(entryKey(ev.id as string, startIso), nowTs);
      out.notified += 1;
    } catch (e) {
      console.warn(`[meeting-remind] ${upn}:`, String(e).slice(0, 120));
    }
  }
  await saveSeen(upn, [...seen.entries()]);
  return out;
}
