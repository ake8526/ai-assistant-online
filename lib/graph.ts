// Microsoft Graph client.
// - Background/cron: app-only (client credentials) via GRAPH_CLIENT_* env.
// - Interactive (chat/LINE): when a delegated user token is in graphAuth ALS,
//   calls run as that user so calendar visibility matches Microsoft 365 /
//   Outlook sharing & free-busy permissions.
import { inflateRawSync } from "zlib";
import { getUserGraphToken, runAsAppOnly } from "@/lib/graphAuth";
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
  opts: {
    method?: string;
    params?: Record<string, string>;
    headers?: Record<string, string>;
    body?: unknown;
    timeoutMs?: number;
  } = {}
): Promise<Response> {
  const url = new URL(path.startsWith("http") ? path : GRAPH_BASE + path);
  for (const [k, v] of Object.entries(opts.params || {})) url.searchParams.set(k, v);
  // Monitor: one "fetch" stage per M365 call. Keep labels short so /monitor
  // console doesn't stretch the layout (event ids / search queries truncated).
  const shortPath = url.pathname
    .replace(/\/users\/[^/]+/i, "/users/…")
    .replace(/\/events\/[^/]+/i, "/events/…")
    .replace(/\/items\/[^/]+/i, "/items/…")
    .replace(/\/shares\/[^/]+/i, "/shares/…")
    .replace(/search\(q='[^']*'\)/i, "search(q='…')")
    .replace(/root:\/[^?]*/i, "root:/…");
  const labelPath = shortPath.length > 72 ? shortPath.slice(0, 70) + "…" : shortPath;
  trace("fetch", `M365 ${opts.method || "GET"} ${labelPath}`);

  // Without a timeout, Graph (esp. Teams online meeting create) can hang until
  // the serverless function is killed — /monitor stays on RUNNER forever.
  const timeoutMs = Math.max(
    5_000,
    opts.timeoutMs || Number(process.env.GRAPH_FETCH_TIMEOUT_MS || 25_000) || 25_000
  );
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, {
      method: opts.method || "GET",
      signal: ac.signal,
      headers: {
        Authorization: await authHeader(),
        "Content-Type": "application/json",
        ...(opts.headers || {}),
      },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    });
  } catch (e) {
    if (ac.signal.aborted || (e instanceof Error && e.name === "AbortError")) {
      throw new Error(`Graph timeout after ${timeoutMs}ms ${opts.method || "GET"} ${labelPath}`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
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
  // Delegated tokens must use /me — /users/{own-upn}/calendarView often returns []
  // even when the mailbox has events. App-only cron keeps addressing by UPN.
  const path = getUserGraphToken()
    ? `/me/calendarView`
    : `/users/${encodeURIComponent(userUpn)}/calendarView`;
  const params: Record<string, string> = {
    startDateTime: startIso,
    endDateTime: endIso,
    $select: "id,subject,start,end,location,attendees,onlineMeeting,bodyPreview,organizer,sensitivity,showAs",
    $top: "100",
  };
  const prefer = { Prefer: `outlook.timezone="${TIMEZONE}"` };

  try {
    const data = await graphGet(path, { ...params, $orderby: "start/dateTime" }, prefer);
    const rows = (data.value || []) as GraphEvent[];
    if (rows.length) return rows;
  } catch (e) {
    console.warn("[graph] calendarView+orderby failed:", String(e).slice(0, 160));
  }

  // Retry without $orderby (some tenants return [] or 400 with orderby on calendarView)
  try {
    const data = await graphGet(path, params, prefer);
    const rows = (data.value || []) as GraphEvent[];
    if (rows.length) {
      return rows.sort((a, b) =>
        String(a.start?.dateTime || "").localeCompare(String(b.start?.dateTime || ""))
      );
    }
  } catch (e) {
    console.warn("[graph] calendarView retry failed:", String(e).slice(0, 160));
  }

  // Last resort: non-expanded /events filter (misses some series exceptions but better than [])
  try {
    const evPath = getUserGraphToken()
      ? `/me/events`
      : `/users/${encodeURIComponent(userUpn)}/events`;
    const data = await graphGet(
      evPath,
      {
        $select: "id,subject,start,end,location,attendees,onlineMeeting,bodyPreview,organizer,sensitivity,showAs",
        $filter: `start/dateTime ge '${startIso}' and start/dateTime lt '${endIso}'`,
        $orderby: "start/dateTime",
        $top: "50",
      },
      prefer
    );
    return (data.value || []) as GraphEvent[];
  } catch (e) {
    console.warn("[graph] events filter failed:", String(e).slice(0, 160));
    return [];
  }
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

function outlookEventPath(userUpn: string, eventId: string): string {
  return getUserGraphToken()
    ? `/me/events/${encodeURIComponent(eventId)}`
    : `/users/${encodeURIComponent(userUpn)}/events/${encodeURIComponent(eventId)}`;
}

const OUTLOOK_FILE_ATTACH_MAX = 2.5 * 1024 * 1024; // stay under Graph JSON attachment ~3MB limit

/**
 * Push a file/link into the real Outlook event: append HTML link in body,
 * and for small OneDrive files also add a fileAttachment attendees can open.
 */
export async function pushMaterialToOutlookEvent(
  userUpn: string,
  eventId: string,
  material: { name?: string; url: string; driveItemId?: string }
): Promise<{ bodyUpdated: boolean; fileAttached: boolean; note: string }> {
  const title = (material.name || material.url || "เอกสาร").trim();
  const url = (material.url || "").trim();
  let fileAttached = false;
  let bodyUpdated = false;
  const notes: string[] = [];

  // 1) File bytes → Outlook attachment (small files only)
  if (material.driveItemId) {
    try {
      const metaR = await graphFetch(
        getUserGraphToken()
          ? `/me/drive/items/${encodeURIComponent(material.driveItemId)}`
          : `/users/${encodeURIComponent(userUpn)}/drive/items/${encodeURIComponent(material.driveItemId)}`,
        { params: { $select: "id,name,size" } }
      );
      const meta = metaR.ok ? await metaR.json() : {};
      const size = Number(meta.size || 0);
      const fname = String(meta.name || title || "file").slice(0, 180);
      if (size > 0 && size <= OUTLOOK_FILE_ATTACH_MAX) {
        const contentPath = getUserGraphToken()
          ? `/me/drive/items/${encodeURIComponent(material.driveItemId)}/content`
          : `/users/${encodeURIComponent(userUpn)}/drive/items/${encodeURIComponent(material.driveItemId)}/content`;
        const contentR = await graphFetch(contentPath);
        if (contentR.ok) {
          const buf = Buffer.from(await contentR.arrayBuffer());
          const attachR = await graphFetch(`${outlookEventPath(userUpn, eventId)}/attachments`, {
            method: "POST",
            body: {
              "@odata.type": "#microsoft.graph.fileAttachment",
              name: fname,
              contentBytes: buf.toString("base64"),
            },
          });
          if (attachR.ok) {
            fileAttached = true;
            notes.push("แนบไฟล์ใน Outlook แล้ว");
          } else {
            notes.push(`แนบไฟล์ไม่สำเร็จ (${attachR.status}) — ใส่ลิงก์ในรายละเอียดแทน`);
          }
        }
      } else if (size > OUTLOOK_FILE_ATTACH_MAX) {
        notes.push("ไฟล์ใหญ่เกินลิมิตแนบ Outlook (~2.5MB) — ใส่ลิงก์ในรายละเอียดนัดแทน");
      }
    } catch (e) {
      console.warn("[graph] outlook file attach failed:", String(e).slice(0, 160));
      notes.push("แนบไฟล์ไม่สำเร็จ — ใส่ลิงก์ในรายละเอียดแทน");
    }
  }

  // 2) Always append a visible link in the event body (attendees see it in Outlook)
  if (url || title) {
    try {
      const ev = await graphGet(outlookEventPath(userUpn, eventId), {
        $select: "id,body,subject",
      });
      const prevType = String(ev.body?.contentType || "HTML").toLowerCase();
      const prev = String(ev.body?.content || "");
      const href = url || title;
      const label = title || url;
      const marker = `<!--ktis-mat:${href.slice(0, 120)}-->`;
      if (!prev.includes(marker) && !prev.includes(href)) {
        const block =
          prevType === "text"
            ? `\n\n---\n📎 ${label}\n${href}\n`
            : `<hr/><p>${marker}<b>📎 เอกสารแนบ:</b> <a href="${href.replace(/"/g, "&quot;")}">${label
                .replace(/</g, "&lt;")
                .replace(/>/g, "&gt;")}</a></p>`;
        const patchR = await graphFetch(outlookEventPath(userUpn, eventId), {
          method: "PATCH",
          body: {
            body: {
              contentType: prevType === "text" ? "Text" : "HTML",
              content: prev + block,
            },
          },
        });
        if (patchR.ok) {
          bodyUpdated = true;
          if (!fileAttached) notes.push("ใส่ลิงก์ในรายละเอียดนัด Outlook แล้ว");
        } else {
          notes.push(`อัปเดตรายละเอียดนัดไม่สำเร็จ (${patchR.status})`);
        }
      } else {
        bodyUpdated = true;
        notes.push("ลิงก์นี้อยู่ในรายละเอียดนัดแล้ว");
      }
    } catch (e) {
      console.warn("[graph] outlook body update failed:", String(e).slice(0, 160));
      notes.push("อัปเดตรายละเอียดนัดไม่สำเร็จ");
    }
  }

  return {
    bodyUpdated,
    fileAttached,
    note: notes.length ? notes.join(" · ") : "ไม่มีการเปลี่ยนแปลงใน Outlook",
  };
}

/** Download a drive file as readable text (txt/md/html + Office Open XML). */
export async function downloadDriveText(userUpn: string, itemId: string, maxChars = 12000): Promise<string> {
  const once = async (): Promise<string> => {
    try {
      const metaR = await graphFetch(
        `/users/${encodeURIComponent(userUpn)}/drive/items/${encodeURIComponent(itemId)}`,
        { params: { $select: "id,name,size,file" } }
      );
      const meta = metaR.ok ? await metaR.json() : {};
      const filename = String(meta.name || "");

      const r = await graphFetch(
        `/users/${encodeURIComponent(userUpn)}/drive/items/${encodeURIComponent(itemId)}/content`
      );
      if (!r.ok) return "";
      const ct = (r.headers.get("content-type") || "").toLowerCase();
      const buf = Buffer.from(await r.arrayBuffer());
      const nameLow = filename.toLowerCase();

      if (ct.includes("image/") || /\.(jpg|jpeg|png|gif|webp|bmp|tiff?|ai|psd|svg)$/i.test(nameLow)) {
        return "";
      }
      if (ct.includes("pdf") || nameLow.endsWith(".pdf")) {
        return ""; // PDF text extract not available in this runtime
      }

      if (
        /\.(txt|md|csv|json|html?|xml|log|tsv|rtf)$/i.test(nameLow) ||
        ct.includes("text/") ||
        ct.includes("json") ||
        ct.includes("xml") ||
        ct.includes("csv")
      ) {
        return buf.toString("utf8").replace(/\u0000/g, "").replace(/\s+/g, " ").trim().slice(0, maxChars);
      }

      const office = extractOfficeZipText(buf, filename);
      if (office) return office.slice(0, maxChars);

      // Last resort: try UTF-8 if it looks like text
      const asText = buf.toString("utf8");
      if (asText && !/[\u0000-\u0008]/.test(asText.slice(0, 200))) {
        return asText.replace(/\s+/g, " ").trim().slice(0, maxChars);
      }
      return "";
    } catch {
      return "";
    }
  };

  const first = await once();
  if (first) return first;
  // Delegated token may lack Files.Read — retry app-only.
  if (getUserGraphToken()) return runAsAppOnly(once);
  return "";
}

function cleanXmlText(s: string): string {
  return s
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function xmlTextNodes(xml: string): string[] {
  const out: string[] = [];
  const re = /<(?:[a-z0-9]+:)?t\b[^>]*>([^<]*)<\/(?:[a-z0-9]+:)?t>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const t = cleanXmlText(m[1] || "");
    if (t) out.push(t);
  }
  return out;
}

/** Minimal ZIP reader for Office Open XML (docx / xlsx / pptx). */
function zipInflateEntries(buf: Buffer): Map<string, string> {
  const out = new Map<string, string>();
  let offset = 0;
  while (offset + 30 < buf.length) {
    if (buf.readUInt32LE(offset) !== 0x04034b50) break;
    const method = buf.readUInt16LE(offset + 8);
    const flags = buf.readUInt16LE(offset + 6);
    const compSize = buf.readUInt32LE(offset + 18);
    const nameLen = buf.readUInt16LE(offset + 26);
    const extraLen = buf.readUInt16LE(offset + 28);
    const name = buf.slice(offset + 30, offset + 30 + nameLen).toString("utf8");
    const dataStart = offset + 30 + nameLen + extraLen;
    // Skip data-descriptor entries (bit 3) — uncommon in Office packages for XML parts
    if (flags & 0x08) break;
    const data = buf.slice(dataStart, dataStart + compSize);
    offset = dataStart + compSize;
    if (!name || name.endsWith("/")) continue;
    try {
      const raw = method === 0 ? data : method === 8 ? inflateRawSync(data) : null;
      if (raw) out.set(name, raw.toString("utf8"));
    } catch {
      /* skip bad entry */
    }
  }
  return out;
}

function extractOfficeZipText(buf: Buffer, filename: string): string {
  if (buf.length < 4 || buf.readUInt32LE(0) !== 0x04034b50) return "";
  const nameLow = (filename || "").toLowerCase();
  let entries: Map<string, string>;
  try {
    entries = zipInflateEntries(buf);
  } catch {
    return "";
  }
  if (!entries.size) return "";

  if (nameLow.endsWith(".docx")) {
    const xml = entries.get("word/document.xml") || "";
    const texts = xmlTextNodes(xml);
    if (!texts.length) return "";
    return `เนื้อหาเอกสาร Word (${filename}):\n` + texts.slice(0, 500).join("\n");
  }

  if (nameLow.endsWith(".xlsx")) {
    const xml = entries.get("xl/sharedStrings.xml") || "";
    const texts = xmlTextNodes(xml);
    const uniq: string[] = [];
    for (const t of texts) {
      if (!uniq.includes(t)) uniq.push(t);
      if (uniq.length >= 300) break;
    }
    if (!uniq.length) return "";
    return `ข้อมูลตาราง Excel (พบ ${uniq.length} รายการข้อความ):\n` + uniq.map((s) => `• ${s}`).join("\n");
  }

  if (nameLow.endsWith(".pptx")) {
    const texts: string[] = [];
    const slides = [...entries.keys()]
      .filter((k) => /^ppt\/slides\/slide\d+\.xml$/i.test(k))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    for (const key of slides) {
      texts.push(...xmlTextNodes(entries.get(key) || ""));
    }
    if (!texts.length) return "";
    return `เนื้อหาสไลด์ PowerPoint (${filename}):\n` + texts.slice(0, 500).join("\n");
  }

  return "";
}

/** True if this user's Graph token can see the OneDrive item (permission check). */
export async function canAccessDriveItem(userUpn: string, itemId: string): Promise<boolean> {
  const probe = async (): Promise<boolean> => {
    try {
      const r = await graphFetch(
        `/users/${encodeURIComponent(userUpn)}/drive/items/${encodeURIComponent(itemId)}`,
        { params: { $select: "id,name" } }
      );
      return r.ok;
    } catch {
      return false;
    }
  };
  if (await probe()) return true;
  // Delegated token may lack Files.Read — app-only Files.Read.All can still see own drive.
  if (getUserGraphToken()) return runAsAppOnly(probe);
  return false;
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

function normalizeDisplayName(displayName: string, mail: string): string {
  const raw = (displayName || "").trim();
  if (!raw) return mail;
  // Some directory entries are stored in all-lowercase roman letters.
  // Normalize to title case for user-facing disambiguation lists.
  if (/^[a-z][a-z\s.'-]{2,}$/.test(raw) && raw.includes(" ")) {
    return raw
      .split(/\s+/)
      .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w))
      .join(" ");
  }
  return raw;
}

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
      const displayName = (data.displayName || "").trim();
      return finish({ mail, displayName: displayName || mail });
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
        const displayName = (row.displayName || "").trim();
        return finish({ mail, displayName: displayName || mail });
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
    if (s === "เอม" || s === "เอ็ม" || low === "em" || low === "aem") out.push("เอม", "เอ็ม", "Em", "Aem");
    if (s === "นน" || s === "นนท์" || low === "non") out.push("นน", "นนท์", "Non");
    return out;
  };
  const variants = Array.from(
    new Set([q, raw, stripHonorific(raw), ...nickExpand(q), ...nickExpand(raw)].map((s) => s.trim()).filter(Boolean))
  );

  const wideTop = Math.max(top, 25);
  const shortQuery = q.length <= 4 && !q.includes(" ");

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
      results.push({ mail, displayName: normalizeDisplayName(it.displayName || "", mail) });
    }
    return results;
  };

  const directorySearch = async (params: Record<string, string>, headers?: Record<string, string>) => {
    try {
      const data = await runAsAppOnly(() => graphGet("/users", params, headers));
      return (data.value || []) as {
        mail?: string;
        userPrincipalName?: string;
        displayName?: string;
      }[];
    } catch {
      return [];
    }
  };

  let results: UserInfo[] = [];
  const sel = "mail,userPrincipalName,displayName";

  // 1) Email-prefix directory hits first (pan → pan.s@, panom.p@) — most reliable for nicknames.
  if (shortQuery) {
    for (const v of variants) {
      const esc = v.replace(/'/g, "''");
      const prefixHits = await directorySearch({
        $filter: `startswith(mail,'${esc}.') or startswith(userPrincipalName,'${esc}.') or startswith(mail,'${esc}') or startswith(userPrincipalName,'${esc}')`,
        $select: sel,
        $top: String(wideTop),
      });
      results = merge(results, prefixHits);
    }
  }

  // 2) Directory startswith on names + mail
  for (const v of variants) {
    const esc = v.replace(/'/g, "''");
    const attempts: { params: Record<string, string>; headers?: Record<string, string> }[] = [
      {
        params: { $search: `"displayName:${v}"`, $select: sel, $top: String(wideTop) },
        headers: { ConsistencyLevel: "eventual" },
      },
      {
        params: { $search: `"${v}"`, $select: sel, $top: String(wideTop) },
        headers: { ConsistencyLevel: "eventual" },
      },
      {
        params: {
          $filter: `startswith(displayName,'${esc}') or startswith(givenName,'${esc}') or startswith(surname,'${esc}') or startswith(mail,'${esc}') or startswith(userPrincipalName,'${esc}')`,
          $select: sel,
          $top: String(wideTop),
        },
      },
    ];
    // Short Thai/roman nick often sits in parentheses: "Name Surname (เบส)"
    if (v.length <= 6) {
      attempts.push({
        params: {
          $filter: `contains(displayName,'${esc}')`,
          $select: sel,
          $top: String(wideTop),
          $count: "true",
        },
        headers: { ConsistencyLevel: "eventual" },
      });
    }
    for (const a of attempts) {
      results = merge(results, await directorySearch(a.params, a.headers));
    }
  }

  // 3) People the signed-in user already knows (Thai nicknames like “นนท์”)
  if (getUserGraphToken()) {
    for (const v of variants) {
      try {
        const data = await graphGet("/me/people", {
          $search: v,
          $top: String(wideTop),
          $select: "displayName,scoredEmailAddresses",
        });
        results = merge(results, data.value || []);
      } catch {
        /* People.Read may be missing — fall through */
      }
    }
  }

  // 4) Fuzzy match against recent calendar attendees (nicknames often appear only there)
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
        if (hits.length >= wideTop) break;
      }
      if (hits.length) results = merge(results, hits);
    } catch {
      /* ignore */
    }
  }
  const vset = Array.from(new Set(variants.map((v) => v.toLowerCase())));
  const qLow = q.toLowerCase();
  const score = (u: UserInfo): number => {
    if (isNonPersonAccount(u)) return 99;
    const mail = (u.mail || "").toLowerCase();
    const local = mail.split("@")[0] || "";
    const dn = (u.displayName || "").toLowerCase();
    const rawDn = u.displayName || "";
    const toks = dn.split(/[\s._\-()/]+/).filter(Boolean);
    const firstTok = toks[0] || "";
    const surnameToks = toks.slice(1);
    let best = 99;
    const checks = [qLow, ...vset].filter(Boolean);
    for (const v of checks) {
      if (!v) continue;
      const localAlias = local.startsWith(v + ".") || local.startsWith(v + "_") || local.startsWith(v + "-");
      const firstPrefix = firstTok.startsWith(v);
      const localPrefix = local.startsWith(v);
      const surnameOnly =
        !firstPrefix &&
        !localPrefix &&
        !localAlias &&
        surnameToks.some((t) => t.startsWith(v));
      // Only treat paren text as a personal nickname (เบรฟ / Base), not "Vacuum Pan Department".
      const nickMatch = isPersonalParenNick(rawDn, v);

      // Exact: mail local or first given name only — never any mid-title token.
      if (local === v || firstTok === v) best = Math.min(best, 0);
      else if (localAlias || nickMatch) best = Math.min(best, 1);
      else if (firstPrefix || dn.startsWith(v)) best = Math.min(best, 2);
      else if (localPrefix) best = Math.min(best, 3);
      else if (surnameOnly) best = Math.min(best, shortQuery ? 7 : 4);
      // No substring-in-middle matches (e.g. deesarap**an**, vacuum **pan**).
    }
    if (!u.displayName || (u.displayName || "").includes("@")) best += 3;
    if (isServiceNick(local)) best += 2;
    return best;
  };

  const peopleOnly = dedupePeople(results).filter((u) => !isNonPersonAccount(u));
  const ranked = peopleOnly.sort((a, b) => {
    const sa = score(a);
    const sb = score(b);
    if (sa !== sb) return sa - sb;
    const al = (a.mail || "").toLowerCase().split("@")[0] || "";
    const bl = (b.mail || "").toLowerCase().split("@")[0] || "";
    return al.localeCompare(bl);
  });
  // Drop surname-only / weak matches when we already have first-name or email hits.
  const hasStrong = ranked.some((u) => score(u) <= 3);
  let filtered = ranked.filter((u) => score(u) < 99);
  if (hasStrong) filtered = filtered.filter((u) => score(u) <= 3);
  return filtered.slice(0, top);
}

