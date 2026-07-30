import { NextResponse } from "next/server";
import crypto from "crypto";
import { handleCommand } from "@/lib/commands";
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
};

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
  let reply: string;
  try {
    const res = await handleCommand(upn, text, undefined, true);
    reply = res.reply || "รับทราบครับ";
    if (res.map_url) reply += `\n🗺️ ${res.map_url}`;
  } catch (e) {
    reply = `ขออภัยครับ เกิดข้อผิดพลาด: ${String(e).slice(0, 200)}`;
  }
  await replyLine(ev.replyToken, reply);
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
