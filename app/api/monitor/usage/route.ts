import { NextResponse } from "next/server";
import { guard } from "@/lib/guard";
import { assertConfigured } from "@/lib/supabaseServer";
import { readUsage } from "@/lib/llmUsage";

/**
 * ยอดโทเค็นและค่าใช้จ่าย AI ที่ระบบนับไว้เอง
 *
 * ปิดไว้ที่สิทธิ์ "จัดการสิทธิ์" เพราะเป็นตัวเลขค่าใช้จ่ายของบริษัท ไม่ใช่ของที่
 * ทุกคนที่ล็อกอินได้ควรเห็น (ต่างจากห้องทำงานที่เปิดให้ดูได้ทั้งบริษัท)
 */
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(req: Request) {
  const gate = await guard(req, "admin");
  if (!gate.ok) return gate.response;
  try {
    assertConfigured();
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 503 });
  }

  const days = Number(new URL(req.url).searchParams.get("days") || 30);
  try {
    const report = await readUsage(Number.isFinite(days) ? days : 30);
    return NextResponse.json(report, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: String(e).slice(0, 200) }, { status: 500 });
  }
}
