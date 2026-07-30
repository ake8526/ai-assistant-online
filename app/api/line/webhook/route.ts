import { NextResponse } from "next/server";
import crypto from "crypto";
import { handleCommand, handleSelection, type CommandResult } from "@/lib/commands";
import { getUpnByLineId, replyLine, replyLineMessages } from "@/lib/line";
import { assertConfigured } from "@/lib/supabaseServer";

export const maxDuration = 60;

// LINE Messaging API webhook.
// Linked users chat with the assistant (same brain as the web); unlinked users
// get a link-account prompt. Webhook URL: https://<app-domain>/api/line/webhook

const LIFF_LINK_URL = `https://liff.line.me/${process.env.NEXT_PUBLIC_LIFF_ID || "2010856732-BFseuR2p"}`;

type LineEvent = {
  type: string;
  replyToken?: string;
  source?: { type: string; userId?: string };
  message?: { type: string; text?: string };
  postback?: { data?: string };
};

type Choice = { mail?: string; displayName?: string; period?: string; event_id?: string; label?: string };
type Slot = { start: string; end: string; label?: string };

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

// Turn a CommandResult that needs a choice (people / time slots / meetings to
// cancel) into LINE quick-reply buttons. Each tap sends a postback that
// handleSelection() completes. Returns null when nothing to pick.
function quickReplyFor(res: CommandResult): { items: object[] } | null {
  const items: object[] = [];
  const add = (label: string, data: string, displayText: string) => {
    if (data.length > 300 || items.length >= 12) return;
    items.push({ type: "action", action: { type: "postback", label: truncate(label, 20), data, displayText: truncate(displayText, 60) } });
  };

  if (res.intent === "choose_person" && Array.isArray(res.choices)) {
    for (const c of res.choices as Choice[]) {
      if (!c.mail) continue;
      const p = new URLSearchParams({ a: "avail", m: c.mail, n: c.displayName || c.mail, p: c.period || "week" });
      add(c.displayName || c.mail, p.toString(), `ดูตารางของ ${c.displayName || c.mail}`);
    }
  } else if (Array.isArray(res.slots) && res.slots.length && (res.intent === "availability" || res.intent === "choose_slot")) {
    const meeting = (res.meeting as { attendees?: string[]; subject?: string }) || {};
    const attendees = meeting.attendees || (res.person?.mail ? [res.person.mail] : []);
    const subject = meeting.subject || "ประชุม";
    for (const s of res.slots as Slot[]) {
      const p = new URLSearchParams({ a: "book", s: s.start, e: s.end, subj: subject, at: attendees.join(",") });
      add(s.label || "จองช่วงนี้", p.toString(), `จอง ${s.label || ""}`);
    }
  } else if (res.intent === "choose_cancel" && Array.isArray(res.choices)) {
    for (const c of res.choices as Choice[]) {
      if (!c.event_id) continue;
      const p = new URLSearchParams({ a: "cancel", id: c.event_id });
      add(c.label || "ยกเลิกนัดนี้", p.toString(), `ยกเลิก: ${c.label || ""}`);
    }
  }
  return items.length ? { items } : null;
}

// Send a reply, attaching quick-reply buttons when the result needs a choice.
async function sendResult(replyToken: string, res: CommandResult): Promise<void> {
  let reply = res.reply || "รับทราบครับ";
  if (res.map_url) reply += `\n🗺️ ${res.map_url}`;
  const qr = quickReplyFor(res);
  if (qr) {
    await replyLineMessages(replyToken, [{ type: "text", text: reply.slice(0, 4900), quickReply: qr }]);
  } else {
    await replyLine(replyToken, reply);
  }
}

function validSignature(rawBody: string, signature: string | null): boolean {
  const secret = process.env.LINE_CHANNEL_SECRET || "";
  if (!secret || !signature) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("base64");
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

function linkPromptMessage() {
  return {
    type: "template",
    altText: "ผูกบัญชีเพื่อใช้งาน",
    template: {
      type: "buttons",
      text: "ผูกบัญชีเพื่อใช้งาน\nกดปุ่มด้านล่างเพื่อผูกบัญชี Microsoft 365 ของคุณ",
      actions: [{ type: "uri", label: "ผูกบัญชี", uri: LIFF_LINK_URL }],
    },
  };
}

async function handleTextMessage(ev: LineEvent): Promise<void> {
  const userId = ev.source?.userId;
  const text = (ev.message?.text || "").trim();
  if (!ev.replyToken || !userId || !text) return;

  const upn = await getUpnByLineId(userId);
  if (!upn) {
    await replyLineMessages(ev.replyToken, [linkPromptMessage()]);
    return;
  }
  // Linked user → run the assistant (lite mode: no slow per-meeting enrichment)
  try {
    const res = await handleCommand(upn, text, undefined, true);
    await sendResult(ev.replyToken, res);
  } catch (e) {
    await replyLine(ev.replyToken, `ขออภัยครับ เกิดข้อผิดพลาด: ${String(e).slice(0, 200)}`);
  }
}

// User tapped a quick-reply button → complete that selection.
async function handlePostback(ev: LineEvent): Promise<void> {
  const userId = ev.source?.userId;
  if (!ev.replyToken || !userId) return;
  const upn = await getUpnByLineId(userId);
  if (!upn) {
    await replyLineMessages(ev.replyToken, [linkPromptMessage()]);
    return;
  }
  try {
    const data = new URLSearchParams(ev.postback?.data || "");
    const res = await handleSelection(upn, data);
    await sendResult(ev.replyToken, res);
  } catch (e) {
    await replyLine(ev.replyToken, `ขออภัยครับ เกิดข้อผิดพลาด: ${String(e).slice(0, 200)}`);
  }
}

export async function POST(req: Request) {
  const rawBody = await req.text();
  if (!validSignature(rawBody, req.headers.get("x-line-signature"))) {
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  try {
    assertConfigured();
    const events: LineEvent[] = JSON.parse(rawBody).events || [];

    for (const ev of events) {
      try {
        if (ev.type === "message" && ev.message?.type === "text") {
          await handleTextMessage(ev);
        } else if (ev.type === "postback") {
          await handlePostback(ev);
        } else if (ev.type === "follow" && ev.replyToken) {
          await replyLineMessages(ev.replyToken, [linkPromptMessage()]);
        }
      } catch (e) {
        console.log(`line webhook event failed: ${e}`);
      }
    }

    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({ ok: true, endpoint: "line webhook" });
}
