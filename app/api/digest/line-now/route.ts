// Build today's digest for one user and push to LINE (maxDuration=300).
// Invoked by cron, manual kick, or LINE webhook via kickLineDigest (job token).
import { NextResponse } from "next/server";
import { checkCronSecret } from "@/lib/auth";
import { resolveLinkedUpn, sendLine } from "@/lib/line";
import { buildDigest, formatStoriesText, rememberDeliveredStories } from "@/lib/digest";
import { digestKickSettingKey, type DigestKickPayload } from "@/lib/digestKick";
import { deleteSetting, getSetting } from "@/lib/store";
import { runWithTrace, trace } from "@/lib/trace";
import { assertConfigured } from "@/lib/supabaseServer";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

async function authorizeLineNow(req: Request, upn: string): Promise<boolean> {
  if (checkCronSecret(req)) return true;
  const job = new URL(req.url).searchParams.get("job") || "";
  if (!job || !upn) return false;
  try {
    const raw = await getSetting(upn, digestKickSettingKey());
    if (!raw) return false;
    const payload = JSON.parse(raw) as DigestKickPayload;
    if (!payload?.token || payload.token !== job) return false;
    if (Date.now() - (payload.ts || 0) > 15 * 60 * 1000) return false;
    await deleteSetting(upn, digestKickSettingKey());
    return true;
  } catch {
    return false;
  }
}

async function run(req: Request) {
  try {
    assertConfigured();
    const url = new URL(req.url);
    const rawUpn = (url.searchParams.get("upn") || "").trim();
    if (!rawUpn) {
      return NextResponse.json({ error: "upn required" }, { status: 400 });
    }
    const upn = (await resolveLinkedUpn(rawUpn)) || rawUpn.toLowerCase();
    if (!(await authorizeLineNow(req, upn))) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const result = await runWithTrace({ upn, channel: "line" }, async () => {
      const { claimDigestPush, clearDigestClaim } = await import("@/lib/digestKick");
      trace("fetch", "📰 ดึงข่าวจากแหล่งที่ติดตาม", "start");
      const digest = await buildDigest(upn);
      if (!(await claimDigestPush(upn))) {
        trace("fetch", "📰 ข้ามส่ง — มีงานอื่นส่งแล้ว");
        return { ok: true, delivered: 0, skipped: "claimed" };
      }
      try {
        if (!digest.stories?.length) {
          const why =
            digest.note ||
            (digest.skipped.length ? `ข้าม: ${digest.skipped.join(", ")}` : "ไม่มีข่าวใหม่ให้สรุป");
          await sendLine(
            upn,
            "",
            `สรุปข่าวแล้วยังไม่มีเรื่องส่งครับ (${why})\n\nลองพิมพ์ “ข่าววันนี้” อีกครั้ง หรือ “ดูแหล่งข่าว” ได้ครับ`
          );
          trace("reply", "📰 ตอบกลับ get_news (ว่าง)");
          return { ok: true, delivered: 0, note: why };
        }
        const extra = digest.skipped.length ? `\n\n(ข้ามบางแหล่ง: ${digest.skipped.join(", ")})` : "";
        await sendLine(upn, "", formatStoriesText(digest.stories, digest.note) + extra);
        await rememberDeliveredStories(upn, digest.stories);
        trace("compose", "📰 สรุปข่าวภาษาไทย");
        trace("reply", `📰 ตอบกลับ get_news (${digest.stories.length} เรื่อง)`);
        return { ok: true, delivered: digest.stories.length };
      } finally {
        await clearDigestClaim(upn);
      }
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
