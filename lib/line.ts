// LINE Messaging API helpers — ported from morning_brief/notify.py.
// Uses env LINE_CHANNEL_ACCESS_TOKEN; recipient lookup via Supabase line_links.
import { admin } from "@/lib/supabaseServer";

const LINE_TEXT_LIMIT = 4900; // LINE hard limit is 5000 chars/message; keep headroom
const PUSH_URL = "https://api.line.me/v2/bot/message/push";
const REPLY_URL = "https://api.line.me/v2/bot/message/reply";

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

/** Low-level push to a raw LINE userId. */
export async function pushLineToId(lineUserId: string, text: string): Promise<void> {
  const messages = chunk(text).slice(0, 5).map((c) => ({ type: "text", text: c }));
  await linePost(PUSH_URL, { to: lineUserId, messages });
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

/** Push a message to the user's linked LINE account. Throws if not linked. */
export async function sendLine(upn: string, subject: string, bodyText: string): Promise<void> {
  const lineId = await getLineId(upn);
  if (!lineId) throw new Error(`${upn} ยังไม่ได้เชื่อมบัญชี LINE`);
  const full = subject ? `${subject}\n\n${bodyText}` : bodyText;
  await pushLineToId(lineId, full);
}
