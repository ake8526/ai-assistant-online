// Per-user news interest preferences (topics + onboarding).
import { clampNewsCount, NEWS_COUNT_DEFAULT } from "@/lib/notify";
import { getSetting, setSetting, deleteSetting } from "@/lib/store";

const K_INTERESTED = "news_interested";
const K_TOPICS = "news_topics";
const K_ONBOARDING = "news_onboarding_done";
const K_DRAFT = "_line_news_onboarding";

export type NewsTopicPreset = { id: string; label: string; query: string };

/** First-time topic chips shown in LINE. */
export const NEWS_TOPIC_PRESETS: NewsTopicPreset[] = [
  { id: "tech", label: "เทคโนโลยี/IT", query: "เทคโนโลยี OR IT OR ไอที" },
  { id: "ai", label: "AI / นวัตกรรม", query: "AI OR ปัญญาประดิษฐ์ OR นวัตกรรม" },
  { id: "business", label: "เศรษฐกิจ/ธุรกิจ", query: "เศรษฐกิจ OR ธุรกิจ OR การลงทุน" },
  { id: "energy", label: "พลังงาน", query: "พลังงาน OR ไฟฟ้า OR น้ำมัน" },
  { id: "auto", label: "ยานยนต์", query: "ยานยนต์ OR รถยนต์ OR EV" },
  { id: "health", label: "สุขภาพ", query: "สุขภาพ OR การแพทย์" },
  { id: "sports", label: "กีฬา", query: "กีฬา" },
  { id: "politics", label: "การเมือง", query: "การเมือง" },
  { id: "entertain", label: "บันเทิง", query: "บันเทิง OR ภาพยนตร์" },
];

export type NewsPrefs = {
  interested: boolean;
  topics: string[];
  count: number;
  onboardingDone: boolean;
};

export type NewsOnboardingDraft = {
  step: "ask" | "topics" | "count" | "manage" | "delete";
  topics: string[];
  ts: number;
};

export async function getNewsPrefs(upn: string): Promise<NewsPrefs> {
  const [interested, topicsRaw, countRaw, done] = await Promise.all([
    getSetting(upn, K_INTERESTED),
    getSetting(upn, K_TOPICS),
    getSetting(upn, "news_count"),
    getSetting(upn, K_ONBOARDING),
  ]);
  let topics: string[] = [];
  try {
    topics = topicsRaw ? (JSON.parse(topicsRaw) as string[]) : [];
    if (!Array.isArray(topics)) topics = [];
  } catch {
    topics = [];
  }
  return {
    interested: interested === null ? true : interested === "1",
    topics: topics.map((t) => String(t).trim()).filter(Boolean).slice(0, 12),
    count: clampNewsCount(countRaw === null ? NEWS_COUNT_DEFAULT : countRaw),
    onboardingDone: done === "1",
  };
}

export async function setNewsInterested(upn: string, yes: boolean): Promise<void> {
  await setSetting(upn, K_INTERESTED, yes ? "1" : "0");
}

export async function setNewsTopics(upn: string, topics: string[]): Promise<void> {
  const clean = Array.from(new Set(topics.map((t) => t.trim()).filter(Boolean))).slice(0, 12);
  await setSetting(upn, K_TOPICS, JSON.stringify(clean));
}

export async function setNewsOnboardingDone(upn: string, done = true): Promise<void> {
  await setSetting(upn, K_ONBOARDING, done ? "1" : "0");
}

export async function resetNewsOnboarding(upn: string): Promise<void> {
  await Promise.all([
    setSetting(upn, K_ONBOARDING, "0"),
    deleteSetting(upn, K_DRAFT),
    deleteSetting(upn, K_TOPICS),
    deleteSetting(upn, K_INTERESTED),
  ]);
}

export async function loadNewsDraft(upn: string): Promise<NewsOnboardingDraft | null> {
  try {
    const raw = await getSetting(upn, K_DRAFT);
    if (!raw) return null;
    const d = JSON.parse(raw) as NewsOnboardingDraft;
    if (!d.ts || Date.now() - d.ts > 60 * 60 * 1000) return null;
    return d;
  } catch {
    return null;
  }
}

export async function saveNewsDraft(upn: string, d: NewsOnboardingDraft): Promise<void> {
  await setSetting(upn, K_DRAFT, JSON.stringify({ ...d, ts: Date.now() }));
}

export async function clearNewsDraft(upn: string): Promise<void> {
  await deleteSetting(upn, K_DRAFT);
}

export function presetById(id: string): NewsTopicPreset | undefined {
  return NEWS_TOPIC_PRESETS.find((p) => p.id === id);
}

/** Resolve stored topic label → NewsData query string. */
export function topicQuery(topic: string): string {
  const preset = NEWS_TOPIC_PRESETS.find((p) => p.label === topic || p.id === topic);
  if (preset) return preset.query;
  return topic.trim();
}
