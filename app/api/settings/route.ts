import { NextResponse } from "next/server";
import { AuthError, requireUser } from "@/lib/auth";
import { addPlace, allSettings, getPrimaryPlace, setSetting } from "@/lib/store";
import { assertConfigured } from "@/lib/supabaseServer";
import { permsOf } from "@/lib/roles";

// GET → { work_start, work_end, work_location, home_location, perms }
//
// perms เดินทางมากับก้อนนี้เพราะหน้าแชทดึง /api/settings ตอนเปิดแอปอยู่แล้ว —
// สิทธิ์ที่ต้องรู้ตั้งแต่วาดปุ่ม (เช่นคำสั่งทดสอบ) จะได้ไม่ต้องยิงอีกรอบ
export async function GET(req: Request) {
  try {
    assertConfigured();
    const upn = await requireUser(req);
    const [s, work, home, perms] = await Promise.all([
      allSettings(upn),
      getPrimaryPlace(upn, "work"),
      getPrimaryPlace(upn, "home"),
      permsOf(upn),
    ]);
    return NextResponse.json({
      work_start: s.work_start || "09:00",
      work_end: s.work_end || "17:00",
      work_location: work?.location || "",
      home_location: home?.location || "",
      perms,
    });
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 401 });
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

// POST { work_start?, work_end?, work_location?, home_location? } → save
export async function POST(req: Request) {
  try {
    assertConfigured();
    const upn = await requireUser(req);
    const body = await req.json();

    if (body.work_start) await setSetting(upn, "work_start", String(body.work_start));
    if (body.work_end) await setSetting(upn, "work_end", String(body.work_end));

    for (const [category, key] of [
      ["work", "work_location"],
      ["home", "home_location"],
    ] as const) {
      const loc = String(body[key] ?? "").trim();
      if (!loc) continue;
      const current = await getPrimaryPlace(upn, category);
      if (current?.location !== loc) await addPlace(upn, category, loc, loc, true);
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 401 });
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
