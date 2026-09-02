import { NextResponse, after } from "next/server";
import { AuthError, requireUser } from "@/lib/auth";
import { resolveResponsible } from "@/lib/followup";
import { addTask, listTasks } from "@/lib/store";
import { assertConfigured } from "@/lib/supabaseServer";
import { normalizeDue } from "@/lib/time";
import { syncTodoAfterWrite, todoSyncOn } from "@/lib/todoSync";

// GET ?status= → list the caller's tasks
export async function GET(req: Request) {
  try {
    assertConfigured();
    const upn = await requireUser(req);
    const status = new URL(req.url).searchParams.get("status") || undefined;
    const tasks = await listTasks(upn, status);
    /* ซิงค์ To Do เบื้องหลัง ไม่ให้แท็บงานรอ

       วัดจริงแล้วการซิงค์หนึ่งรอบใช้ ~2 วินาที (คุย Entra หนึ่งครั้ง + อ่านลิสต์
       สามครั้ง) รอให้เสร็จก่อนแสดงผลแลกไม่คุ้ม — เปิดแท็บติดทันทีแล้วให้ตัวเลข
       ขยับตามในไม่กี่วินาทีดีกว่าค้างหน้าขาวรอทุกครั้ง ฝั่งหน้าเว็บจะดึงซ้ำเอง
       เมื่อเห็น syncing: true */
    let syncing = false;
    try {
      if (await todoSyncOn(upn)) {
        syncing = true;
        after(() => syncTodoAfterWrite(upn));
      }
    } catch {
      /* อ่านสวิตช์ไม่ได้ ก็แค่ไม่ซิงค์รอบนี้ */
    }
    return NextResponse.json({ tasks, syncing });
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 401 });
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

// POST { title, detail?, responsible?, due? } → add a task
export async function POST(req: Request) {
  try {
    assertConfigured();
    const upn = await requireUser(req);
    const body = await req.json();
    const title = String(body.title || "").trim();
    if (!title) return NextResponse.json({ error: "title required" }, { status: 400 });
    const responsible = String(body.responsible || "");
    const id = await addTask({
      owner_upn: upn,
      title,
      detail: String(body.detail || ""),
      responsible,
      responsible_upn: await resolveResponsible(responsible),
      due: normalizeDue(body.due),
      source: "manual",
    });
    // ดันขึ้น To Do หลังส่งคำตอบแล้ว ผู้ใช้ไม่ต้องรอ Graph
    after(() => syncTodoAfterWrite(upn));
    return NextResponse.json({ id });
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 401 });
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