/** Shared / org mailboxes that must never appear in “pick a person” lists. */
function isNonPersonAccount(u: UserInfo): boolean {
  const dn = (u.displayName || "").trim();
  const local = ((u.mail || "").split("@")[0] || "").toLowerCase();
  if (
    /(department|factory|company|\bco\.?\s*,?\s*ltd\b|\bteam\b|shared\s*mailbox|noreply|no-?reply|vacuum\s+pan)/i.test(
      dn
    )
  ) {
    return true;
  }
  if (isServiceNick(local)) return true;
  if (/^(tissugar|sugar|factory|dept|department|team|group|shared|room)\b/i.test(local)) return true;
  return false;
}

/** Paren nick like "(เบรฟ …)" — not organizational titles like "(Vacuum Pan Department)". */
function isPersonalParenNick(displayName: string, v: string): boolean {
  const m = displayName.match(/\(([^)]+)\)/);
  if (!m?.[1]) return false;
  const inside = m[1].trim();
  if (/(department|factory|company|team|group|dept|vacuum|mailbox)/i.test(inside)) return false;
  const parts = inside.toLowerCase().split(/[\s._\-]+/).filter(Boolean);
  // Personal nicks are short; org titles are long English phrases.
  const englishWords = parts.filter((t) => /^[a-z]+$/.test(t));
  if (englishWords.length >= 3) return false;
  return parts.some((t) => t === v || (v.length >= 2 && t.startsWith(v) && t.length <= v.length + 4));
}

