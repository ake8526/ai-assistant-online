import { NextResponse } from "next/server";
import crypto from "crypto";
import { admin, assertConfigured } from "@/lib/supabaseServer";

// LINE Messaging API webhook.
// Set this URL in the LINE Developers console (Messaging API → Webhook URL):
//   https://<app-domain>/api/line/webhook
// and turn OFF the OA's default auto-reply so this handler answers instead.

const LIFF_LINK_URL = "https://liff.line.me/2010856732-BFseuR2p";

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

async function reply(replyToken: string, messages: object[]) {
  await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({ replyToken, messages }),
  });
}

async function isLinked(lineUserId: string): Promise<boolean> {
  const { data } = await admin
    .from("line_links")
    .select("line_user_id")
    .eq("line_user_id", lineUserId)
    .maybeSingle();
  return !!data?.line_user_id;
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

export async function POST(req: Request) {
  const rawBody = await req.text();
  if (!validSignature(rawBody, req.headers.get("x-line-signature"))) {
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  try {
    assertConfigured();
    const events: LineEvent[] = JSON.parse(rawBody).events || [];

    for (const ev of events) {
      const userId = ev.source?.userId;
      if (!ev.replyToken) continue;

      if (ev.type === "message" && ev.message?.type === "text") {
        const linked = userId ? await isLinked(userId) : false;
        if (linked) {
          await reply(ev.replyToken, [
            {
              type: "text",
              text: "บัญชีของคุณผูกเรียบร้อยแล้ว ✅\nรอรับข่าวสารและการแจ้งเตือนผ่านช่องทางนี้ได้เลย",
            },
          ]);
        } else {
          await reply(ev.replyToken, [linkPromptMessage()]);
        }
      } else if (ev.type === "follow") {
        await reply(ev.replyToken, [linkPromptMessage()]);
      }
    }

    return NextResponse.json({ ok: true });
  } catch (e) {
    // Always return 200-range to LINE where possible to avoid redelivery storms,
    // but surface real errors during setup.
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

// LINE console "Verify" sends a GET/HEAD-less POST; a simple GET helps manual checks.
export async function GET() {
  return NextResponse.json({ ok: true, endpoint: "line webhook" });
}
