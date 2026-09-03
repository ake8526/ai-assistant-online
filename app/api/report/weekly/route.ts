import { NextResponse } from "next/server";
import { checkCronSecret } from "@/lib/auth";
import { assertConfigured } from "@/lib/supabaseServer";
import { runWeeklyReport } from "@/lib/weeklyReport";

export const maxDuration = 60;

/**
 * GET/POST ?key=CRON_SECRET — รายงานสัปดาห์ ศุกร์ 17:00 (ตัวตั้งเวลาอยู่ที่
 * cloudflare/src/worker.js ซึ่งยิงทุกนาทีแล้วตัดสินใจเองจากเวลาไทย)
 *
 * ?dry=1 ดูตัวอย่างข้อความโดยไม่ส่งจริงและไม่กินโควตา
 * ?upn=<email> ทดสอบทีละคน
 */
export async function POST(req: Request) {
  return run(req);
}

export async function GET(req: Request) {
  return run(req);
}

async function run(req: Request) {
  try {
    assertConfigured();
    if (!checkCronSecret(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const url = new URL(req.url);
    const dry = url.searchParams.get("dry") === "1";
    const only = url.searchParams.get("upn") || undefined;
    const result = await runWeeklyReport({ dry, only });
    return NextResponse.json({ ok: true, dry, ...result });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
