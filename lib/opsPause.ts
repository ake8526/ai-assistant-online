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

export type PausableJob = "calendar" | "summaries" | "nudge";

export const PAUSABLE_JOBS: { key: PausableJob; label: string }[] = [
  { key: "calendar", label: "แจ้งนัดใหม่" },
  { key: "summaries", label: "สรุปประชุม" },
  { key: "nudge", label: "เตือนนัดค้างตอบ" },
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
