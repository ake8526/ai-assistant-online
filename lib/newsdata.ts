// NewsData.io News API — https://newsdata.io/documentation
// Supports Thai (language=th). Summarized later by our LLM digest pipeline.
import type { FeedEntry } from "@/lib/rss";

const API = "https://newsdata.io/api/1/latest";

export type NewsDataOpts = {
  accessKey: string;
  /** Comma-separated ISO language codes, e.g. "th" or "th,en" (max 5) */
  languages?: string;
  /** Comma-separated ISO country codes, e.g. "th" */
  countries?: string;
  /** Free-text query */
  keywords?: string;
  /** Categories e.g. business,technology,politics */
  categories?: string;
  /** Free plan typically max 10 */
  limit?: number;
};

type NdArticle = {
  article_id?: string;
  title?: string | null;
  link?: string | null;
  description?: string | null;
  content?: string | null;
  pubDate?: string | null;
  pubDateTZ?: string | null;
  source_id?: string | null;
  source_name?: string | null;
  category?: string[] | string | null;
  language?: string | null;
  country?: string[] | string | null;
};

/** Fetch latest news from NewsData.io (Thai-friendly via language=th). */
export async function fetchNewsDataNews(opts: NewsDataOpts): Promise<FeedEntry[]> {
  const key = (opts.accessKey || "").trim();
  if (!key) return [];

  const limit = Math.min(10, Math.max(1, opts.limit || 10));
  const params = new URLSearchParams({
    apikey: key,
    size: String(limit),
  });

  const languages = (opts.languages || "th").trim() || "th";
  params.set("language", languages.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 5).join(","));

  if (opts.countries?.trim()) {
    params.set(
      "country",
      opts.countries
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 5)
        .join(",")
    );
  }
  if (opts.keywords?.trim()) params.set("q", opts.keywords.trim());
  if (opts.categories?.trim()) {
    params.set(
      "category",
      opts.categories
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 5)
        .join(",")
    );
  }

  const r = await fetch(`${API}?${params.toString()}`, {
    headers: { Accept: "application/json", "X-ACCESS-KEY": key },
    cache: "no-store",
  });
  const text = await r.text();
  let data: {
    status?: string;
    results?: NdArticle[];
    message?: string;
    resultsError?: unknown;
  };
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`NewsData HTTP ${r.status}: ${text.slice(0, 120)}`);
  }

  if (!r.ok || (data.status && data.status !== "success")) {
    const msg = data.message || data.status || `HTTP ${r.status}`;
    throw new Error(`NewsData: ${String(msg).slice(0, 150)}`);
  }

  const rows = Array.isArray(data.results) ? data.results : [];
  return rows
    .filter((a) => (a.title || "").trim() && (a.link || "").trim())
    .map((a) => ({
      title: String(a.title || "").trim(),
      link: String(a.link || "").trim(),
      published: String(a.pubDate || ""),
      summary: String(a.description || a.content || "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 800),
      source: `NewsData · ${a.source_name || a.source_id || "News"}`,
    }));
}

/** Mask a key for UI display: keep last 4 chars. */
export function maskApiKey(key: string): string {
  const k = key.trim();
  if (!k) return "";
  if (k.length <= 4) return "****";
  return `${"*".repeat(Math.min(12, k.length - 4))}${k.slice(-4)}`;
}
