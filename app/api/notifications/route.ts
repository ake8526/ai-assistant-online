import { NextResponse } from "next/server";
import { AuthError, requireUser } from "@/lib/auth";
import { assertConfigured } from "@/lib/supabaseServer";
import { listNotices, markRead } from "@/lib/inbox";

// กล่องแจ้งเตือนในแอป — ทุกอย่างที่ผู้ช่วยส่งออกไป อ่านย้อนหลังได้ที่นี่
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    assertConfigured();
    const upn = await requireUser(req);
    const notices = await listNotices(upn);
    return NextResponse.json(
      { notices, unread: notices.filter((n) => !n.read).length },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 401 });
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

// POST { read: "all" | "<id>" }
export async function POST(req: Request) {
  try {
    assertConfigured();
    const upn = await requireUser(req);
    const body = (await req.json()) as { read?: string };
    const id = (body.read || "").trim();
    if (!id) return NextResponse.json({ error: "ต้องระบุว่าอ่านฉบับไหน" }, { status: 400 });
    const notices = await markRead(upn, id);
    return NextResponse.json({ ok: true, notices, unread: notices.filter((n) => !n.read).length });
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 401 });
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
