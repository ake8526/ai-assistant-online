// Per-user schedule for the proactive LINE notifications (morning brief + news
// digest). Times/days are stored in the `settings` table; a frequent cron hits
// the delivery endpoints and each one checks whether "now" (Bangkok wall-clock)
// is due for each user, sending at most once per day per kind.
import { getSetting, setSetting } from "@/lib/store";
import { nowWall } from "@/lib/time";

export type NotifyKind = "brief" | "news";

export const NOTIFY_DEFAULTS: Record<NotifyKind, { enabled: boolean; time: string; days: number[] }> = {
  // days: 0=Sun … 6=Sat — same default time; cron sends news then brief
  brief: { enabled: true, time: "07:00", days: [1, 2, 3, 4, 5] },        // จ–ศ
  news: { enabled: true, time: "07:00", days: [1, 2, 3, 4, 5] },         // จ–ศ เวลาเดียวกับบรีฟ
};

export type KindConfig = { enabled: boolean; time: string; days: number[]; count?: number };
export type NotifyConfig = { brief: KindConfig; news: KindConfig };

/** How many news stories to deliver per day (RSS/YouTube/Facebook digest). Default 3.
 *  0 = "all" — every story published/updated today (Bangkok day), up to NEWS_COUNT_ALL_CAP. */
export const NEWS_COUNT_DEFAULT = 3;
export const NEWS_COUNT_MIN = 1;
export const NEWS_COUNT_MAX = 10;
export const NEWS_COUNT_ALL = 0;
export const NEWS_COUNT_ALL_CAP = 20; // safety cap when "all" is selected (LLM + LINE length)

export function clampNewsCount(n: unknown): number {
  if (n === "all" || n === "ALL") return NEWS_COUNT_ALL;
  const v = typeof n === "number" ? n : parseInt(String(n ?? ""), 10);
  if (!Number.isFinite(v)) return NEWS_COUNT_DEFAULT;
  if (v === NEWS_COUNT_ALL) return NEWS_COUNT_ALL;
  return Math.min(NEWS_COUNT_MAX, Math.max(NEWS_COUNT_MIN, Math.round(v)));
}

export function isNewsCountAll(n: number): boolean {
  return n === NEWS_COUNT_ALL;
}

function parseDays(s: string | null, def: number[]): number[] {
  if (s === null || s === undefined) return def;
  const raw = s.split(",").map((x) => parseInt(x.trim(), 10)).filter((n) => !isNaN(n) && n >= 0 && n <= 6);
  return raw.length ? Array.from(new Set(raw)).sort((a, b) => a - b) : [];
}

function validTime(s: string | null, def: string): string {
  return s && /^\d{1,2}:\d{2}$/.test(s) ? s.padStart(5, "0") : def;
}

async function kindConfig(upn: string, kind: NotifyKind): Promise<KindConfig> {
  const d = NOTIFY_DEFAULTS[kind];
  const [en, time, days] = await Promise.all([
    getSetting(upn, `${kind}_enabled`),
    getSetting(upn, `${kind}_time`),
    getSetting(upn, `${kind}_days`),
  ]);
  return {
    enabled: en === null ? d.enabled : en === "1",
    time: validTime(time, d.time),
    days: parseDays(days, d.days),
  };
}

export async function getNotifyConfig(upn: string): Promise<NotifyConfig> {
  const [brief, news, countRaw] = await Promise.all([
    kindConfig(upn, "brief"),
    kindConfig(upn, "news"),
    getSetting(upn, "news_count"),
  ]);
  news.count = clampNewsCount(countRaw === null ? NEWS_COUNT_DEFAULT : countRaw);
  return { brief, news };
}

export async function saveNotifyKind(upn: string, kind: NotifyKind, cfg: Partial<KindConfig>): Promise<void> {
  if (typeof cfg.enabled === "boolean") await setSetting(upn, `${kind}_enabled`, cfg.enabled ? "1" : "0");
  if (typeof cfg.time === "string") await setSetting(upn, `${kind}_time`, validTime(cfg.time, NOTIFY_DEFAULTS[kind].time));
  if (Array.isArray(cfg.days)) {
    const days = cfg.days.filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);
    await setSetting(upn, `${kind}_days`, Array.from(new Set(days)).sort((a, b) => a - b).join(","));
  }
  if (kind === "news" && cfg.count !== undefined) {
    await setSetting(upn, "news_count", String(clampNewsCount(cfg.count)));
  }
}

export async function getNewsCount(upn: string): Promise<number> {
  const raw = await getSetting(upn, "news_count");
  return clampNewsCount(raw === null ? NEWS_COUNT_DEFAULT : raw);
}

function bkkNow(): { min: number; day: number; date: string } {
  const w = nowWall(); // UTC fields carry Bangkok local components
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    min: w.getUTCHours() * 60 + w.getUTCMinutes(),
    day: w.getUTCDay(),
    date: `${w.getUTCFullYear()}-${pad(w.getUTCMonth() + 1)}-${pad(w.getUTCDate())}`,
  };
}

/** Is it time to send `kind` to this user right now, and not already sent today? */
export async function isDueNow(upn: string, kind: NotifyKind): Promise<boolean> {
  const cfg = (await getNotifyConfig(upn))[kind];
  if (!cfg.enabled || !cfg.days.length) return false;
  const { min, day, date } = bkkNow();
  if (!cfg.days.includes(day)) return false;
  const [hh, mm] = cfg.time.split(":").map((x) => parseInt(x, 10));
  if (min < (hh || 0) * 60 + (mm || 0)) return false; // not yet time today
  const last = await getSetting(upn, `${kind}_last_sent`);
  return last !== date; // once per day
}

/** Record a successful send so we don't send `kind` again today. */
export async function markSent(upn: string, kind: NotifyKind): Promise<void> {
  await setSetting(upn, `${kind}_last_sent`, bkkNow().date);
}
