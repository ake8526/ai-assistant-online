// Pre-built morning payloads, so 07:00 delivery is a PUSH and nothing else.
//
// Why: building the news digest takes ~100s (NewsData → อ่านบทความ → LLM ต่อเรื่อง).
// A cron that fires at 07:00 and *then* builds can never land at 07:00. So the
// Cloudflare Worker (see cloudflare/) calls /api/morning/prewarm at 06:50/06:53/
// 06:56 for news and 06:59 for the agenda; the 07:00 / 07:01 ticks only read
// what is cached here and push it to LINE.
//
// Cache lives in the `settings` table (one row per upn+key), is scoped to today's
// Bangkok date, and is cleared as soon as it is delivered so a retry never
// re-sends stale content. See docs/morning-delivery-plan.md.
import type { AgendaChoice, MorningAgenda } from "@/lib/brief";
import type { DigestResult, Story } from "@/lib/digest";
import { deleteSetting, getSetting, setSetting } from "@/lib/store";
import { nowWall } from "@/lib/time";

const NEWS_KEY = "prewarm_news";
const BRIEF_KEY = "prewarm_brief";

/** Don't push a payload built absurdly long ago (e.g. a manual prewarm at dawn). */
const MAX_AGE_MS = 90 * 60_000;

function bkkDate(): string {
  const w = nowWall();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${w.getUTCFullYear()}-${pad(w.getUTCMonth() + 1)}-${pad(w.getUTCDate())}`;
}

type Envelope = { date: string; ts: number };
type NewsCache = Envelope & { stories: Story[]; skipped: string[]; note?: string };
type BriefCache = Envelope & { text: string; choices: AgendaChoice[]; eventCount: number };

function readFresh<T extends Envelope>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as T;
    if (!v || v.date !== bkkDate()) return null;
    if (!Number.isFinite(v.ts) || Date.now() - v.ts > MAX_AGE_MS) return null;
    return v;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// News digest
// ---------------------------------------------------------------------------

export async function saveNewsPrewarm(upn: string, d: DigestResult): Promise<void> {
  const payload: NewsCache = {
    date: bkkDate(),
    ts: Date.now(),
    stories: d.stories || [],
    skipped: d.skipped || [],
    note: d.note,
  };
  await setSetting(upn, NEWS_KEY, JSON.stringify(payload));
}

export async function loadNewsPrewarm(upn: string): Promise<DigestResult | null> {
  const v = readFresh<NewsCache>(await getSetting(upn, NEWS_KEY));
  if (!v) return null;
  return { stories: v.stories || [], skipped: v.skipped || [], note: v.note };
}

export async function hasFreshNewsPrewarm(upn: string): Promise<boolean> {
  return (await loadNewsPrewarm(upn)) !== null;
}

export async function clearNewsPrewarm(upn: string): Promise<void> {
  try {
    await deleteSetting(upn, NEWS_KEY);
  } catch {
    /* delivery already happened — a stale cache row is harmless (date-scoped) */
  }
}

// ---------------------------------------------------------------------------
// Morning agenda (สรุปตารางเช้า)
// ---------------------------------------------------------------------------

export async function saveBriefPrewarm(upn: string, agenda: MorningAgenda): Promise<void> {
  const payload: BriefCache = {
    date: bkkDate(),
    ts: Date.now(),
    text: agenda.text,
    choices: agenda.choices || [],
    eventCount: agenda.events?.length || 0,
  };
  await setSetting(upn, BRIEF_KEY, JSON.stringify(payload));
}

/** Agenda ready to send. `events` is intentionally empty — the full snapshot
 *  lives in the agenda store (saveAgendaIds) that prep buttons already use. */
export async function loadBriefPrewarm(
  upn: string
): Promise<{ agenda: MorningAgenda; eventCount: number } | null> {
  const v = readFresh<BriefCache>(await getSetting(upn, BRIEF_KEY));
  if (!v) return null;
  return {
    agenda: { text: v.text, events: [], choices: v.choices || [] },
    eventCount: v.eventCount || 0,
  };
}

export async function clearBriefPrewarm(upn: string): Promise<void> {
  try {
    await deleteSetting(upn, BRIEF_KEY);
  } catch {
    /* see clearNewsPrewarm */
  }
}