function isServiceNick(s: string): boolean {
  return /^(acc|admin|collector|ktis|room|noreply|no-reply|service|system|test|tmp|temp|tissugar|sugar)(_|$|\.)/i.test(
    s.trim()
  );
}

/** Map common romanized nicknames → Thai so Bas/Best group with เบส. */
const ROMAN_NICK_TO_THAI: Record<string, string> = {
  bas: "เบส",
  best: "เบส",
  base: "เบส",
  bes: "เบส",
  bass: "เบส",
  bang: "แบง",
  bank: "แบงค์",
  non: "นนท์",
  nont: "นนท์",
  nontt: "นนท์",
  ake: "เอค",
  oak: "โอ๊ค",
  oakk: "โอ๊ค",
  mac: "แม็ค",
  mack: "แม็ค",
  max: "แม็ค",
  kao: "เก้า",
  nine: "เก้า",
  ball: "บอล",
  bol: "บอล",
  es: "เอส",
  ess: "เอส",
};

function nickNorm(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, "");
}

/** Thai-script present. */
export function isThaiNickname(s: string): boolean {
  return /[\u0E00-\u0E7F]/.test(s || "");
}

function isTitleToken(s: string): boolean {
  return /^(mr|mrs|ms|dr|คุณ|นาย|นาง|นางสาว|กัปตัน|ดร\.?)$/i.test(s.trim());
}

