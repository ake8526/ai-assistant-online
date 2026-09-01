import { NextResponse } from "next/server";
import { AuthError, requireUserOrCron } from "@/lib/auth";
import { assertConfigured } from "@/lib/supabaseServer";
import { hasTasksConsent } from "@/lib/msGraphOAuth";
import { setTodoSyncOn, syncTodoForUser, todoSyncOn } from "@/lib/todoSync";

/**
 * ซิงค์งานเข้า Microsoft To Do ของเจ้าตัว — เปิดรายคน
 *
 * GET  → สถานะ (เปิดไว้ไหม อนุญาตสิทธิ์แล้วไหม)
 * POST { on: true|false } → เปิด/ปิดสวิตช์
 * POST (ไม่มี body) → ซิงค์เดี๋ยวนี้
 */
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(req: Request) {
  try {
    assertConfigured();
    const upn = await requireUserOrCron(req);
    return NextResponse.json({
      upn,
      on: await todoSyncOn(upn),
      consent: await hasTasksConsent(upn),
    });
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 401 });
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    assertConfigured();
    const upn = await requireUserOrCron(req);
    const body = (await req.json().catch(() => ({}))) as { on?: boolean };

    if (typeof body.on === "boolean") {
      await setTodoSyncOn(upn, body.on);
      return NextResponse.json({ ok: true, on: body.on, consent: await hasTasksConsent(upn) });
    }

    const res = await syncTodoForUser(upn);
    return NextResponse.json(res, { status: res.ok ? 200 : 409 });
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 401 });
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
