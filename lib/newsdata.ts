// NewsData.io — used for topic/keyword news (server env NEWSDATA_API_KEY only).
import type { FeedEntry } from "@/lib/rss";

const API = "https://newsdata.io/api/1/latest";

export function isNewsDataConfigured(): boolean {
  return !!(process.env.NEWSDATA_API_KEY || "").trim();
}

function apiKey(): string {
  return (process.env.NEWSDATA_API_KEY || "").trim();
}

/** Fetch Thai news matching a free-text / boolean query. */
export async function fetchNewsByTopic(topicQuery: string, limit = 5): Promise<FeedEntry[]> {
  const key = apiKey();
  const q = topicQuery.trim();
  if (!key || !q) return [];

  const params = new URLSearchParams({
    apikey: key,
    q,
    language: (process.env.NEWSDATA_LANGUAGES || "th").trim() || "th",
    size: String(Math.min(10, Math.max(1, limit))),
  });
  const country = (process.env.NEWSDATA_COUNTRIES || "th").trim();
  if (country) params.set("country", country);

  const r = await fetch(`${API}?${params.toString()}`, {
    headers: { Accept: "application/json", "X-ACCESS-KEY": key },
    cache: "no-store",
    signal: AbortSignal.timeout(12000),
  });
  const text = await r.text();
  let data: { status?: string; results?: Record<string, unknown>[]; message?: string };
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`NewsData HTTP ${r.status}`);
  }
  if (!r.ok || (data.status && data.status !== "success")) {
    throw new Error(`NewsData: ${String(data.message || data.status || r.status).slice(0, 120)}`);
  }

  const rows = Array.isArray(data.results) ? data.results : [];
  return rows
    .filter((a) => String(a.title || "").trim() && String(a.link || "").trim())
    .map((a) => {
      const scrub = (s: string) =>
        s
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim();
      const desc = scrub(String(a.description || ""));
      const content = scrub(String(a.content || ""));
      // Prefer the longer snippet so the digest LLM has real substance
      const summary = (content.length >= desc.length ? content : desc || content).slice(0, 2000);
      return {
        title: String(a.title || "").trim(),
        link: String(a.link || "").trim(),
        published: String(a.pubDate || ""),
        summary,
        source: `หัวข้อ · ${String(a.source_name || a.source_id || topicQuery).slice(0, 40)}`,
      };
    });
}