/**
 * Thai office nick = short token (เอก/เบส/แม็ค ≤5).
 * Formal given/surname = longer (วีรศักดิ์/พิมพ์ทนต์/ณัฐพงศ์ ≥6).
 */
function isShortThaiNick(s: string): boolean {
  const t = s.trim();
  if (!t || !isThaiNickname(t) || isServiceNick(t) || isTitleToken(t)) return false;
  return t.length >= 1 && t.length <= 5;
}

function isFormalThaiNameToken(s: string): boolean {
  const t = s.trim();
  if (!t || !isThaiNickname(t) || isServiceNick(t) || isTitleToken(t)) return false;
  return t.length >= 6 && t.length <= 20;
}

function isRomanNick(s: string): boolean {
  return !!ROMAN_NICK_TO_THAI[nickNorm(s)];
}

type ParsedPersonName = {
  nick: string | null;
  given: string | null;
  surname: string | null;
};

/**
 * Split display name into ชื่อเล่น / ชื่อจริง / นามสกุล.
 *
 * เอก วีรศักดิ์ พิมพ์ทนต์ → nick=เอก, given=วีรศักดิ์, surname=พิมพ์ทนต์
 * วีรศักดิ์ พิมพ์ทนต์     → nick=null, given=วีรศักดิ์, surname=พิมพ์ทนต์
 * English (แม็ค)           → nick=แม็ค
 * (กัปตัน ณัฐพงศ์ …)      → nick=null (ชื่อจริง+นามสกุล ในวงเล็บ)
 */
