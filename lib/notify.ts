// Per-user schedule for the proactive LINE notifications (morning brief + news
// digest). Times/days are stored in the `settings` table; a frequent cron hits
// the delivery endpoints and each one checks whether "now" (Bangkok wall-clock)
// is due for each user, sending at most once per day per kind.
import { getSetting, getSettingsFor, setSetting } from "@/lib/store";
import { nowWall } from "@/lib/time";

export type NotifyKind = "brief" | "news";

export const NOTIFY_DEFAULTS: Record<NotifyKind, { enabled: boolean; time: string; days: number[] }> = {
  // days: 0=Sun … 6=Sat — news first, brief one minute later (its quick-reply
  // number buttons must sit on the newest message). The times are the times the
  // message must ARRIVE, not when work starts: /api/morning/prewarm builds both
  // payloads before 07:00 so these ticks are pure pushes.
  brief: { enabled: true, time: "07:01", days: [1, 2, 3, 4, 5] },        // จ–ศ · ข่าว + 1 นาที
  news: { enabled: true, time: "07:00", days: [1, 2, 3, 4, 5] },         // จ–ศ
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
  if (s === null || s === undefined || !String(s).trim()) return def;
  const raw = String(s).split(",").map((x) => parseInt(x.trim(), 10)).filter((n) => !isNaN(n) && n >= 0 && n <= 6);
  return raw.length ? Array.from(new Set(raw)).sort((a, b) => a - b) : def;
}

function validTime(s: string | null, def: string): string {
  return s && /^\d{1,2}:\d{2}$/.test(s) ? s.padStart(5, "0") : def;
}

/** Every settings key the schedule depends on — fetched in one query. */
export const NOTIFY_SETTING_KEYS = [
  "brief_enabled",
  "brief_time",
  "brief_days",
  "news_enabled",
  "news_time",
  "news_days",
  "news_count",
];

function addOneMinute(t: string): string {
  const [hh, mm] = t.split(":").map((x) => parseInt(x, 10));
  const total = (hh || 0) * 60 + (mm || 0) + 1;
  if (total >= 24 * 60) return t; // no wrap past midnight — leave it alone
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}

/** Resolve one user's schedule from their settings rows (defaults fill the gaps). */
export function notifyConfigFromSettings(rows: Record<string, string>): NotifyConfig {
  const kind = (k: NotifyKind): KindConfig => {
    const d = NOTIFY_DEFAULTS[k];
    const en = rows[`${k}_enabled`] ?? null;
    return {
      enabled: en === null ? d.enabled : en === "1",
      time: validTime(rows[`${k}_time`] ?? null, d.time),
      days: parseDays(rows[`${k}_days`] ?? null, d.days),
    };
  };
  const brief = kind("brief");
  const news = kind("news");
  news.count = clampNewsCount(rows.news_count ?? NEWS_COUNT_DEFAULT);
  // The agenda must land AFTER the news — its quick-reply numbers belong on the
  // newest message. Users (and the settings UI) often store the same minute for
  // both; shift the agenda by a minute rather than letting them race.
  if (brief.time === news.time && news.enabled) brief.time = addOneMinute(news.time);
  return { brief, news };
}

export async function getNotifyConfig(upn: string): Promise<NotifyConfig> {
  const rows = (await getSettingsFor([upn], NOTIFY_SETTING_KEYS))[upn] || {};
  return notifyConfigFromSettings(rows);
}

/** Bangkok wall-clock parts used by every schedule decision. */
export function bkkNowParts(): { min: number; day: number; date: string } {
  return bkkNow();
}

