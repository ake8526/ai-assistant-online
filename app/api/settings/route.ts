import { NextResponse } from "next/server";
import { AuthError, requireUser } from "@/lib/auth";
import { addPlace, allSettings, getPrimaryPlace, setSetting } from "@/lib/store";
import {
  getMeetingRemindMinutes,
  getTaskRemindAheadDays,
  setMeetingRemindMinutes,
  setTaskRemindAheadDays,
} from "@/lib/remindPrefs";
import { assertConfigured } from "@/lib/supabaseServer";
import { permsOf } from "@/lib/roles";
import { getLineId } from "@/lib/line";

// GET → work hours/places + reminder prefs + perms
export async function GET(req: Request) {
  try {
    assertConfigured();
    const upn = await requireUser(req);
    const [s, work, home, perms, meeting_remind_minutes, task_remind_ahead_days, lineId] = await Promise.all([
      allSettings(upn),
      getPrimaryPlace(upn, "work"),
      getPrimaryPlace(upn, "home"),
      permsOf(upn),
      getMeetingRemindMinutes(upn),
      getTaskRemindAheadDays(upn),
      // ผูก LINE ไว้หรือยัง — หน้าตั้งค่าครั้งแรกต้องรู้ ไม่งั้นชวนให้เชื่อมทั้งที่เชื่อมแล้ว
      getLineId(upn).catch(() => null),
    ]);
    return NextResponse.json({
      work_start: s.work_start || "09:00",
      work_end: s.work_end || "17:00",
      /* ค่าข้างบนใส่ค่าเริ่มต้นให้เสมอ หน้าตั้งค่าครั้งแรกจึงแยกไม่ออกว่าผู้ใช้
         ตั้งเองแล้วหรือยัง — ธงนี้บอกว่าเคยกดบันทึกจริงหรือเปล่า */
      hours_set: !!s.work_start,
      // วันทำงาน 0=อาทิตย์ … 6=เสาร์ ไม่เคยตั้ง = จันทร์–ศุกร์
      work_days: (() => {
        try {
          const d = JSON.parse(s.work_days || "[]") as number[];
          return Array.isArray(d) && d.length ? d : [1, 2, 3, 4, 5];
        } catch {
          return [1, 2, 3, 4, 5];
        }
      })(),
      work_location: work?.location || "",
      home_location: home?.location || "",
      meeting_remind_minutes,
      task_remind_ahead_days,
      line_linked: !!lineId,
      // "" = ยังไม่เคยผ่านหน้าตั้งค่าครั้งแรก, done = ทำครบ, skip = กดข้ามไว้
      onboarding: s.onboarding || "",
      perms,
    });
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 401 });
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

// POST { work_*, meeting_remind_minutes?, task_remind_ahead_days? }
export async function POST(req: Request) {
  try {
    assertConfigured();
    const upn = await requireUser(req);
    const body = await req.json();

    if (body.onboarding) await setSetting(upn, "onboarding", String(body.onboarding));
    if (Array.isArray(body.work_days)) {
      const days = [...new Set((body.work_days as unknown[]).map(Number))].filter((d) => d >= 0 && d <= 6);
      await setSetting(upn, "work_days", JSON.stringify(days.sort()));
    }
    if (body.work_start) await setSetting(upn, "work_start", String(body.work_start));
    if (body.work_end) await setSetting(upn, "work_end", String(body.work_end));

    if (body.meeting_remind_minutes !== undefined) {
      await setMeetingRemindMinutes(upn, Number(body.meeting_remind_minutes));
    }
    if (body.task_remind_ahead_days !== undefined) {
      await setTaskRemindAheadDays(upn, Number(body.task_remind_ahead_days));
    }

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
