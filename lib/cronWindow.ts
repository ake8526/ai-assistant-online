// When may the scheduled jobs run at all?
//
// The rule the owner asked for, three times, in his own words: past 30 minutes
// from the time that was set, the scheduled work should stop — not slow down,
// stop — and start again on the next round it was given a time for.
//
// It used to apply to the morning delivery only, because the polling jobs (new
// appointments, meeting summaries, unanswered invites) have no time of their own
// to be late for: they simply ran every five minutes until 20:55. That is what
// kept the monitor busy all day, and it is what this closes. Outside the window
// they do not run, log, or cost anything, and the assistant still answers
// anything asked of it in chat — replies were never on this schedule.
//
// The window is derived from the times people actually set, so it follows them:
//   earliest set time − 30 min  …  latest set time + 30 min
// With 06:00 and 07:00 configured that is 05:30–07:30. An ops override is
// available for a day that needs a wider one, without a deploy:
//   settings(_ops, cron_window) = "05:30-20:55"
import { admin } from "@/lib/supabaseServer";
import { getSetting } from "@/lib/store";
import { NOTIFY_LATE_CUTOFF_MIN, bkkNowParts } from "@/lib/notify";

/** Minutes before the earliest set time that the prewarm needs. */
const LEAD_MIN = 30;
/** Used when nobody has set a time yet (a fresh deployment). */
const FALLBACK = { from: 5 * 60 + 30, to: 8 * 60 + 30 };

export type CronWindow = { from: number; to: number; source: string };

const hhmmToMin = (s: string): number | null => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const mi = parseInt(m[2], 10);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
};

const fmt = (min: number) =>
  `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

/** The window for today, in Bangkok minutes-of-day. */
export async function cronWindow(): Promise<CronWindow> {
  // 1) explicit override, e.g. "05:30-20:55"
  try {
    const raw = (await getSetting("_ops", "cron_window")) || "";
    const [a, b] = raw.split("-");
    const from = a ? hhmmToMin(a) : null;
    const to = b ? hhmmToMin(b) : null;
    if (from !== null && to !== null && to > from) {
      return { from, to, source: `ตั้งไว้เอง ${fmt(from)}–${fmt(to)}` };
    }
  } catch {
    /* fall through to the derived window */
  }

  // 2) derived from the times people set for their morning
  try {
    const { data } = await admin
      .from("settings")
      .select("value")
      .in("key", ["news_time", "brief_time"]);
    const mins = (data || [])
      .map((r) => hhmmToMin(String(r.value || "")))
      .filter((m): m is number => m !== null);
    if (mins.length) {
      const from = Math.max(0, Math.min(...mins) - LEAD_MIN);
      const to = Math.min(24 * 60 - 1, Math.max(...mins) + NOTIFY_LATE_CUTOFF_MIN);
      return { from, to, source: `จากเวลาที่ผู้ใช้ตั้ง ${fmt(from)}–${fmt(to)}` };
    }
  } catch {
    /* fall through to the fallback */
  }

  return { ...FALLBACK, source: `ค่าเริ่มต้น ${fmt(FALLBACK.from)}–${fmt(FALLBACK.to)}` };
}

/**
 * May the scheduled jobs run right now? Returns null when they may, or a short
 * reason to skip when they may not — shaped for a route to hand straight back.
 */
export async function outsideCronWindow(): Promise<string | null> {
  let win: CronWindow;
  try {
    win = await cronWindow();
  } catch {
    return null; // never let this check be the reason work stops silently
  }
  const at = bkkNowParts();
  if (at.min >= win.from && at.min <= win.to) return null;
  return `outside window (${fmt(win.from)}–${fmt(win.to)}, now ${fmt(at.min)})`;
}
