// Microsoft Graph client — app-only (client credentials), ported from
// morning_brief/graph_client.py. Requires env: TENANT_ID (or
// NEXT_PUBLIC_AZURE_TENANT_ID), GRAPH_CLIENT_ID, GRAPH_CLIENT_SECRET.

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

async function graphFetch(
  path: string,
  opts: { method?: string; params?: Record<string, string>; headers?: Record<string, string>; body?: unknown } = {}
): Promise<Response> {
  const url = new URL(path.startsWith("http") ? path : GRAPH_BASE + path);
  for (const [k, v] of Object.entries(opts.params || {})) url.searchParams.set(k, v);
  return fetch(url, {
    method: opts.method || "GET",
    headers: {
      Authorization: `Bearer ${await getToken()}`,
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
  organizer?: { emailAddress?: { name?: string; address?: string } };
  sensitivity?: string;
  showAs?: string;
};

/** Calendar events between two ISO datetimes (calendarView expands recurrences). */
export async function getEventsRange(userUpn: string, startIso: string, endIso: string): Promise<GraphEvent[]> {
  const data = await graphGet(
    `/users/${encodeURIComponent(userUpn)}/calendarView`,
    {
      startDateTime: startIso,
      endDateTime: endIso,
      $select: "subject,start,end,location,attendees,onlineMeeting,bodyPreview,organizer,sensitivity,showAs",
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
    { $select: "subject,start,end,onlineMeeting,attendees,organizer" },
    { Prefer: `outlook.timezone="${TIMEZONE}"` }
  );
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

/** Resolve email/display name/Thai nickname to {mail, displayName}; prefers real mailboxes. */
export async function resolveUserInfo(nameOrEmail: string): Promise<UserInfo | null> {
  const q = nameOrEmail.trim();
  if (!q) return null;
  if (q.includes("@")) return { mail: q, displayName: q };
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
  if (q.includes("@")) return [{ mail: q, displayName: q }];
  q = stripHonorific(q);
  const sel = "mail,userPrincipalName,displayName";
  const attempts: { params: Record<string, string>; headers?: Record<string, string> }[] = [
    {
      params: { $search: `"displayName:${q}"`, $select: sel, $top: String(top) },
      headers: { ConsistencyLevel: "eventual" },
    },
    {
      params: {
        $filter: `startswith(displayName,'${q.replace(/'/g, "''")}') or startswith(givenName,'${q.replace(/'/g, "''")}') or startswith(surname,'${q.replace(/'/g, "''")}')`,
        $select: sel,
        $top: String(top),
      },
    },
  ];
  for (const a of attempts) {
    let items: { mail?: string; userPrincipalName?: string; displayName?: string }[] = [];
    try {
      items = (await graphGet("/users", a.params, a.headers)).value || [];
    } catch {
      items = [];
    }
    const results: UserInfo[] = [];
    const seen = new Set<string>();
    for (const it of items) {
      if (it.mail && !seen.has(it.mail)) {
        seen.add(it.mail);
        results.push({ mail: it.mail, displayName: it.displayName });
      }
    }
    if (results.length) return results;
    if (items.length) {
      const it = items[0];
      const mail = it.mail || it.userPrincipalName;
      if (mail) return [{ mail, displayName: it.displayName }];
    }
  }
  return [];
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
): Promise<{ scheduleId?: string; availabilityView?: string; scheduleItems?: unknown[] }[]> {
  const r = await graphFetch(`/users/${encodeURIComponent(organizerUpn)}/calendar/getSchedule`, {
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
  online = true
): Promise<GraphEvent & { id: string; webLink?: string }> {
  const r = await graphFetch(`/users/${encodeURIComponent(organizerUpn)}/events`, {
    method: "POST",
    body: {
      subject,
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
  const r = await graphFetch(`/users/${encodeURIComponent(userUpn)}/events/${encodeURIComponent(eventId)}`, {
    method: "DELETE",
  });
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
