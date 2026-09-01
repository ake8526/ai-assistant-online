// Pause switch for the recurring cron jobs — the "หยุดงานที่วนอยู่" button.
//
// The morning deliveries stop by being marked sent for the day, but the polling
// jobs (calendar watch, meeting summaries, invite nudge) have no such flag: they
// simply run every few minutes forever. When something upstream is broken — an
// exhausted LINE quota, a Graph outage — there was no way to quiet them without
// a redeploy.
//
// State lives in one settings row (_ops/paused_jobs) and always carries an
// expiry, so a pause can never be forgotten: it lapses on its own.
import { getSetting, setSetting } from "@/lib/store";

const OWNER = "_ops";
const KEY = "paused_jobs";

export type PausableJob = "calendar" | "summaries" | "nudge" | "brief" | "news";

/** `traceTitle` must match the job's own trace("receive", …) label — it is how
 *  /monitor/log marks a paused job in the history table it already rendered. */
export const PAUSABLE_JOBS: { key: PausableJob; label: string; traceTitle: string }[] = [
  { key: "calendar", label: "แจ้งนัดใหม่", traceTitle: "cron · แจ้งนัดใหม่" },
  { key: "summaries", label: "สรุปประชุม", traceTitle: "cron · สรุปประชุม" },
  { key: "nudge", label: "เตือนนัดค้างตอบ", traceTitle: "cron · เตือนนัดค้างตอบ" },
  // The catch-up tick retries these every 5 minutes until 20:55, so when the
  // send itself is broken they are the loudest loop of all — 48 failed runs of
  // "สรุปตารางเช้า" in half an hour. They could not be stopped before.
  { key: "brief", label: "สรุปตารางเช้า", traceTitle: "cron · สรุปตารางเช้า" },
  { key: "news", label: "ส่งข่าวเช้า", traceTitle: "cron · ส่งข่าวเช้า" },
];

type PauseState = { jobs: PausableJob[]; until: number };

const BKK_OFFSET_MS = 7 * 60 * 60 * 1000;

/** Midnight tonight, Bangkok — the default end of a pause. */
export function endOfBkkDay(): number {
  const bkk = new Date(Date.now() + BKK_OFFSET_MS);
  bkk.setUTCHours(24, 0, 0, 0);
  return bkk.getTime() - BKK_OFFSET_MS;
}

export async function pauseState(): Promise<PauseState | null> {
  const raw = await getSetting(OWNER, KEY);
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as PauseState;
    if (!Array.isArray(s.jobs) || !s.jobs.length) return null;
    if (!Number.isFinite(s.until) || s.until <= Date.now()) return null; // lapsed
    return s;
  } catch {
    return null;
  }
}

export async function isJobPaused(job: PausableJob): Promise<boolean> {
  const s = await pauseState();
  return !!s?.jobs.includes(job);
}

export async function pauseJobs(jobs: PausableJob[], until = endOfBkkDay()): Promise<PauseState> {
  const state: PauseState = { jobs, until };
  await setSetting(OWNER, KEY, JSON.stringify(state));
  return state;
}

export async function resumeJobs(): Promise<void> {
  await setSetting(OWNER, KEY, "");
}

/* ── สวิตช์เฉพาะ "เอางานจากประชุมมาเพิ่ม" ──────────────────────────────
 *
 * ต่างจาก pauseJobs ข้างบนที่พัก cron ทั้งงาน — อันนั้นทำให้สรุปประชุมไม่ถูกส่ง
 * ด้วย ซึ่งไม่ใช่สิ่งที่ต้องการเมื่อปัญหาอยู่ที่การเขียนงานลงตาราง ไม่ใช่ตัวสรุป
 *
 * ไม่มีวันหมดอายุ เพราะเป็นการสั่งปิดด้วยมือ ไม่ใช่การพักเพราะระบบพัง —
 * เปิดกลับเองแล้วงานจะไหลเข้ามาอีกโดยไม่มีใครรู้ตัว แลกกับต้องโชว์สถานะไว้ที่
 * ตั้งค่า → สถานะระบบ ให้เห็นทุกครั้งว่ายังปิดอยู่ จะได้ไม่ลืม
 */
const MEETING_TASKS_KEY = "meeting_tasks_off";

export type MeetingTasksSwitch = { off: boolean; at?: number; note?: string };

export async function meetingTasksOff(): Promise<MeetingTasksSwitch> {
  const raw = await getSetting(OWNER, MEETING_TASKS_KEY);
  if (!raw) return { off: false };
  try {
    const s = JSON.parse(raw) as MeetingTasksSwitch;
    return { off: !!s.off, at: s.at, note: s.note };
  } catch {
    return { off: false };
  }
}

export async function setMeetingTasksOff(off: boolean, note = ""): Promise<MeetingTasksSwitch> {
  const s: MeetingTasksSwitch = { off, at: Date.now(), note: note.slice(0, 200) };
  await setSetting(OWNER, MEETING_TASKS_KEY, JSON.stringify(s));
  return s;
}
