import { NextResponse } from "next/server";
import { AuthError, requireUser } from "@/lib/auth";
import { assertConfigured } from "@/lib/supabaseServer";
import { deviceCount, forgetDevice, pushConfigured, registerDevice } from "@/lib/push";

/**
 * เครื่องรายงานตัวเพื่อรับแจ้งเตือน — แอป Android ส่ง FCM token เข้ามาที่นี่
 * ทุกครั้งที่เปิดแอป (โทเคนหมุนเองได้ ส่งซ้ำถือเป็นการต่ออายุ)
 */
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    assertConfigured();
    const upn = await requireUser(req);
    return NextResponse.json({ configured: pushConfigured(), devices: await deviceCount(upn) });
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 401 });
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    assertConfigured();
    const upn = await requireUser(req);
    const body = (await req.json()) as { token?: string; platform?: string };
    const token = (body.token || "").trim();
    if (token.length < 20) return NextResponse.json({ error: "token ไม่ถูกต้อง" }, { status: 400 });
    await registerDevice(upn, token, (body.platform || "android").slice(0, 16));
    return NextResponse.json({ ok: true, devices: await deviceCount(upn) });
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 401 });
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

/** เครื่องนี้ไม่เอาแจ้งเตือนแล้ว (ผู้ใช้ปิดเอง / ออกจากระบบ) */
export async function DELETE(req: Request) {
  try {
    assertConfigured();
    const upn = await requireUser(req);
    const body = (await req.json().catch(() => ({}))) as { token?: string };
    await forgetDevice(upn, (body.token || "").trim());
    return NextResponse.json({ ok: true, devices: await deviceCount(upn) });
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 401 });
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
