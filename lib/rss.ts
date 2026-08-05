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
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "th,en;q=0.8",
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) return "";
    let html = await r.text();

    // Prefer og:description / meta description as a clean lead when body scrape is noisy.
    const metaBits: string[] = [];
    const og = html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i)
      || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:description["']/i);
    const md = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)
      || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i);
    if (og?.[1]) metaBits.push(og[1]);
    if (md?.[1] && md[1] !== og?.[1]) metaBits.push(md[1]);

    html = html.replace(/<(script|style|noscript|template|svg|header|footer|nav|aside)[^>]*>[\s\S]*?<\/\1>/gi, " ");
    const m = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i)
      || html.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
    const body = m ? m[1] : html;
    const text = body
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&[a-z#0-9]+;/gi, " ")
      .replace(/\s+/g, " ")
      .trim();

    const lead = metaBits.join(" ").replace(/\s+/g, " ").trim();
    if (lead && text.length < 400) return `${lead} ${text}`.trim().slice(0, 8000);
    if (lead && !text.includes(lead.slice(0, Math.min(40, lead.length)))) {
      return `${lead}\n\n${text}`.trim().slice(0, 8000);
    }
    return text.slice(0, 8000);
  } catch {
    return "";
  }
}
