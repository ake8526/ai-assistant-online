// Microsoft Graph client.
// - Background/cron: app-only (client credentials) via GRAPH_CLIENT_* env.
// - Interactive (chat/LINE): when a delegated user token is in graphAuth ALS,
//   calls run as that user so calendar visibility matches Microsoft 365 /
//   Outlook sharing & free-busy permissions.
import { getUserGraphToken } from "@/lib/graphAuth";
import { trace } from "@/lib/trace";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

export const TIMEZONE = process.env.TIMEZONE || "Asia/Bangkok";

function tenantId(): string {
  return process.env.TENANT_ID || process.env.NEXT_PUBLIC_AZURE_TENANT_ID || "";
}

// ---------------------------------------------------------------------------
// Token (client credentials) — cached until near expiry
// ---------------------------------------------------------------------------
let tokenCache: { value: string; expiresAt: number } | null = null;

export async function getToken(): Promise<string> {
  const now = Date.now();
  if (tokenCache && tokenCache.expiresAt > now + 5 * 60_000) return tokenCache.value;

  const clientId = process.env.GRAPH_CLIENT_ID || "";
  const clientSecret = process.env.GRAPH_CLIENT_SECRET || "";
  if (!tenantId() || !clientId || !clientSecret) {
    throw new Error("Graph not configured: set TENANT_ID, GRAPH_CLIENT_ID, GRAPH_CLIENT_SECRET");
  }

  const res = await fetch(`https://login.microsoftonline.com/${tenantId()}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      scope: "https://graph.microsoft.com/.default",
      grant_type: "client_credentials",
    }),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error(`Graph token error: ${data.error} - ${String(data.error_description).slice(0, 200)}`);
  }
  tokenCache = { value: data.access_token, expiresAt: now + (data.expires_in || 3600) * 1000 };
  return data.access_token;
}

async function authHeader(): Promise<string> {
  const user = getUserGraphToken();
  return `Bearer ${user || (await getToken())}`;
}

async function graphFetch(
  path: string,
  opts: { method?: string; params?: Record<string, string>; headers?: Record<string, string>; body?: unknown } = {}
): Promise<Response> {
  const url = new URL(path.startsWith("http") ? path : GRAPH_BASE + path);
  for (const [k, v] of Object.entries(opts.params || {})) url.searchParams.set(k, v);
  // Monitor: one "fetch" stage per M365 call. Redact the mailbox address from the
  // path so no PII lands in the trace label — resource name only.
  trace("fetch", `M365 ${opts.method || "GET"} ${url.pathname.replace(/\/users\/[^/]+/, "/users/…")}`);
  return fetch(url, {
    method: opts.method || "GET",
    headers: {
      Authorization: await authHeader(),
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
}

async function graphGet(path: string, params?: Record<string, string>, headers?: Record<string, string>) {
  const r = await graphFetch(path, { params, headers });
  if (!r.ok) throw new Error(`Graph ${r.status} ${path}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------
export type GraphEvent = {
  id?: string;
  subject?: string;
  start?: { dateTime: string; timeZone: string };
  end?: { dateTime: string; timeZone: string };
  location?: { displayName?: string };
  attendees?: { emailAddress?: { name?: string; address?: string }; type?: string }[];
  onlineMeeting?: { joinUrl?: string } | null;
  bodyPreview?: string;
  body?: { contentType?: string; content?: string };
  hasAttachments?: boolean;
  organizer?: { emailAddress?: { name?: string; address?: string } };
  sensitivity?: string;
  showAs?: string;
  webLink?: string;
};

export type GraphAttachment = {
  id?: string;
  name?: string;
  contentType?: string;
  size?: number;
  isInline?: boolean;
  contentBytes?: string;
  contentId?: string;
  contentLocation?: string;
  "@odata.type"?: string;
};

/** Calendar events between two ISO datetimes (calendarView expands recurrences). */
export async function getEventsRange(userUpn: string, startIso: string, endIso: string): Promise<GraphEvent[]> {
  // Always address the mailbox by UPN. With a delegated token this returns full
  // events only for your own calendar or calendars shared with you (Calendars.Read.Shared);
  // otherwise callers should fall back to getSchedule free/busy.
  const path = `/users/${encodeURIComponent(userUpn)}/calendarView`;
  const data = await graphGet(
    path,
    {
      startDateTime: startIso,
      endDateTime: endIso,
      $select: "id,subject,start,end,location,attendees,onlineMeeting,bodyPreview,organizer,sensitivity,showAs",
      $orderby: "start/dateTime",
      $top: "100",
    },
    { Prefer: `outlook.timezone="${TIMEZONE}"` }
  );
  return data.value || [];
}

/** Now in the configured timezone, as parts. */
export function nowLocal(): { date: string; time: string; weekday: string; iso: string } {
  const now = new Date();
  const fmt = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-CA", { timeZone: TIMEZONE, ...o });
  const date = fmt({ year: "numeric", month: "2-digit", day: "2-digit" }).format(now); // YYYY-MM-DD
  const time = fmt({ hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(now);
  const weekday = new Intl.DateTimeFormat("th-TH", { timeZone: TIMEZONE, weekday: "long" }).format(now);
  return { date, time, weekday, iso: `${date}T${time}` };
}

export async function getTodayEvents(userUpn: string): Promise<GraphEvent[]> {
  const { date } = nowLocal();
  return getEventsRange(userUpn, `${date}T00:00:00`, `${date}T23:59:59`);
}

export async function getEvent(userUpn: string, eventId: string): Promise<GraphEvent> {
  return graphGet(
    `/users/${encodeURIComponent(userUpn)}/events/${encodeURIComponent(eventId)}`,
    {
      $select:
        "id,subject,start,end,location,attendees,onlineMeeting,bodyPreview,body,hasAttachments,organizer,webLink",
    },
    { Prefer: `outlook.timezone="${TIMEZONE}"` }
  );
}

/** File / item attachments on a calendar event (includes contentBytes for small fileAttachment). */
export async function getEventAttachments(userUpn: string, eventId: string): Promise<GraphAttachment[]> {
  try {
    const data = await graphGet(
      `/users/${encodeURIComponent(userUpn)}/events/${encodeURIComponent(eventId)}/attachments`,
      { $top: "20" }
    );
    return (data.value || []) as GraphAttachment[];
  } catch {
    return [];
  }
}

/** Download a drive file as text (best-effort for .txt/.md/.csv/.html). */
export async function downloadDriveText(userUpn: string, itemId: string, maxChars = 8000): Promise<string> {
  try {
    const r = await graphFetch(`/users/${encodeURIComponent(userUpn)}/drive/items/${encodeURIComponent(itemId)}/content`);
    if (!r.ok) return "";
    const ct = (r.headers.get("content-type") || "").toLowerCase();
    if (ct.includes("pdf") || ct.includes("image") || ct.includes("octet-stream")) {
      // binary — skip full parse
      if (!ct.includes("text") && !ct.includes("json") && !ct.includes("xml")) return "";
    }
    const text = await r.text();
    return text.replace(/\s+/g, " ").trim().slice(0, maxChars);
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Users / directory
// ---------------------------------------------------------------------------
const userIdCache = new Map<string, string>();

/** Resolve a UPN/email to the AAD object id (needed by onlineMeetings endpoints). */
export async function getUserId(userUpn: string): Promise<string | null> {
  const cached = userIdCache.get(userUpn);
  if (cached) return cached;
  const data = await graphGet(`/users/${encodeURIComponent(userUpn)}`, { $select: "id" });
  if (data.id) userIdCache.set(userUpn, data.id);
  return data.id || null;
}

// Honorifics stripped before directory lookups (see Python original for rationale).
const HONORIFICS_TH = ["พี่ๆ", "พี่", "น้อง", "คุณ", "ท่าน", "อาจารย์", "ครู"];
const HONORIFICS_EN = ["mr.", "mr ", "mrs.", "mrs ", "ms.", "ms ", "miss ", "khun ", "k.", "k "];

function stripHonorific(name: string): string {
  let q = name.trim();
  let changed = true;
  while (changed) {
    changed = false;
    const low = q.toLowerCase();
    for (const h of HONORIFICS_EN) {
      if (low.startsWith(h) && q.length > h.length) {
        q = q.slice(h.length).trim();
        changed = true;
        break;
      }
    }
    if (changed) continue;
    for (const h of HONORIFICS_TH) {
      if (q.startsWith(h) && q.length > h.length) {
        q = q.slice(h.length).trim();
        changed = true;
        break;
      }
    }
  }
  return q || name.trim();
}

/** Exported honorific stripper (used by the command name extractor). */
export function stripHonorificPublic(name: string): string {
  return stripHonorific(name);
}

export type UserInfo = { mail: string; displayName?: string };

const resolveCache = new Map<string, UserInfo | null>();

/** Look up displayName for a known mail/UPN via app-only Graph (directory read). */
async function lookupUserByMail(mailOrUpn: string): Promise<UserInfo | null> {
  const raw = mailOrUpn.trim();
  const key = raw.toLowerCase();
  if (!key.includes("@")) return null;
  const cached = resolveCache.get(key);
  // Ignore prior failed lookups that stored email as the "name"
  if (cached?.displayName && cached.displayName.toLowerCase() !== key && !cached.displayName.includes("@")) {
    return cached;
  }
  const finish = (info: UserInfo) => {
    resolveCache.set(key, info);
    resolveCache.set(info.mail.toLowerCase(), info);
    return info;
  };
  try {
    // App-only token: delegated User.Read cannot read other users' profiles
    const token = await getToken();
    const r = await fetch(
      `${GRAPH_BASE}/users/${encodeURIComponent(raw)}?$select=mail,userPrincipalName,displayName`,
      { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" }
    );
    if (r.ok) {
      const data = await r.json();
      const mail = (data.mail || data.userPrincipalName || raw).trim();
      const displayName = (data.displayName || "").trim() || mail;
      return finish({ mail, displayName });
    }
    // Fallback: filter by mail / UPN
    const esc = raw.replace(/'/g, "''");
    const r2 = await fetch(
      `${GRAPH_BASE}/users?$filter=mail eq '${esc}' or userPrincipalName eq '${esc}'&$select=mail,userPrincipalName,displayName&$top=1`,
      { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" }
    );
    if (r2.ok) {
      const data = await r2.json();
      const row = (data.value || [])[0];
      if (row) {
        const mail = (row.mail || row.userPrincipalName || raw).trim();
        const displayName = (row.displayName || "").trim() || mail;
        return finish({ mail, displayName });
      }
    }
  } catch {
    /* fall through */
  }
  // Do not cache failures — retry next time
  return { mail: raw, displayName: raw };
}

/** Resolve email/display name/Thai nickname to {mail, displayName}; prefers real mailboxes. */
export async function resolveUserInfo(nameOrEmail: string): Promise<UserInfo | null> {
  const q = nameOrEmail.trim();
  if (!q) return null;
  if (q.includes("@")) return lookupUserByMail(q);
  if (resolveCache.has(q)) return resolveCache.get(q)!;
  const candidates = await searchUsers(q);
  const result = candidates[0] || null;
  resolveCache.set(q, result);
  return result;
}

export async function resolveUser(nameOrEmail: string): Promise<string | null> {
  const info = await resolveUserInfo(nameOrEmail);
  return info?.mail || null;
}

/** Candidate users with a mailbox matching a name/nickname/email (for disambiguation). */
export async function searchUsers(nameOrEmail: string, top = 10): Promise<UserInfo[]> {
  let q = nameOrEmail.trim();
  if (q.includes("@")) {
    const info = await lookupUserByMail(q);
    return info ? [info] : [{ mail: q, displayName: q }];
  }
  const raw = q;
  q = stripHonorific(q);
  const nickExpand = (s: string): string[] => {
    const out = [s];
    const low = s.toLowerCase();
    // Common Thai nick spellings
    if (s === "แบง" || low === "bang") out.push("แบงค์", "Bank");
    if (s === "แบงค์" || low === "bank") out.push("แบง", "Bank");
    if (s === "เบส" || low === "base" || low === "bes") out.push("Base", "Best");
    return out;
  };
  const variants = Array.from(
    new Set([q, raw, stripHonorific(raw), ...nickExpand(q), ...nickExpand(raw)].map((s) => s.trim()).filter(Boolean))
  );

  const merge = (
    results: UserInfo[],
    items: { mail?: string; userPrincipalName?: string; displayName?: string; scoredEmailAddresses?: { address?: string }[] }[]
  ) => {
    const seen = new Set(results.map((r) => r.mail.toLowerCase()));
    for (const it of items) {
      const mail =
        it.mail ||
        it.userPrincipalName ||
        it.scoredEmailAddresses?.find((e) => e.address)?.address ||
        "";
      if (!mail || seen.has(mail.toLowerCase())) continue;
      seen.add(mail.toLowerCase());
      results.push({ mail, displayName: it.displayName || mail });
      if (results.length >= top) break;
    }
    return results;
  };

  let results: UserInfo[] = [];
  const sel = "mail,userPrincipalName,displayName";

  // 1) People the signed-in user already knows (best for Thai nicknames like “นนท์”)
  if (getUserGraphToken()) {
    for (const v of variants) {
      try {
        const data = await graphGet("/me/people", {
          $search: v,
          $top: String(top),
          $select: "displayName,scoredEmailAddresses",
        });
        results = merge(results, data.value || []);
        if (results.length) return results.slice(0, top);
      } catch {
        /* People.Read may be missing — fall through */
      }
    }
  }

  // 2) Directory search (broader $search, then startswith)
  for (const v of variants) {
    const esc = v.replace(/'/g, "''");
    const attempts: { params: Record<string, string>; headers?: Record<string, string> }[] = [
      {
        params: { $search: `"displayName:${v}"`, $select: sel, $top: String(top) },
        headers: { ConsistencyLevel: "eventual" },
      },
      {
        params: { $search: `"${v}"`, $select: sel, $top: String(top) },
        headers: { ConsistencyLevel: "eventual" },
      },
      {
        params: {
          $filter: `startswith(displayName,'${esc}') or startswith(givenName,'${esc}') or startswith(surname,'${esc}') or startswith(mail,'${esc}') or startswith(userPrincipalName,'${esc}')`,
          $select: sel,
          $top: String(top),
        },
      },
    ];
    for (const a of attempts) {
      try {
        const data = await graphGet("/users", a.params, a.headers);
        results = merge(results, data.value || []);
        if (results.length) return results.slice(0, top);
      } catch {
        /* try next */
      }
    }
  }

  // 3) Fuzzy match against recent calendar attendees (nicknames often appear only there)
  if (getUserGraphToken() && q.length >= 2) {
    try {
      const now = new Date();
      const past = new Date(now.getTime() - 45 * 24 * 3600_000);
      const future = new Date(now.getTime() + 45 * 24 * 3600_000);
      const data = await graphGet(
        "/me/calendarView",
        {
          startDateTime: past.toISOString(),
          endDateTime: future.toISOString(),
          $select: "attendees,organizer",
          $top: "50",
        },
        { Prefer: `outlook.timezone="${TIMEZONE}"` }
      );
      const qLow = q.toLowerCase();
      const hits: UserInfo[] = [];
      const seen = new Set<string>();
      const consider = (name?: string, mail?: string) => {
        if (!mail || seen.has(mail.toLowerCase())) return;
        const n = (name || "").toLowerCase();
        const nameRaw = name || "";
        if (!n.includes(qLow) && !nameRaw.includes(q) && !qLow.split(/\s+/).some((t) => t.length >= 2 && n.includes(t))) {
          return;
        }
        seen.add(mail.toLowerCase());
        hits.push({ mail, displayName: name || mail });
      };
      for (const ev of (data.value || []) as GraphEvent[]) {
        const org = ev.organizer?.emailAddress;
        consider(org?.name, org?.address);
        for (const a of ev.attendees || []) {
          consider(a.emailAddress?.name, a.emailAddress?.address);
        }
        if (hits.length >= top) break;
      }
      if (hits.length) return hits.slice(0, top);
    } catch {
      /* ignore */
    }
  }

  return results.slice(0, top);
}

export type Attendee = { name?: string; email?: string };

/** Match a transcript name to someone who was IN the meeting; returns their email. */
export function resolveAttendee(name: string, attendees: Attendee[]): string | null {
  if (!name || !attendees?.length) return null;
  const raw = name.trim();
  if (raw.includes("@")) {
    const low = raw.toLowerCase();
    for (const a of attendees) if ((a.email || "").toLowerCase() === low) return a.email!;
    return null;
  }
  const q = stripHonorific(raw).trim().toLowerCase();
  if (q.length < 2) return null;
  let fuzzy: string | null = null;
  for (const a of attendees) {
    const an = (a.name || "").trim().toLowerCase();
    const ae = a.email;
    if (!an || !ae) continue;
    if (q === an) return ae;
    const toks = an.replace(/,/g, " ").split(/\s+/).filter((t) => t.length >= 2);
    if (an.includes(q) || q.includes(an) || toks.some((t) => t === q || t.startsWith(q) || q.startsWith(t))) {
      fuzzy = fuzzy || ae;
    }
  }
  return fuzzy;
}

// ---------------------------------------------------------------------------
// Free/busy + booking
// ---------------------------------------------------------------------------
export async function getSchedule(
  organizerUpn: string,
  schedules: string[],
  startIso: string,
  endIso: string,
  interval = 30
): Promise<{ scheduleId?: string; availabilityView?: string; scheduleItems?: unknown[]; error?: { message?: string } }[]> {
  // Delegated (/me): free/busy follows the signed-in user's Microsoft 365 rights
  // (org free-busy + calendars shared with them). App-only: Application Access Policy.
  const asUser = !!getUserGraphToken();
  const path = asUser
    ? `/me/calendar/getSchedule`
    : `/users/${encodeURIComponent(organizerUpn)}/calendar/getSchedule`;
  const r = await graphFetch(path, {
    method: "POST",
    body: {
      schedules,
      startTime: { dateTime: startIso, timeZone: TIMEZONE },
      endTime: { dateTime: endIso, timeZone: TIMEZONE },
      availabilityViewInterval: interval,
    },
  });
  if (!r.ok) throw new Error(`Graph getSchedule ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return (await r.json()).value || [];
}

/** Create a calendar event (optionally Teams online meeting). Needs Calendars.ReadWrite. */
export async function createEvent(
  organizerUpn: string,
  subject: string,
  startIso: string,
  endIso: string,
  attendeeEmails: string[],
  online = true,
  description?: string
): Promise<GraphEvent & { id: string; webLink?: string }> {
  const asUser = !!getUserGraphToken();
  const path = asUser ? `/me/events` : `/users/${encodeURIComponent(organizerUpn)}/events`;
  const r = await graphFetch(path, {
    method: "POST",
    body: {
      subject,
      ...(description ? { body: { contentType: "text", content: description } } : {}),
      start: { dateTime: startIso, timeZone: TIMEZONE },
      end: { dateTime: endIso, timeZone: TIMEZONE },
      attendees: attendeeEmails.map((a) => ({ emailAddress: { address: a }, type: "required" })),
      isOnlineMeeting: online,
      onlineMeetingProvider: "teamsForBusiness",
    },
  });
  if (!r.ok) throw new Error(`Graph createEvent ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

export async function deleteEvent(userUpn: string, eventId: string): Promise<void> {
  const asUser = !!getUserGraphToken();
  const path = asUser
    ? `/me/events/${encodeURIComponent(eventId)}`
    : `/users/${encodeURIComponent(userUpn)}/events/${encodeURIComponent(eventId)}`;
  const r = await graphFetch(path, { method: "DELETE" });
  if (!r.ok) throw new Error(`Graph deleteEvent ${r.status}: ${(await r.text()).slice(0, 300)}`);
}

// ---------------------------------------------------------------------------
// Online meetings + transcripts (needs OnlineMeetings.Read.All + OnlineMeetingTranscript.Read.All)
// ---------------------------------------------------------------------------
/** Find the onlineMeeting id from its join URL. `ownerId` is the user's GUID. */
export async function getOnlineMeetingId(ownerId: string, joinUrl: string): Promise<string | null> {
  try {
    const data = await graphGet(`/users/${ownerId}/onlineMeetings`, {
      $filter: `JoinWebUrl eq '${joinUrl.replace(/'/g, "''")}'`,
    });
    return data.value?.[0]?.id || null;
  } catch {
    return null;
  }
}

export async function listTranscripts(ownerId: string, onlineMeetingId: string): Promise<{ id: string }[]> {
  try {
    const data = await graphGet(`/users/${ownerId}/onlineMeetings/${onlineMeetingId}/transcripts`);
    return data.value || [];
  } catch {
    return [];
  }
}

/** Download one transcript's VTT content (tries Accept header first, then $format). */
export async function getTranscriptContent(
  ownerId: string,
  onlineMeetingId: string,
  transcriptId: string
): Promise<string | null> {
  const base = `/users/${ownerId}/onlineMeetings/${onlineMeetingId}/transcripts/${transcriptId}/content`;
  for (const params of [undefined, { $format: "text/vtt" }]) {
    const r = await graphFetch(base, { params, headers: { Accept: "text/vtt" } });
    if (r.ok) {
      const text = await r.text();
      if (text.trim()) return text;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Mail (needs Mail.Send)
// ---------------------------------------------------------------------------
export async function sendEmail(userUpn: string, subject: string, bodyText: string): Promise<void> {
  const r = await graphFetch(`/users/${encodeURIComponent(userUpn)}/sendMail`, {
    method: "POST",
    body: {
      message: {
        subject,
        body: { contentType: "Text", content: bodyText },
        toRecipients: [{ emailAddress: { address: userUpn } }],
      },
      saveToSentItems: true,
    },
  });
  if (!r.ok) throw new Error(`Graph sendMail ${r.status}: ${(await r.text()).slice(0, 300)}`);
}

// ---------------------------------------------------------------------------
// OneDrive search (direct Graph search endpoint only)
// ---------------------------------------------------------------------------
export async function searchFiles(
  userUpn: string,
  query: string,
  top = 25
): Promise<{ id?: string; name?: string; webUrl?: string; lastModifiedDateTime?: string; size?: number }[]> {
  if (!query.trim()) return [];
  const q = encodeURIComponent(query.replace(/'/g, "''"));
  try {
    const data = await graphGet(`/users/${encodeURIComponent(userUpn)}/drive/root/search(q='${q}')`, {
      $select: "id,name,webUrl,lastModifiedDateTime,size,file,folder",
      $top: String(top),
    });
    return data.value || [];
  } catch {
    return [];
  }
}
