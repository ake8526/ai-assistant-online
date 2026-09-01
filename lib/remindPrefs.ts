/** Per-user reminder prefs stored in settings (string values). */

import { getSetting, setSetting } from "@/lib/store";

const MEETING_MIN_KEY = "meeting_remind_minutes";
const TASK_DAYS_KEY = "task_remind_ahead_days";

/** Default 15 minutes before; 0 = off. */
export async function getMeetingRemindMinutes(upn: string): Promise<number> {
  const raw = await getSetting(upn, MEETING_MIN_KEY);
  if (raw == null || raw === "") return 15;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.min(n, 180) : 15;
}

export async function setMeetingRemindMinutes(upn: string, minutes: number): Promise<void> {
  await setSetting(upn, MEETING_MIN_KEY, String(Math.max(0, Math.min(180, Math.round(minutes)))));
}

/** Default 1 day ahead; 0 = off. */
export async function getTaskRemindAheadDays(upn: string): Promise<number> {
  const raw = await getSetting(upn, TASK_DAYS_KEY);
  if (raw == null || raw === "") return 1;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.min(n, 14) : 1;
}

export async function setTaskRemindAheadDays(upn: string, days: number): Promise<void> {
  await setSetting(upn, TASK_DAYS_KEY, String(Math.max(0, Math.min(14, Math.round(days)))));
}