function parsePersonNameParts(displayName: string, givenName?: string): ParsedPersonName {
  const empty: ParsedPersonName = { nick: null, given: null, surname: null };
  const dn = (displayName || "").trim();
  if (!dn) return empty;

  const parseThaiTokens = (parts: string[]): ParsedPersonName => {
    const thai = parts.filter((p) => isThaiNickname(p) && !isTitleToken(p) && !isServiceNick(p));
    if (!thai.length) return empty;

    // nick + given + surname…
    if (thai.length >= 3 && isShortThaiNick(thai[0]!) && isFormalThaiNameToken(thai[1]!)) {
      return {
        nick: thai[0]!,
        given: thai[1]!,
        surname: thai.slice(2).join(" ") || null,
      };
    }
    // given + surname (no nick)
    if (thai.length >= 2 && isFormalThaiNameToken(thai[0]!) && isFormalThaiNameToken(thai[1]!)) {
      return {
        nick: null,
        given: thai[0]!,
        surname: thai.slice(1).join(" ") || null,
      };
    }
    // nick + given (no surname visible)
    if (thai.length === 2 && isShortThaiNick(thai[0]!) && isFormalThaiNameToken(thai[1]!)) {
      return { nick: thai[0]!, given: thai[1]!, surname: null };
    }
    // nick alone
    if (thai.length === 1 && isShortThaiNick(thai[0]!)) {
      return { nick: thai[0]!, given: null, surname: null };
    }
    // single formal token = given only
    if (thai.length === 1 && isFormalThaiNameToken(thai[0]!)) {
      return { nick: null, given: thai[0]!, surname: null };
    }
    // 3+ but first not short nick — treat as given + rest surname
    if (thai.length >= 2 && isFormalThaiNameToken(thai[0]!)) {
      return { nick: null, given: thai[0]!, surname: thai.slice(1).join(" ") || null };
    }
    return empty;
  };

  // 1) Parentheses — highest signal for Thai office naming
  const paren = dn.match(/[（(]\s*([^）)]+?)\s*[）)]/);
  if (paren) {
    const innerParts = paren[1]!
      .trim()
      .split(/[\s\-_/|·]+/)
      .filter(Boolean)
      .filter((p) => !isTitleToken(p));
    const fromParen = parseThaiTokens(innerParts);
    if (fromParen.nick) return fromParen;
    // short single nick in paren e.g. (แม็ค) / (เบส)
    if (innerParts.length === 1 && isShortThaiNick(innerParts[0]!)) {
      return { nick: innerParts[0]!, given: null, surname: null };
    }
    if (innerParts.length === 1 && isRomanNick(innerParts[0]!)) {
      return { nick: innerParts[0]!, given: null, surname: null };
    }
    // keep given/surname from paren even if no nick (for dedupe later)
    if (fromParen.given) {
      const outer = dn
        .replace(/[（(][^）)]*[）)]/g, " ")
        .split(/[\s\-_/|·]+/)
        .filter(Boolean);
      const roman = outer.find((t) => isRomanNick(t));
      if (roman) return { ...fromParen, nick: roman };
      return fromParen;
    }
  }

  // 2) Outside parentheses — Thai name string
  const tokens = dn
    .replace(/[（(][^）)]*[）)]/g, " ")
    .split(/[\s\-_/|·]+/)
    .filter(Boolean)
    .filter((p) => !isTitleToken(p));

  const fromOuter = parseThaiTokens(tokens);
  if (fromOuter.nick) return fromOuter;

  // 3) Romanized nick token (Bas / Best / Mack) — only known map
  const roman = tokens.find((t) => isRomanNick(t));
  if (roman) {
    return {
      nick: roman,
      given: fromOuter.given,
      surname: fromOuter.surname,
    };
  }

  // 4) Graph givenName only if short nick (ไม่ใช้ชื่อจริงยาวเป็นชื่อเล่น)
  const gn = (givenName || "").trim();
  if (gn && (isShortThaiNick(gn) || isRomanNick(gn))) {
    return { nick: gn, given: fromOuter.given, surname: fromOuter.surname };
  }

  return fromOuter;
}

/** Nickname only — never treat ชื่อจริง/นามสกุล as nick. */
function nicknameKeyFromDisplay(displayName: string, givenName?: string): string | null {
  return parsePersonNameParts(displayName, givenName).nick;
}

function canonicalizeNick(raw: string): { key: string; label: string; thaiish: boolean } {
  const trimmed = raw.trim();
  const n = nickNorm(trimmed);
  if (isShortThaiNick(trimmed)) return { key: n, label: trimmed, thaiish: true };
  const mapped = ROMAN_NICK_TO_THAI[n];
  if (mapped) return { key: nickNorm(mapped), label: mapped, thaiish: true };
  return { key: n, label: trimmed, thaiish: false };
}

export function isThaiishNickname(s: string): boolean {
  if (isShortThaiNick(s)) return true;
  return !!ROMAN_NICK_TO_THAI[nickNorm(s)];
}

/** Label for LINE: ชื่อเล่น · ชื่อจริง นามสกุล when available. */
export function thaiDisplayLabel(displayName: string, fallbackNick?: string): string | null {
  const raw = (displayName || "").trim();
  const parsed = parsePersonNameParts(raw);
  const nick = (parsed.nick || fallbackNick || "").trim();
  const formal = [parsed.given, parsed.surname].filter(Boolean).join(" ").trim();

  if (nick && formal) {
    const canon = canonicalizeNick(nick).label;
    return `${canon} · ${formal}`;
  }
  if (formal) return formal;
  if (nick) {
    const canon = canonicalizeNick(nick).label;
    if (raw && !isThaiNickname(raw)) {
      const short = raw.replace(/[（(][^）)]*[）)]/g, " ").replace(/\s+/g, " ").trim().slice(0, 40);
      if (short && short.toLowerCase() !== nick.toLowerCase()) return `${canon} · ${short}`;
    }
    return canon;
  }
  return raw || null;
}

