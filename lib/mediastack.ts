// MediaStack News API — https://mediastack.com/documentation
// Live news from many publishers; summarized later by our LLM digest pipeline.
import type { FeedEntry } from "@/lib/rss";
import { nowWall } from "@/lib/time";

const API = "http://api.mediastack.com/v1/news";

export type MediaStackOpts = {
  accessKey: string;
  /** Comma-separated ISO language codes, e.g. "th,en" */
  languages?: string;
  /** Comma-separated ISO country codes, e.g. "th" */
  countries?: string;
  /** Free-text keywords */
  keywords?: string;
  /** Categories: general,business,entertainment,health,science,sports,technology */
  categories?: string;
  limit?: number;
};

type MsArticle = {
  author?: string | null;
  title?: string | null;
  description?: string | null;
  url?: string | null;
  source?: string | null;
  published_at?: string | null;
  category?: string | null;
  language?: string | null;
  country?: string | null;
};

function todayBkk(): string {
  const w = nowWall();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${w.getUTCFullYear()}-${pad(w.getUTCMonth() + 1)}-${pad(w.getUTCDate())}`;
}

/** Fetch recent news from MediaStack. Prefers today's articles when the plan allows `date`. */
export async function fetchMediaStackNews(opts: MediaStackOpts): Promise<FeedEntry[]> {
  const key = (opts.accessKey || "").trim();
  if (!key) return [];

  const limit = Math.min(100, Math.max(1, opts.limit || 25));
  const params = new URLSearchParams({
    access_key: key,
    limit: String(limit),
    sort: "published_desc",
  });
  if (opts.languages?.trim()) params.set("languages", opts.languages.trim());
  else params.set("languages", "th,en");
  if (opts.countries?.trim()) params.set("countries", opts.countries.trim());
  if (opts.keywords?.trim()) params.set("keywords", opts.keywords.trim());
  if (opts.categories?.trim()) params.set("categories", opts.categories.trim());

  // Paid plans support date=YYYY-MM-DD; free plans may ignore/reject it — try today first.
  const today = todayBkk();
  params.set("date", today);

  let data = await callApi(params);
  if (data.error && /date|upgrade|not available|permission/i.test(JSON.stringify(data.error))) {
    params.delete("date");
    data = await callApi(params);
  }
  if (data.error) {
    throw new Error(formatMsError(data.error));
  }

  const rows: MsArticle[] = Array.isArray(data.data) ? data.data : [];
  return rows
    .filter((a) => (a.title || "").trim() && (a.url || "").trim())
    .map((a) => ({
      title: String(a.title || "").trim(),
      link: String(a.url || "").trim(),
      published: String(a.published_at || ""),
      summary: String(a.description || "").replace(/\s+/g, " ").trim().slice(0, 800),
      source: `MediaStack · ${a.source || a.category || "News"}`,
    }));
}

async function callApi(params: URLSearchParams): Promise<{
  data?: MsArticle[];
  error?: { code?: string | number; message?: string; context?: unknown };
}> {
  const r = await fetch(`${API}?${params.toString()}`, {
    headers: { Accept: "application/json" },
    // MediaStack is http on free docs; follow redirects if any
    next: { revalidate: 0 },
  });
  const text = await r.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`MediaStack HTTP ${r.status}: ${text.slice(0, 120)}`);
  }
}

function formatMsError(err: { code?: string | number; message?: string }): string {
  const msg = err.message || String(err.code || "unknown");
  return `MediaStack: ${msg}`;
}

/** Mask a key for UI display: keep last 4 chars. */
export function maskApiKey(key: string): string {
  const k = key.trim();
  if (!k) return "";
  if (k.length <= 4) return "****";
  return `${"*".repeat(Math.min(12, k.length - 4))}${k.slice(-4)}`;
}
