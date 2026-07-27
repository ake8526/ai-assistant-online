import { NextResponse } from "next/server";
import { admin } from "@/lib/supabaseServer";

// messenger/link-preview crawlers that prefetch URLs — must NOT count as a real read
const BOT_UA = [
  "bot", "crawler", "spider", "preview", "facebookexternalhit", "line-poker", "linespider",
  "slackbot", "twitterbot", "whatsapp", "telegrambot", "discordbot", "skypeuripreview",
  "curl", "wget", "python-requests", "httpx", "headless", "monitor",
];

export async function GET(req: Request, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  try {
    const { data: link } = await admin.from("read_links").select("*").eq("code", code).single();
    if (!link) return NextResponse.json({ error: "ลิงก์ไม่ถูกต้องหรือหมดอายุ" }, { status: 404 });

    const ua = (req.headers.get("user-agent") || "").toLowerCase();
    const isBot = !ua || BOT_UA.some((b) => ua.includes(b));

    if (!isBot) {
      // only log a genuine open, and only if the user consented to read tracking
      const { data: c } = await admin
        .from("consents")
        .select("granted")
        .eq("owner_upn", link.owner_upn)
        .eq("capability", "read_tracking")
        .single();
      if (c?.granted) {
        await admin.from("reads").insert({
          owner_upn: link.owner_upn,
          url: link.url,
          source: link.source,
          title: link.title,
          read_at: new Date().toISOString(),
        });
      }
    }
    return NextResponse.redirect(link.url);
  } catch (e) {
    // never break the redirect experience on a logging error
    console.error("read redirect error", e);
    return NextResponse.json({ error: "server error" }, { status: 500 });
  }
}
