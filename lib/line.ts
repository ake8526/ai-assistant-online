// LINE Messaging API helpers — ported from morning_brief/notify.py.
// Uses env LINE_CHANNEL_ACCESS_TOKEN; recipient lookup via Supabase line_links.
import { admin } from "@/lib/supabaseServer";

const LINE_TEXT_LIMIT = 4900; // LINE hard limit is 5000 chars/message; keep headroom
const PUSH_URL = "https://api.line.me/v2/bot/message/push";
const QUOTA_URL = "https://api.line.me/v2/bot/message/quota";
const QUOTA_USED_URL = "https://api.line.me/v2/bot/message/quota/consumption";
const REPLY_URL = "https://api.line.me/v2/bot/message/reply";
const LOADING_URL = "https://api.line.me/v2/bot/chat/loading/start";

function authHeaders(): Record<string, string> {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) throw new Error("LINE_CHANNEL_ACCESS_TOKEN is not set");
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

function chunk(text: string, size = LINE_TEXT_LIMIT): string[] {
  const cleaned = (text || "").trim();
  if (!cleaned) return [""];
  if (cleaned.length <= size) return [cleaned];
  const parts: string[] = [];
  let rest = cleaned;
  while (rest.length > size) {
    const window = rest.slice(0, size);
    let cut = window.lastIndexOf("\n\n");
    if (cut < size * 0.45) cut = window.lastIndexOf("\n");
    if (cut < size * 0.45) {
      // Prefer end of sentence (Thai/English) over mid-word cut.
      const marks = ["។", "．", "。", ".", "!", "?", "…"].map((m) => window.lastIndexOf(m));
      cut = Math.max(...marks);
    }
    if (cut < size * 0.45) cut = window.lastIndexOf(" ");
    if (cut < size * 0.45) cut = size;
    else cut = cut + 1;
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}

async function linePost(url: string, body: unknown): Promise<void> {
  const r = await fetch(url, { method: "POST", headers: authHeaders(), body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`LINE ${r.status}: ${(await r.text()).slice(0, 300)}`);
}

// ---------------------------------------------------------------------------
// Push quota guard
//
// The free LINE plan allows 300 PUSH messages per month (replies are free and
// unlimited). On 13 Aug 2026 a dedupe bug burned the whole month's allowance in
// a day and every proactive message failed with no explanation. The API knows
// the number, so ask it: keep a reading cached and refuse bulk pushes once the
// remaining budget is down to the reserve, so the morning brief and news still
// have room. Reasons are traced, never silent.
// ---------------------------------------------------------------------------
const QUOTA_CACHE_MS = 10 * 60_000;
/** Messages held back for the daily essentials when the month runs low. */
const QUOTA_RESERVE = 15;

type QuotaReading = { ts: number; used: number; limit: number | null };

async function lineGet<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url, { headers: authHeaders() });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

async function readQuota(): Promise<QuotaReading | null> {
  const { getSetting, setSetting } = await import("@/lib/store");
  try {
    const raw = await getSetting("_ops", "line_quota");
    if (raw) {
      const cached = JSON.parse(raw) as QuotaReading;
      if (Date.now() - cached.ts < QUOTA_CACHE_MS) return cached;
    }
  } catch {
    /* fall through to a live read */
  }
  const quota = await lineGet<{ type?: string; value?: number }>(QUOTA_URL);
  const used = await lineGet<{ totalUsage?: number }>(QUOTA_USED_URL);
  if (!quota || !used) return null;
  const reading: QuotaReading = {
    ts: Date.now(),
    used: Number(used.totalUsage || 0),
    limit: quota.type === "limited" ? Number(quota.value || 0) : null, // null = unlimited plan
  };
  try {
    await setSetting("_ops", "line_quota", JSON.stringify(reading));
  } catch {
    /* caching is best-effort */
  }
  return reading;
}

/**
 * used / limit / left for the month, for anything that needs to *show* the
 * budget rather than decide on it.
 *
 * The number was only ever consulted by the jobs that spend it, so when the
 * month ran out the only symptom anyone saw was proactive messages going quiet
 * and /monitor/log filling with LineQuotaError. Reads the same 10-minute cache
 * as the guards, so displaying it costs nothing.
 */
export async function lineQuotaReading(): Promise<{ used: number; limit: number | null; left: number | null } | null> {
  const r = await readQuota();
  if (!r) return null;
  return { used: r.used, limit: r.limit, left: r.limit === null ? null : Math.max(0, r.limit - r.used) };
}

/** Remaining pushes this month, or null when unknown / on an unlimited plan. */
export async function lineQuotaLeft(): Promise<number | null> {
  const r = await readQuota();
  if (!r || r.limit === null) return null;
  return Math.max(0, r.limit - r.used);
}

/**
 * No pushes left this month.
 *
 * The catch-up tick asks this before building anything: the quota resets with
 * the billing month, not the day, so a morning that failed on quota can never
 * succeed later today. Retrying it every 5 minutes until 20:55 only burns Graph
 * and LLM calls and fills /monitor/log with hundreds of identical failures.
 *
 * Reads the same cached quota reading as assertQuota, so this costs nothing per
 * tick. Unknown or unlimited plans answer false — let LINE decide.
 */
export async function pushQuotaGone(): Promise<boolean> {
  try {
    const left = await lineQuotaLeft();
    return left !== null && left <= 0;
  } catch {
    return false;
  }
}

export class LineQuotaError extends Error {
  constructor(left: number) {
    super(`LINE push quota exhausted (เหลือ ${left} ข้อความในเดือนนี้)`);
    this.name = "LineQuotaError";
  }
}

/** Throw before spending a push we do not have. `essential` messages (morning
 *  brief / news) may dip into the reserve; bulk jobs may not. */
async function assertQuota(essential: boolean): Promise<void> {
  const left = await lineQuotaLeft();
  if (left === null) return; // unknown or unlimited — let LINE decide
  const floor = essential ? 0 : QUOTA_RESERVE;
  if (left <= floor) throw new LineQuotaError(left);
}

/** Show LINE’s 3-dot “typing” bubble while the bot works (5–60s). */
export async function showLineLoading(lineUserId: string, seconds = 60): Promise<void> {
  const sec = Math.min(60, Math.max(5, Math.round(seconds)));
  try {
    await linePost(LOADING_URL, { chatId: lineUserId, loadingSeconds: sec });
  } catch (e) {
    console.warn("[line] loading animation failed:", String(e).slice(0, 160));
  }
}

/** Low-level push to a raw LINE userId. */
export async function pushLineToId(lineUserId: string, text: string, essential = false): Promise<void> {
  await assertQuota(essential);
  const messages = chunk(text).slice(0, 5).map((c) => ({ type: "text", text: c }));
  await linePost(PUSH_URL, { to: lineUserId, messages });
}

/** Push arbitrary message objects (text + quickReply, flex, …). */
export async function pushLineMessages(
  lineUserId: string,
  messages: object[],
  essential = false
): Promise<void> {
  await assertQuota(essential);
  await linePost(PUSH_URL, { to: lineUserId, messages: messages.slice(0, 5) });
}

/** Download image/file the user sent on LINE (needs message.id). */
export async function downloadLineMessageContent(
  messageId: string
): Promise<{ buffer: Buffer; contentType: string }> {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) throw new Error("LINE_CHANNEL_ACCESS_TOKEN is not set");
  const r = await fetch(`https://api-data.line.me/v2/bot/message/${messageId}/content`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error(`LINE content ${r.status}: ${(await r.text()).slice(0, 120)}`);
  const contentType = r.headers.get("content-type") || "image/jpeg";
  return { buffer: Buffer.from(await r.arrayBuffer()), contentType };
}

/** Reply via replyToken (free — no push quota). Tokens are single-use, short-lived. */
export async function replyLine(replyToken: string, text: string): Promise<void> {
  const messages = chunk(text).slice(0, 5).map((c) => ({ type: "text", text: c }));
  await linePost(REPLY_URL, { replyToken, messages });
}

/** Reply with arbitrary message objects (Flex, templates, ...). */
export async function replyLineMessages(replyToken: string, messages: object[]): Promise<void> {
  await linePost(REPLY_URL, { replyToken, messages });
}

export async function pushLineFlex(lineUserId: string, altText: string, flexContents: object): Promise<void> {
  await linePost(PUSH_URL, { to: lineUserId, messages: [{ type: "flex", altText, contents: flexContents }] });
}

/** Look up the LINE userId linked to an M365 UPN (null if not linked). */
export async function getLineId(upn: string): Promise<string | null> {
  const { data } = await admin
    .from("line_links")
    .select("line_user_id")
    .eq("upn", upn.toLowerCase())
    .maybeSingle();
  return data?.line_user_id || null;
}

export async function getUpnByLineId(lineUserId: string): Promise<string | null> {
  const { data } = await admin
    .from("line_links")
    .select("upn")
    .eq("line_user_id", lineUserId)
    .maybeSingle();
  return data?.upn || null;
}

/** Resolve cron ?upn=… — full email, LINE display_name, or local-part before @. */
export async function resolveLinkedUpn(query: string): Promise<string | null> {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  const { data } = await admin.from("line_links").select("upn, display_name");
  if (!data?.length) return null;
  const exact = data.find((r) => r.upn.toLowerCase() === q);
  if (exact) return exact.upn;
  const byName = data.find((r) => (r.display_name || "").trim().toLowerCase() === q);
  if (byName) return byName.upn;
  const byLocal = data.find((r) => r.upn.toLowerCase().split("@")[0] === q);
  if (byLocal) return byLocal.upn;
  return null;
}

/** Push a message to the user's linked LINE account. Throws if not linked. */
export async function sendLine(
  upn: string,
  subject: string,
  bodyText: string,
  essential = false
): Promise<void> {
  const lineId = await getLineId(upn);
  if (!lineId) throw new Error(`${upn} ยังไม่ได้เชื่อมบัญชี LINE`);
  const full = subject ? `${subject}\n\n${bodyText}` : bodyText;
  await pushLineToId(lineId, full, essential);
}
