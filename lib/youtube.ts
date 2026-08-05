// YouTube "following" source — the channels the user subscribes to + their new uploads.
// OAuth (offline) once → we store only the refresh token; access tokens are minted on demand.
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API = "https://www.googleapis.com/youtube/v3";
const USERINFO = "https://www.googleapis.com/oauth2/v3/userinfo";
// youtube.readonly = subscriptions; openid/email/profile = show which Google account is linked
const SCOPE = [
  "https://www.googleapis.com/auth/youtube.readonly",
  "openid",
  "email",
  "profile",
].join(" ");
const MAX_CHANNELS = 25;
const UPLOADS_PER_CHANNEL = 3;
/** Full description from videos.list (playlistItems truncates). */
const DESC_CAP = 4000;
/** Captions / auto-caption text fed into the digest summarizer. */
const CAPTION_CAP = 5000;

export interface YtItem {
  title: string;
  link: string;
  published: string;
  summary: string;
  source: string;
  /** Video id when known — used to pull captions. */
  videoId?: string;
}

export type GoogleAccountInfo = {
  email?: string;
  name?: string;
  channel?: string;
};

export function isConfigured(): boolean {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_OAUTH_REDIRECT);
}

export function buildAuthUrl(state: string): string {
  const p = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID || "",
    redirect_uri: process.env.GOOGLE_OAUTH_REDIRECT || "",
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    prompt: "select_account consent",
    include_granted_scopes: "true",
    state,
  });
  return `${AUTH_URL}?${p.toString()}`;
}

export async function exchangeCode(code: string): Promise<{
  refresh_token?: string;
  access_token?: string;
  scope?: string;
}> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID || "",
      client_secret: process.env.GOOGLE_CLIENT_SECRET || "",
      redirect_uri: process.env.GOOGLE_OAUTH_REDIRECT || "",
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) throw new Error(`token ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function accessToken(refresh: string): Promise<string> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refresh,
      client_id: process.env.GOOGLE_CLIENT_ID || "",
      client_secret: process.env.GOOGLE_CLIENT_SECRET || "",
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) throw new Error(`refresh ${res.status}`);
  return (await res.json()).access_token as string;
}

async function api(path: string, token: string, params: Record<string, string>) {
  const url = `${API}/${path}?${new URLSearchParams(params).toString()}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    let reason = "";
    try {
      const body = await res.json();
      reason = body?.error?.errors?.[0]?.reason || body?.error?.status || "";
    } catch { /* non-JSON body */ }
    throw new Error(`yt ${path} ${res.status}${reason ? ` (${reason})` : ""}`);
  }
  return res.json();
}

/** Resolve which Google / YouTube account a refresh token belongs to. */
export async function getGoogleAccount(refresh: string): Promise<GoogleAccountInfo> {
  const token = await accessToken(refresh);
  return getGoogleAccountFromAccessToken(token);
}

export async function getGoogleAccountFromAccessToken(token: string): Promise<GoogleAccountInfo> {
  const out: GoogleAccountInfo = {};
  try {
    const r = await fetch(USERINFO, { headers: { Authorization: `Bearer ${token}` } });
    if (r.ok) {
      const u = await r.json();
      if (u.email) out.email = String(u.email);
      if (u.name) out.name = String(u.name);
    }
  } catch { /* scope may not include userinfo yet */ }
  try {
    const d = await api("channels", token, { part: "snippet", mine: "true", maxResults: "1" });
    const title = d.items?.[0]?.snippet?.title;
    if (title) out.channel = String(title);
  } catch { /* ignore */ }
  return out;
}

function videoIdFromLink(link: string): string {
  const m = (link || "").match(/[?&]v=([\w-]{6,})/) || (link || "").match(/youtu\.be\/([\w-]{6,})/);
  return m?.[1] || "";
}