/** Minutes from now until `time` (HH:MM) today in Bangkok — negative once passed. */
export function minutesUntil(time: string): number {
  const [hh, mm] = time.split(":").map((x) => parseInt(x, 10));
  return (hh || 0) * 60 + (mm || 0) - bkkNow().min;
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

/** No early sending. The set time is the time the message must ARRIVE, and the
 *  Cloudflare Worker polls every minute (cloudflare/src/worker.js), so there is
 *  nothing to compensate for. Keep at 0 — any slack here makes a 06:5x poll
 *  deliver before the user's time. */
export const NOTIFY_EARLY_SLACK_MIN = 0;

/** Minimum gap between the news push and the agenda push. Small on purpose: the
 *  1-minute spacing comes from brief.time = news.time + 1, this only stops the
 *  two landing in the same second when a late catch-up run sends both at once. */
const NEWS_MIN_GAP_MS = 20_000;

/** If news has still not gone out this long after the brief's own time, send the
 *  agenda anyway — a broken digest must never starve the calendar. */
const NEWS_WAIT_GRACE_MIN = 15;

/** `*_last_sent` holds a Bangkok timestamp ("2026-08-13T07:00:01+07:00"); older
 *  rows hold a bare date. Both start with the date, so this reads either. */
function sentDate(raw: string | null): string {
  return (raw || "").slice(0, 10);
}

/** Has `kind` already gone out today (Bangkok date)? */
export async function alreadySentToday(upn: string, kind: NotifyKind): Promise<boolean> {
  const raw = await getSetting(upn, `${kind}_last_sent`);
  return sentDate(raw) === bkkNow().date;
}

/** Everything a due-check needs: the schedule plus when each kind last went out. */
export const NOTIFY_STATE_KEYS = [...NOTIFY_SETTING_KEYS, "news_last_sent", "brief_last_sent"];

/** Keep the agenda behind the news: same-day ordering + the minimum gap. */
function briefMustWaitForNews(
  rows: Record<string, string>,
  news: KindConfig,
  at: { min: number; day: number; date: string },
  briefDueMin: number
): boolean {
  if (!news.enabled || !news.days.includes(at.day)) return false; // no news today — nothing to wait for
  if (at.min >= briefDueMin + NEWS_WAIT_GRACE_MIN) return false; // grace expired — don't starve the agenda
  const raw = rows.news_last_sent ?? null;
  if (sentDate(raw) !== at.date) return true; // news not out yet today
  const t = Date.parse(raw || "");
  if (!Number.isFinite(t)) return false; // legacy date-only row carries no time
  return Date.now() - t < NEWS_MIN_GAP_MS;
}

/** Due-check with no I/O — `rows` must cover NOTIFY_STATE_KEYS.
 *  Due when Bangkok wall-clock has reached the user's set time (HH:MM) and the
 *  kind has not gone out today. The Worker polls every minute, so "due" normally
 *  turns true on the exact minute; a late catch-up still delivers the day. */
export function isDueFromState(rows: Record<string, string>, kind: NotifyKind): boolean {
  const all = notifyConfigFromSettings(rows);
  const cfg = all[kind];
  if (!cfg.enabled || !cfg.days.length) return false;
  const at = bkkNow();
  if (!cfg.days.includes(at.day)) return false;
  const [hh, mm] = cfg.time.split(":").map((x) => parseInt(x, 10));
  const dueMin = (hh || 0) * 60 + (mm || 0);
  if (at.min < dueMin - NOTIFY_EARLY_SLACK_MIN) return false;
  if (sentDate(rows[`${kind}_last_sent`] ?? null) === at.date) return false; // once per day
  if (kind === "brief" && briefMustWaitForNews(rows, all.news, at, dueMin)) return false;
  return true;
}

export async function isDueNow(upn: string, kind: NotifyKind): Promise<boolean> {
  const rows = (await getSettingsFor([upn], NOTIFY_STATE_KEYS))[upn] || {};
  return isDueFromState(rows, kind);
}

/** Who is due right now, for both kinds, in ONE query. The morning tick runs
 *  every minute and almost always finds nobody due — doing that with a handful
 *  of reads per user per kind cost seconds, which the 07:00 target cannot spare. */
export async function dueNowForUsers(
  upns: string[]
): Promise<Record<string, { news: boolean; brief: boolean }>> {
  const rows = await getSettingsFor(upns, NOTIFY_STATE_KEYS);
  const out: Record<string, { news: boolean; brief: boolean }> = {};
  for (const upn of upns) {
    const r = rows[upn] || {};
    out[upn] = { news: isDueFromState(r, "news"), brief: isDueFromState(r, "brief") };
  }
  return out;
}

const INFLIGHT_TTL_MS = 6 * 60_000;

/** Claim exclusive delivery for today so overlapping Vercel + GitHub crons
 *  don't double-build. Returns false if already sent or another worker holds the lock. */
export async function claimSend(upn: string, kind: NotifyKind): Promise<boolean> {
  if (!(await isDueNow(upn, kind))) return false;
  const key = `${kind}_inflight`;
  const lock = await getSetting(upn, key);
  const now = Date.now();
  if (lock) {
    const t = parseInt(lock, 10);
    if (Number.isFinite(t) && now - t < INFLIGHT_TTL_MS) return false;
  }
  await setSetting(upn, key, String(now));
  // Re-check after write (cheap race guard)
  const last = await getSetting(upn, `${kind}_last_sent`);
  if (sentDate(last) === bkkNow().date) return false;
  return true;
}

export async function clearInflight(upn: string, kind: NotifyKind): Promise<void> {
  await setSetting(upn, `${kind}_inflight`, "");
}

/** Bangkok wall-clock stamp, e.g. "2026-08-13T07:00:01+07:00". Parses to the
 *  right instant AND starts with the Bangkok date, so both the once-per-day
 *  check and the news→brief gap can read one value. */
function bkkStamp(): string {
  const w = nowWall();
  const pad = (n: number) => String(n).padStart(2, "0");
  const d = `${w.getUTCFullYear()}-${pad(w.getUTCMonth() + 1)}-${pad(w.getUTCDate())}`;
  const t = `${pad(w.getUTCHours())}:${pad(w.getUTCMinutes())}:${pad(w.getUTCSeconds())}`;
  return `${d}T${t}+07:00`;
}

/** Record a successful send so we don't send `kind` again today. Stores the
 *  actual delivery time — used by the news→brief gap and by the punctuality
 *  check in docs/morning-delivery-plan.md. */
export async function markSent(upn: string, kind: NotifyKind): Promise<void> {
  await setSetting(upn, `${kind}_last_sent`, bkkStamp());
  await clearInflight(upn, kind);
}