function softEnLocal(mailOrLocal: string): string {
  return (mailOrLocal.split("@")[0] || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .replace(/th/g, "t")
    .replace(/(.)\1+/g, "$1");
}

function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const m = a.length;
  const n = b.length;
  const prev = new Array<number>(n + 1);
  const cur = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= n; j++) prev[j] = cur[j];
  }
  return prev[n];
}

/** Same person with 2 accounts (same given+surname / typo English). */
function samePerson(a: UserInfo, b: UserInfo): boolean {
  if (a.mail.toLowerCase() === b.mail.toLowerCase()) return true;

  const formalKey = (u: UserInfo) => {
    const p = parsePersonNameParts(u.displayName || "");
    if (p.given && p.surname) return `gs:${nickNorm(p.given)}|${nickNorm(p.surname)}`;
    if (p.given) return `g:${nickNorm(p.given)}`;
    return "";
  };

  const fa = formalKey(a);
  const fb = formalKey(b);
  if (fa && fb && fa === fb) return true;

  const ea = softEnLocal(a.mail || a.displayName || "");
  const eb = softEnLocal(b.mail || b.displayName || "");
  if (ea && eb && ea.length >= 6 && eb.length >= 6) {
    if (ea === eb) return true;
    if (Math.abs(ea.length - eb.length) <= 2 && editDistance(ea, eb) <= 2) return true;
  }

  const enPrefix = (dn: string) => softEnLocal((dn.match(/^[A-Za-z][A-Za-z0-9._\-]*/) || [""])[0]);
  const pa = enPrefix(a.displayName || "");
  const pb = enPrefix(b.displayName || "");
  if (pa && pb && pa.length >= 6 && pb.length >= 6) {
    if (pa === pb) return true;
    if (Math.abs(pa.length - pb.length) <= 2 && editDistance(pa, pb) <= 2) return true;
  }
  return false;
}

function dedupePeople(people: UserInfo[]): UserInfo[] {
  const out: UserInfo[] = [];
  for (const p of people) {
    if (out.some((x) => samePerson(x, p))) continue;
    out.push(p);
  }
  return out;
}

type DupNickGroup = { nick: string; people: UserInfo[] };

let dupNickCache: { ver: number; at: number; scanned: number; groups: DupNickGroup[] } | null = null;
const DUP_NICK_CACHE_VER = 6;

