import Parser from "rss-parser";

const parser = new Parser({
  timeout: 15000,
  headers: { "User-Agent": "KTIS-AI-Assistant/1.0 (+following-digest)" },
});

export interface FeedEntry {
  title: string;
  link: string;
  published: string; // ISO or ""
  summary: string;
  source: string;
}

export async function fetchFeed(url: string): Promise<FeedEntry[]> {
  try {
    const feed = await parser.parseURL(url);
    const source = feed.title || url;
    return (feed.items || []).map((it) => ({
      title: (it.title || "").trim(),
      link: (it.link || "").trim(),
      published: it.isoDate || it.pubDate || "",
      summary: (it.contentSnippet || it.content || (it as { summary?: string }).summary || "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 2000),
      source,
    }));
  } catch {
    return [];
  }
}

/** Fetch an article page and return readable plain text (best-effort). */
export async function fetchArticle(url: string): Promise<string> {
  if (!url.startsWith("http")) return "";
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; KTIS-AI/1.0)" },
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) return "";
    let html = await r.text();
    html = html.replace(/<(script|style|noscript|template|svg|header|footer|nav|aside)[^>]*>[\s\S]*?<\/\1>/gi, " ");
    const m = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
    const body = m ? m[1] : html;
    return body
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&[a-z#0-9]+;/gi, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 6000);
  } catch {
    return "";
  }
}
