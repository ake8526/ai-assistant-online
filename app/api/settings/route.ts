import { NextResponse } from "next/server";
import { AuthError, requireUser } from "@/lib/auth";
import { addPlace, allSettings, getPrimaryPlace, setSetting } from "@/lib/store";
import { assertConfigured } from "@/lib/supabaseServer";

// GET → { work_start, work_end, work_location, home_location }
export async function GET(req: Request) {
  try {
    assertConfigured();
    const upn = await requireUser(req);
    const [s, work, home] = await Promise.all([
      allSettings(upn),
      getPrimaryPlace(upn, "work"),
      getPrimaryPlace(upn, "home"),
    ]);
    return NextResponse.json({
      work_start: s.work_start || "09:00",
      work_end: s.work_end || "17:00",
      work_location: work?.location || "",
      home_location: home?.location || "",
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
