import { NextResponse } from "next/server";
import { checkCronSecret } from "@/lib/auth";
import { outsideCronWindow } from "@/lib/cronWindow";
import { checkDue, checkUpcomingDue } from "@/lib/followup";
import { assertConfigured } from "@/lib/supabaseServer";
import { syncTodoForAll } from "@/lib/todoSync";

export const maxDuration = 60;

// POST/GET ?key=CRON_SECRET — overdue + advance (pre-due) task reminders
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
    const upcoming = await checkUpcomingDue();
    const reminded = await checkDue();
    /* Microsoft To Do เกาะรอบนี้ไป — เฉพาะคนที่เปิดสวิตช์ไว้เอง
       แยก try เพราะ To Do พังไม่ควรทำให้การเตือนงานทั้งระบบล้ม */
    let todo: Awaited<ReturnType<typeof syncTodoForAll>> | { error: string } | null = null;
    try {
      todo = await syncTodoForAll();
    } catch (e) {
      todo = { error: String(e).slice(0, 160) };
    }
    return NextResponse.json({ ok: true, upcoming, reminded, todo });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
