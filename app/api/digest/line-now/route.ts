// Build today's digest for one user and push to LINE.
// Invoked fire-and-forget from the LINE webhook so work can use maxDuration=300
// (webhook itself is capped at ~60s and cannot finish Gemini+scrape in after()).
import { NextResponse } from "next/server";
import { checkCronSecret } from "@/lib/auth";
import { resolveLinkedUpn, sendLine } from "@/lib/line";
import { buildDigest, formatStoriesText, rememberDeliveredStories } from "@/lib/digest";
import { runWithTrace, trace } from "@/lib/trace";
import { assertConfigured } from "@/lib/supabaseServer";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

async function run(req: Request) {
  try {
    assertConfigured();
    if (!checkCronSecret(req)) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    const url = new URL(req.url);
    const rawUpn = (url.searchParams.get("upn") || "").trim();
    if (!rawUpn) {
      return NextResponse.json({ error: "upn required" }, { status: 400 });
    }
    const upn = (await resolveLinkedUpn(rawUpn)) || rawUpn.toLowerCase();

    const result = await runWithTrace({ upn, channel: "line-digest" }, async () => {
      trace("fetch", "📰 ดึงข่าวจากแหล่งที่ติดตาม (line-now)", "start");
      const digest = await buildDigest(upn);
      if (!digest.stories?.length) {
        const why =
          digest.note ||
          (digest.skipped.length ? `ข้าม: ${digest.skipped.join(", ")}` : "ไม่มีข่าวใหม่ให้สรุป");
        await sendLine(
          upn,
          "",
          `สรุปข่าวแล้วยังไม่มีเรื่องส่งครับ (${why})\n\nลองพิมพ์ “ข่าววันนี้” อีกครั้ง หรือ “ดูแหล่งข่าว” ได้ครับ`
        );
        trace("reply", "📰 line-now — ว่าง");
        return { ok: true, delivered: 0, note: why };
      }
      const extra = digest.skipped.length ? `\n\n(ข้ามบางแหล่ง: ${digest.skipped.join(", ")})` : "";
      await sendLine(upn, "", formatStoriesText(digest.stories) + extra);
      await rememberDeliveredStories(upn, digest.stories);
      trace("reply", `📰 line-now · ส่ง ${digest.stories.length} เรื่อง`);
      return { ok: true, delivered: digest.stories.length };
    });

    return NextResponse.json(result);
  } catch (e) {
    const msg = String(e).slice(0, 200);
    console.warn("[digest/line-now]", msg);
    try {
      const url = new URL(req.url);
      const rawUpn = (url.searchParams.get("upn") || "").trim();
      const upn = rawUpn ? (await resolveLinkedUpn(rawUpn)) || rawUpn.toLowerCase() : "";
      if (upn) {
        await sendLine(upn, "", "สรุปข่าวไม่สำเร็จครับ — ลองพิมพ์ “ข่าววันนี้” อีกครั้งได้เลย");
      }
    } catch { /* ignore */ }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function GET(req: Request) {
  return run(req);
}

export async function POST(req: Request) {
  return run(req);
}
