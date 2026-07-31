// Facebook page posts — Meta does NOT expose "pages the user follows".
// Workable path: user pastes a public page URL; we pull recent posts via Graph
// (app token) when FACEBOOK_APP_ID + FACEBOOK_APP_SECRET are set.
import type { FeedEntry } from "@/lib/rss";

const GRAPH = "https://graph.facebook.com/v21.0";

export function isConfigured(): boolean {
  return !!(process.env.FACEBOOK_APP_ID && process.env.FACEBOOK_APP_SECRET);
}

/** Normalize facebook.com / fb.com page URLs → page id or username slug. */
export function parsePageRef(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  // bare numeric page id
  if (/^\d{5,}$/.test(raw)) return raw;
  try {
    const u = new URL(raw.startsWith("http") ? raw : `https://${raw}`);
    const host = u.hostname.replace(/^www\./, "").toLowerCase();
    if (!["facebook.com", "m.facebook.com", "mbasic.facebook.com", "fb.com", "fb.watch"].includes(host)) {
      return null;
    }
    const parts = u.pathname.split("/").filter(Boolean);
    if (!parts.length) return null;
    // /profile.php?id=123
    if (parts[0] === "profile.php") {
      const id = u.searchParams.get("id");
      return id && /^\d+$/.test(id) ? id : null;
    }
    // /pages/.../Name/123 or /people/.../123
    const last = parts[parts.length - 1];
    if (/^\d{5,}$/.test(last)) return last;
    // skip noise segments
    const skip = new Set(["posts", "about", "photos", "videos", "reels", "live", "watch"]);
    const slug = parts.find((p) => !skip.has(p.toLowerCase()) && !p.startsWith("@"));
    return slug ? decodeURIComponent(slug) : null;
  } catch {
    return null;
  }
}

async function appToken(): Promise<string> {
  const id = process.env.FACEBOOK_APP_ID || "";
  const secret = process.env.FACEBOOK_APP_SECRET || "";
  const r = await fetch(
    `${GRAPH}/oauth/access_token?client_id=${encodeURIComponent(id)}&client_secret=${encodeURIComponent(secret)}&grant_type=client_credentials`
  );
  const d = await r.json();
  if (!r.ok || !d.access_token) throw new Error(d.error?.message || `fb token ${r.status}`);
  return d.access_token as string;
}

/** Resolve page id + name from a URL/slug. */
export async function resolvePage(ref: string): Promise<{ id: string; name: string; link: string } | null> {
  if (!isConfigured()) return null;
  const token = await appToken();
  const key = parsePageRef(ref) || ref.trim();
  // Prefer URL lookup when we have a full URL — Graph ?ids= handles vanity URLs
  const lookup = ref.trim().startsWith("http") ? ref.trim() : key;
  const url = `${GRAPH}/?ids=${encodeURIComponent(lookup)}&fields=id,name,link&access_token=${encodeURIComponent(token)}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error?.message || `fb resolve ${r.status}`);
  const node = d[lookup] || d[key] || Object.values(d).find((v) => v && typeof v === "object" && (v as { id?: string }).id);
  if (!node || (node as { error?: unknown }).error) return null;
  const n = node as { id: string; name?: string; link?: string };
  return { id: n.id, name: n.name || key, link: n.link || `https://www.facebook.com/${n.id}` };
}

type FbPost = {
  id?: string;
  message?: string;
  story?: string;
  created_time?: string;
  permalink_url?: string;
  full_picture?: string;
};

/** Recent public posts from a page (ref = URL, slug, or page id). */
export async function recentPosts(ref: string, limit = 8): Promise<FeedEntry[]> {
  if (!isConfigured()) return [];
  const token = await appToken();
  let pageId = parsePageRef(ref) || ref.trim();
  let pageName = pageId;
  try {
    const resolved = await resolvePage(ref);
    if (resolved) {
      pageId = resolved.id;
      pageName = resolved.name;
    }
  } catch {
    /* use parsed slug */
  }

  const fields = "id,message,story,created_time,permalink_url";
  const url =
    `${GRAPH}/${encodeURIComponent(pageId)}/posts` +
    `?fields=${fields}&limit=${Math.min(limit, 15)}&access_token=${encodeURIComponent(token)}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
  const d = await r.json();
  if (!r.ok) {
    // Common: Page Public Content Access not granted — surface empty, caller skips
    console.warn("facebook posts:", d.error?.message || r.status);
    return [];
  }
  const posts: FbPost[] = d.data || [];
  return posts
    .map((p) => {
      const text = (p.message || p.story || "").trim();
      const title = text.split("\n")[0].slice(0, 120) || `(โพสต์จาก ${pageName})`;
      return {
        title,
        link: p.permalink_url || `https://www.facebook.com/${p.id}`,
        published: p.created_time || "",
        summary: text.slice(0, 800),
        source: pageName,
      } satisfies FeedEntry;
    })
    .filter((e) => e.title);
}