/** Pull public / auto captions (Thai preferred, then English). Best-effort — empty if none. */
export async function fetchCaptions(videoId: string): Promise<string> {
  if (!videoId) return "";
  try {
    const listUrl = `https://www.youtube.com/api/timedtext?type=list&v=${encodeURIComponent(videoId)}`;
    const listRes = await fetch(listUrl, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; KTIS-AI/1.0)" },
      signal: AbortSignal.timeout(8000),
    });
    if (!listRes.ok) return "";
    const listXml = await listRes.text();
    const tracks: { lang: string; name: string }[] = [];
    const re = /<track\b[^>]*>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(listXml))) {
      const tag = m[0];
      const lang = (tag.match(/\blang_code="([^"]+)"/i) || [])[1] || "";
      const name = (tag.match(/\bname="([^"]*)"/i) || [])[1] || "";
      if (lang) tracks.push({ lang, name });
    }
    if (!tracks.length) return "";

    const prefer = (a: { lang: string }) => {
      const l = a.lang.toLowerCase();
      if (l === "th" || l.startsWith("th-")) return 0;
      if (l === "en" || l.startsWith("en")) return 1;
      return 2;
    };
    tracks.sort((a, b) => prefer(a) - prefer(b));
    const pick = tracks[0]!;

    const capUrl =
      `https://www.youtube.com/api/timedtext?v=${encodeURIComponent(videoId)}` +
      `&lang=${encodeURIComponent(pick.lang)}&fmt=json3` +
      (pick.name ? `&name=${encodeURIComponent(pick.name)}` : "");
    const capRes = await fetch(capUrl, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; KTIS-AI/1.0)" },
      signal: AbortSignal.timeout(10000),
    });
    if (!capRes.ok) return "";
    const raw = await capRes.text();
    // json3: { events: [{ segs: [{ utf8: "..." }] }] }
    try {
      const data = JSON.parse(raw) as { events?: { segs?: { utf8?: string }[] }[] };
      const parts: string[] = [];
      for (const ev of data.events || []) {
        for (const seg of ev.segs || []) {
          const t = (seg.utf8 || "").replace(/\n/g, " ").trim();
          if (t && t !== "\n") parts.push(t);
        }
      }
      return parts.join(" ").replace(/\s+/g, " ").trim().slice(0, CAPTION_CAP);
    } catch {
      // XML fallback: <text ...>caption</text>
      return raw
        .replace(/<[^>]+>/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&#39;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, CAPTION_CAP);
    }
  } catch {
    return "";
  }
}

/** Merge description + captions into one body for the summarizer. */
export async function buildVideoBody(item: {
  title?: string;
  summary?: string;
  videoId?: string;
  link?: string;
}): Promise<string> {
  const vid = item.videoId || videoIdFromLink(item.link || "");
  const desc = (item.summary || "").trim();
  const caps = vid ? await fetchCaptions(vid) : "";
  const chunks: string[] = [];
  if (desc) chunks.push(`คำบรรยายวิดีโอ:\n${desc}`);
  if (caps) chunks.push(`ถอดเสียง/ซับไตเติล:\n${caps}`);
  if (!chunks.length) return (item.title || "").trim();
  return chunks.join("\n\n").slice(0, DESC_CAP + CAPTION_CAP);
}

/** Fill full descriptions via videos.list (playlistItems often truncates). */
async function enrichDescriptions(token: string, items: YtItem[]): Promise<void> {
  const ids = items.map((it) => it.videoId).filter(Boolean) as string[];
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    try {
      const d = await api("videos", token, { part: "snippet", id: chunk.join(","), maxResults: "50" });
      const byId = new Map<string, string>();
      for (const it of d.items || []) {
        const id = it?.id as string | undefined;
        const desc = (it?.snippet?.description || "").trim();
        if (id && desc) byId.set(id, desc.slice(0, DESC_CAP));
      }
      for (const it of items) {
        if (!it.videoId) continue;
        const full = byId.get(it.videoId);
        if (full && full.length > (it.summary || "").length) it.summary = full;
      }
    } catch { /* keep playlist snippets */ }
  }
}

/** Recent uploads from the user's subscribed channels, normalized like feed items. */
export async function recentUploads(refresh: string): Promise<YtItem[]> {
  const token = await accessToken(refresh);

  // 1) subscribed channel ids
  const channelIds: string[] = [];
  let page: string | undefined;
  while (channelIds.length < MAX_CHANNELS) {
    const d = await api("subscriptions", token, { part: "snippet", mine: "true", maxResults: "50", ...(page ? { pageToken: page } : {}) });
    for (const it of d.items || []) {
      const cid = it?.snippet?.resourceId?.channelId;
      if (cid) channelIds.push(cid);
    }
    page = d.nextPageToken;
    if (!page) break;
  }

  // 2) uploads playlist per channel
  const playlists: { title: string; pl: string }[] = [];
  for (let i = 0; i < channelIds.length; i += 50) {
    const chunk = channelIds.slice(i, i + 50);
    const d = await api("channels", token, { part: "snippet,contentDetails", id: chunk.join(","), maxResults: "50" });
    for (const it of d.items || []) {
      const pl = it?.contentDetails?.relatedPlaylists?.uploads;
      if (pl) playlists.push({ title: it?.snippet?.title || "YouTube", pl });
    }
  }

  // 3) recent videos
  const items: YtItem[] = [];
  for (const { title, pl } of playlists) {
    try {
      const d = await api("playlistItems", token, { part: "snippet", playlistId: pl, maxResults: String(UPLOADS_PER_CHANNEL) });
      for (const it of d.items || []) {
        const sn = it.snippet || {};
        const vid = sn?.resourceId?.videoId as string | undefined;
        items.push({
          title: (sn.title || "").trim(),
          link: vid ? `https://www.youtube.com/watch?v=${vid}` : "",
          published: sn.publishedAt || "",
          summary: (sn.description || "").slice(0, DESC_CAP),
          source: `YouTube · ${title}`,
          videoId: vid || undefined,
        });
      }
    } catch { /* skip a bad channel */ }
  }
  items.sort((a, b) => (b.published || "").localeCompare(a.published || ""));

  // 4) full descriptions (playlistItems truncates aggressively)
  await enrichDescriptions(token, items);
  return items;
}
