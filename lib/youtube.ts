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

export interface YtItem { title: string; link: string; published: string; summary: string; source: string; }

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
    prompt: "consent",
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
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`yt ${path} ${res.status}`);
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
        const vid = sn?.resourceId?.videoId;
        items.push({
          title: (sn.title || "").trim(),
          link: vid ? `https://www.youtube.com/watch?v=${vid}` : "",
          published: sn.publishedAt || "",
          summary: (sn.description || "").slice(0, 500),
          source: `YouTube · ${title}`,
        });
      }
    } catch { /* skip a bad channel */ }
  }
  items.sort((a, b) => (b.published || "").localeCompare(a.published || ""));
  return items;
}