/** Scan directory displayNames for shared nicknames (app-only User.Read.All). */
export async function findDuplicateNicknames(opts?: {
  maxUsers?: number;
}): Promise<{ scanned: number; groups: DupNickGroup[]; error?: string }> {
  const maxUsers = opts?.maxUsers ?? 500;
  const now = Date.now();
  if (dupNickCache && dupNickCache.ver === DUP_NICK_CACHE_VER && now - dupNickCache.at < 10 * 60_000) {
    return { scanned: dupNickCache.scanned, groups: dupNickCache.groups };
  }

  const users: UserInfo[] = [];
  try {
    const token = await getToken();
    let nextUrl: string | null =
      `${GRAPH_BASE}/users?$select=mail,userPrincipalName,displayName,givenName,accountEnabled` +
      `&$filter=accountEnabled eq true&$top=100`;
    while (nextUrl && users.length < maxUsers) {
      const r: Response = await fetch(nextUrl, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      if (!r.ok) {
        const body = (await r.text()).slice(0, 240);
        if (r.status === 403) {
          return {
            scanned: 0,
            groups: [],
            error:
              "ยังไม่มีสิทธิ์อ่านรายชื่อทั้งองค์กร (User.Read.All) — ติดต่อแอดมินให้เปิดสิทธิ์แอป Graph ครับ",
          };
        }
        return { scanned: 0, groups: [], error: `อ่านไดเรกทอรีไม่สำเร็จ (${r.status}): ${body}` };
      }
      const data: {
        value?: {
          mail?: string;
          userPrincipalName?: string;
          displayName?: string;
          givenName?: string;
        }[];
        "@odata.nextLink"?: string;
      } = await r.json();
      for (const row of data.value || []) {
        const mail = (row.mail || row.userPrincipalName || "").trim();
        if (!mail || /#ext#/i.test(mail)) continue;
        const displayName = (row.displayName || "").trim() || mail;
        users.push({ mail, displayName });
        (users[users.length - 1] as UserInfo & { _gn?: string })._gn = row.givenName || "";
        if (users.length >= maxUsers) break;
      }
      nextUrl = data["@odata.nextLink"] || null;
    }
  } catch (e) {
    return { scanned: 0, groups: [], error: `อ่านไดเรกทอรีไม่สำเร็จ: ${String(e).slice(0, 160)}` };
  }

  const map = new Map<string, { nick: string; people: UserInfo[]; thaiish: boolean }>();
  for (const u of users) {
    const gn = (u as UserInfo & { _gn?: string })._gn;
    const rawNick = nicknameKeyFromDisplay(u.displayName || "", gn);
    if (!rawNick || isServiceNick(rawNick)) continue;
    const canon = canonicalizeNick(rawNick);
    if (canon.key.length < 1) continue;
    const g = map.get(canon.key) || { nick: canon.label, people: [], thaiish: canon.thaiish };
    g.thaiish = g.thaiish || canon.thaiish;
    // Prefer Thai label as group title
    if (isThaiNickname(canon.label)) g.nick = canon.label;
    if (!g.people.some((p) => p.mail.toLowerCase() === u.mail.toLowerCase())) {
      g.people.push({ mail: u.mail, displayName: u.displayName });
    }
    map.set(canon.key, g);
  }

  const groups = [...map.values()]
    .filter((g) => g.people.length >= 2 && g.thaiish)
    .sort((a, b) => b.people.length - a.people.length || a.nick.localeCompare(b.nick, "th"));

  const thaiGroups: DupNickGroup[] = [];
  for (const g of groups) {
    const people: UserInfo[] = [];
    for (const p of dedupePeople(g.people)) {
      const label = thaiDisplayLabel(p.displayName || "", g.nick);
      if (label) people.push({ mail: p.mail, displayName: label });
    }
    if (people.length >= 2) thaiGroups.push({ nick: g.nick, people });
  }

  dupNickCache = { ver: DUP_NICK_CACHE_VER, at: Date.now(), scanned: users.length, groups: thaiGroups };
  return { scanned: users.length, groups: thaiGroups };
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

/** Create a calendar event with a Microsoft Teams join link (always). Needs Calendars.ReadWrite. */
export async function createEvent(
  organizerUpn: string,
  subject: string,
  startIso: string,
  endIso: string,
  attendeeEmails: string[],
  _online = true,
  description?: string
): Promise<GraphEvent & { id: string; webLink?: string; onlineMeeting?: { joinUrl?: string } | null }> {
  const asUser = !!getUserGraphToken();
  const path = asUser ? `/me/events` : `/users/${encodeURIComponent(organizerUpn)}/events`;
  // Teams create can be slow — keep under LINE webhook maxDuration (~60s) with one retry.
  const teamsTimeout = Math.max(
    20_000,
    Number(process.env.GRAPH_CREATE_EVENT_TIMEOUT_MS || 28_000) || 28_000
  );

  const postTeams = async () => {
    const r = await graphFetch(path, {
      method: "POST",
      timeoutMs: teamsTimeout,
      body: {
        subject,
        ...(description ? { body: { contentType: "text", content: description } } : {}),
        start: { dateTime: startIso, timeZone: TIMEZONE },
        end: { dateTime: endIso, timeZone: TIMEZONE },
        attendees: attendeeEmails.map((a) => ({ emailAddress: { address: a }, type: "required" })),
        isOnlineMeeting: true,
        onlineMeetingProvider: "teamsForBusiness",
      },
    });
    if (!r.ok) throw new Error(`Graph createEvent ${r.status}: ${(await r.text()).slice(0, 300)}`);
    return r.json() as Promise<GraphEvent & { id: string; webLink?: string }>;
  };

  let ev: GraphEvent & { id: string; webLink?: string };
  try {
    ev = await postTeams();
  } catch (e) {
    const msg = String(e);
    if (/timeout|503|504|502|429/i.test(msg)) {
      console.warn("[graph] createEvent Teams retry:", msg.slice(0, 160));
      await new Promise((r) => setTimeout(r, 1200));
      ev = await postTeams();
    } else {
      throw e;
    }
  }

  // Join URL sometimes lands a moment after create — refetch / patch if missing.
  if (!ev.onlineMeeting?.joinUrl && ev.id) {
    try {
      await new Promise((r) => setTimeout(r, 800));
      const refreshed = await getEvent(organizerUpn, ev.id);
      if (refreshed?.onlineMeeting?.joinUrl) {
        ev = { ...ev, onlineMeeting: refreshed.onlineMeeting };
      } else {
        const patchPath = asUser
          ? `/me/events/${encodeURIComponent(ev.id)}`
          : `/users/${encodeURIComponent(organizerUpn)}/events/${encodeURIComponent(ev.id)}`;
        const patchR = await graphFetch(patchPath, {
          method: "PATCH",
          timeoutMs: teamsTimeout,
          body: { isOnlineMeeting: true, onlineMeetingProvider: "teamsForBusiness" },
        });
        if (patchR.ok) {
          const again = await getEvent(organizerUpn, ev.id);
          if (again?.onlineMeeting) ev = { ...ev, onlineMeeting: again.onlineMeeting };
        }
      }
    } catch (e) {
      console.warn("[graph] ensure Teams joinUrl failed:", String(e).slice(0, 160));
    }
  }

  if (!ev.onlineMeeting?.joinUrl) {
    console.warn("[graph] createEvent succeeded but Teams joinUrl still missing", ev.id);
  }
  return ev;
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
// OneDrive search + resolve by path / SharePoint URL
// ---------------------------------------------------------------------------
export type DriveFileHit = {
  id?: string;
  name?: string;
  webUrl?: string;
  lastModifiedDateTime?: string;
  size?: number;
  folder?: unknown;
  file?: unknown;
};

function driveBase(userUpn: string): string {
  // Prefer /me when we have a delegated token (matches the signed-in OneDrive).
  // App-only always uses /users/{upn}/drive (needs application Files.Read.All).
  return getUserGraphToken()
    ? "/me/drive"
    : `/users/${encodeURIComponent(userUpn)}/drive`;
}

async function listFolderChildren(userUpn: string, folderPath: string): Promise<DriveFileHit[]> {
  const cleaned = folderPath.replace(/^\/+/, "").trim();
  if (!cleaned) return [];
  const encoded = cleaned
    .split("/")
    .map((s) => encodeURIComponent(s))
    .join("/");
  try {
    const data = await graphGet(`${driveBase(userUpn)}/root:/${encoded}:/children`, {
      $select: "id,name,webUrl,lastModifiedDateTime,size,file,folder",
      $top: "200",
    });
    return (data.value as DriveFileHit[]) || [];
  } catch {
    return [];
  }
}

/** Encode a sharing/open URL for GET /shares/{shareId}/driveItem */
export function encodeSharingUrl(url: string): string {
  const b64 = Buffer.from(url, "utf8").toString("base64");
  return "u!" + b64.replace(/=+$/g, "").replace(/\//g, "_").replace(/\+/g, "-");
}

/** Resolve a OneDrive/SharePoint browser URL to a drive item. */
export async function resolveDriveItemFromUrl(
  userUpn: string,
  rawUrl: string
): Promise<DriveFileHit | null> {
  const url = rawUrl.trim();
  if (!/^https?:\/\//i.test(url)) return null;
  try {
    const shareId = encodeSharingUrl(url);
    const data = await graphGet(`/shares/${encodeURIComponent(shareId)}/driveItem`, {
      $select: "id,name,webUrl,lastModifiedDateTime,size,file,folder",
    });
    if (data?.id) return data as DriveFileHit;
  } catch {
    /* try path parse below */
  }

  // Parse .../Documents/<path> or id= query from OneDrive web UI
  try {
    const u = new URL(url);
    const idParam = u.searchParams.get("id");
    if (idParam) {
      const full = decodeURIComponent(idParam);
      // /personal/user/Documents/Documents/App/... → relative under drive root
      const m = full.match(/\/Documents\/(.+)$/i);
      if (m) {
        const rel = m[1].replace(/^Documents\//i, ""); // unwrap nested Documents if present
        const byPath = await getDriveItemByPath(userUpn, rel);
        if (byPath) return byPath;
        const byPath2 = await getDriveItemByPath(userUpn, m[1]);
        if (byPath2) return byPath2;
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

export async function getDriveItemByPath(
  userUpn: string,
  relativePath: string
): Promise<DriveFileHit | null> {
  const cleaned = relativePath.replace(/^\/+/, "").trim();
  if (!cleaned) return null;
  // Graph path segment encoding: encode each segment but keep slashes
  const encoded = cleaned
    .split("/")
    .map((s) => encodeURIComponent(s))
    .join("/");
  try {
    const data = await graphGet(`${driveBase(userUpn)}/root:/${encoded}`, {
      $select: "id,name,webUrl,lastModifiedDateTime,size,file,folder",
    });
    return (data as DriveFileHit) || null;
  } catch {
    return null;
  }
}

async function searchDriveOnce(userUpn: string, query: string, top: number): Promise<DriveFileHit[]> {
  const q = query.replace(/'/g, "''");
  // Keep Thai/ASCII in the OData string; let URL() encode once (avoid double-encode).
  const path = `${driveBase(userUpn)}/root/search(q='${q}')`;
  try {
    const data = await graphGet(path, {
      $select: "id,name,webUrl,lastModifiedDateTime,size,file,folder",
      $top: String(top),
    });
    return (data.value as DriveFileHit[]) || [];
  } catch {
    return [];
  }
}

/**
 * Rank/filter OneDrive hits so short queries like "ai" don't flood with
 * Adobe Illustrator (.ai), Airplay/AirServer substring noise, or unrelated
 * Graph “related” files that don't even contain the query in the name.
 * Lower score = better.
 */
export function scoreDriveFileHit(name: string, query: string): number {
  const n = (name || "").toLowerCase();
  const q = (query || "").trim().toLowerCase();
  if (!n || !q) return 99;
  const stem = n.replace(/\.[a-z0-9]{1,8}$/i, "");
  const ext = (n.match(/\.([a-z0-9]{1,8})$/i) || [])[1] || "";
  const tokens = stem.split(/[^a-z0-9\u0e00-\u0e7f]+/i).filter(Boolean);

  if (n === q || stem === q) return 0;
  // Explicit AI Assistant / product names
  if (/ai[\s_-]*assistant/i.test(n)) {
    return /ai|assistant|ฟังก์ชัน/.test(q) ? 1 : 3;
  }
  // Adobe Illustrator / “something.ai” when user meant AI the product
  if ((q === "ai" || q === "artificial") && ext === "ai") return 95;
  // Whole-token match only (blocks AirServer / Imagination mid-syllable)
  if (tokens.some((t) => t === q)) return 2;
  if (q.length >= 4 && tokens.some((t) => t.startsWith(q))) return 4;
  // Boundary: "…-ai-…" or "… ai …" or starts/ends with query as its own piece
  const boundary = new RegExp(
    `(^|[^a-z0-9])${q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`,
    "i"
  );
  if (boundary.test(stem)) return 5;
  // Hard reject: name does not contain the query characters at all
  if (!stem.includes(q) && !n.includes(q)) return 99;
  // Weak mid-word substring (air…, imaginai…) — reject short queries
  if (q.length <= 3) return 90;
  if (n.includes(q) || stem.includes(q)) return 12;
  return 99;
}

export function rankDriveFileHits<T extends { name?: string }>(hits: T[], query: string, top = 25): T[] {
  const q = (query || "").trim();
  // Short queries: only strong matches (score ≤ 5). Never keep Graph “related” noise.
  const maxKeep = q.length <= 3 ? 6 : 15;
  const scored = hits
    .map((h) => ({ h, s: scoreDriveFileHit(h.name || "", q) }))
    .filter((x) => x.s <= maxKeep)
    .sort((a, b) => a.s - b.s || (a.h.name || "").localeCompare(b.h.name || "", "th"));
  return scored.slice(0, top).map((x) => x.h);
}

/**
 * Find files by name / SharePoint URL / known OneDrive paths.
 * Thai full names often miss in Graph search — we fall back to path + folder walk.
 * If the LINE session uses a delegated token without Files.Read, retry as app-only.
 */
export async function searchFiles(
  userUpn: string,
  query: string,
  top = 25
): Promise<DriveFileHit[]> {
  const raw = (query || "").trim();
  if (!raw) return [];

  const searchOnce = async (): Promise<DriveFileHit[]> => {
    // Direct SharePoint/OneDrive URL
    if (/sharepoint\.com|onedrive\.live\.com|1drv\.ms/i.test(raw) || /^https?:\/\//i.test(raw)) {
      const hit = await resolveDriveItemFromUrl(userUpn, raw);
      if (hit) return [hit];
    }

    const found = new Map<string, DriveFileHit>();
    const add = (items: DriveFileHit[]) => {
      for (const it of items) {
        const key = it.id || it.webUrl || it.name || "";
        if (key) found.set(key, it);
      }
    };

    add(await searchDriveOnce(userUpn, raw, top));

    const stem = raw.replace(/\.[a-z0-9]{1,8}$/i, "");
    if (stem && stem !== raw) add(await searchDriveOnce(userUpn, stem, top));

    // ASCII-ish tokens help Graph search when Thai full-name misses
    // Skip ultra-short tokens (ai/it/…) — Graph returns huge noisy sets.
    const tokens = stem
      .split(/[\s_\-–—·.]+/)
      .map((t) => t.trim())
      .filter((t) => t.length >= 3 && /[A-Za-z0-9]/.test(t));
    for (const t of tokens.slice(0, 4)) {
      add(await searchDriveOnce(userUpn, t, top));
    }
    // Also try distinctive Thai tokens (≥3 chars)
    const thaiToks = stem
      .split(/[\s_\-–—·.]+/)
      .map((t) => t.trim())
      .filter((t) => t.length >= 3 && /[\u0E00-\u0E7F]/.test(t));
    for (const t of thaiToks.slice(0, 3)) {
      add(await searchDriveOnce(userUpn, t, top));
    }

    // Common personal OneDrive layouts (this project's file lives here)
    const nameWithExt = /\.[a-z0-9]{1,8}$/i.test(raw) ? raw : stem.length >= 3 ? `${stem}.html` : raw;
    if (stem.length >= 3 || nameWithExt) {
      const pathTries = [
        `App/AI Assistant/${nameWithExt}`,
        `Documents/App/AI Assistant/${nameWithExt}`,
        `Documents/Documents/App/AI Assistant/${nameWithExt}`,
        `Documents/${nameWithExt}`,
      ];
      for (const p of pathTries) {
        const hit = await getDriveItemByPath(userUpn, p);
        if (hit) add([hit]);
      }

      // Folder walk when exact path/search miss (Graph search is weak on Thai names)
      const folderTries = ["App/AI Assistant", "Documents/App/AI Assistant", "Documents/Documents/App/AI Assistant"];
      const qLow = raw.toLowerCase();
      const stemLow = stem.toLowerCase();
      for (const folder of folderTries) {
        const kids = await listFolderChildren(userUpn, folder);
        const matched = kids.filter((k) => {
          if (k.folder) return false;
          return scoreDriveFileHit(k.name || "", raw) <= (raw.length <= 3 ? 6 : 15);
        });
        if (matched.length) add(matched);
      }
    }

    return rankDriveFileHits([...found.values()], raw, top);
  };

  let hits = await searchOnce();
  if (hits.length) return hits;
  // Delegated chat sessions often lack Files.Read — retry with app credentials.
  if (getUserGraphToken()) {
    hits = await runAsAppOnly(() => searchOnce());
  }
  return hits;
}
