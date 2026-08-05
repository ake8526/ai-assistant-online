// LINE Messaging API helpers — ported from morning_brief/notify.py.
// Uses env LINE_CHANNEL_ACCESS_TOKEN; recipient lookup via Supabase line_links.
import { admin } from "@/lib/supabaseServer";

const LINE_TEXT_LIMIT = 4900; // LINE hard limit is 5000 chars/message; keep headroom
const PUSH_URL = "https://api.line.me/v2/bot/message/push";
const REPLY_URL = "https://api.line.me/v2/bot/message/reply";
const LOADING_URL = "https://api.line.me/v2/bot/chat/loading/start";

function authHeaders(): Record<string, string> {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) throw new Error("LINE_CHANNEL_ACCESS_TOKEN is not set");
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

function chunk(text: string, size = LINE_TEXT_LIMIT): string[] {
  const parts: string[] = [];
  for (let i = 0; i < text.length; i += size) parts.push(text.slice(i, i + size));
  return parts.length ? parts : [""];
}

async function linePost(url: string, body: unknown): Promise<void> {
  const r = await fetch(url, { method: "POST", headers: authHeaders(), body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`LINE ${r.status}: ${(await r.text()).slice(0, 300)}`);
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
export async function pushLineToId(lineUserId: string, text: string): Promise<void> {
  const messages = chunk(text).slice(0, 5).map((c) => ({ type: "text", text: c }));
  await linePost(PUSH_URL, { to: lineUserId, messages });
}

/** Push arbitrary message objects (text + quickReply, flex, …). */
export async function pushLineMessages(lineUserId: string, messages: object[]): Promise<void> {
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
export async function sendLine(upn: string, subject: string, bodyText: string): Promise<void> {
  const lineId = await getLineId(upn);
  if (!lineId) throw new Error(`${upn} ยังไม่ได้เชื่อมบัญชี LINE`);
  const full = subject ? `${subject}\n\n${bodyText}` : bodyText;
  await pushLineToId(lineId, full);
}
