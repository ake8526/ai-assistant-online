import { NextResponse } from "next/server";
import { AuthError, requireUserOrCron } from "@/lib/auth";
import { assertConfigured } from "@/lib/supabaseServer";
import { addNotice } from "@/lib/inbox";
import { deviceCount, pushConfigured, sendPush } from "@/lib/push";

/**
 * ยิงแจ้งเตือนทดสอบหนึ่งใบ — ไว้พิสูจน์ว่าครบวงจรจริงหลังตั้งค่า FCM เสร็จ
 *
 * เรียกได้สองแบบเหมือน endpoint ของ cron อื่น ๆ: ผู้ใช้ที่ล็อกอิน (ยิงให้ตัวเอง)
 * หรือ cron/แอดมินที่มี CRON_SECRET (ระบุ ?upn= ได้)
 *
 * ตอบกลับมาว่า "ส่งไปกี่เครื่อง" เสมอ — 0 แปลว่าตั้งค่าแล้วแต่ยังไม่มีเครื่อง
 * ลงทะเบียน ซึ่งเป็นอาการที่แยกจาก "ส่งไม่ออก" ไม่ได้ถ้าไม่บอกตัวเลขนี้
 */
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    assertConfigured();
    const upn = await requireUserOrCron(req);
    const url = new URL(req.url);
    const title = (url.searchParams.get("title") || "🔔 ทดสอบแจ้งเตือน").slice(0, 120);
    const body =
      (url.searchParams.get("body") ||
        "ถ้าเห็นข้อความนี้เด้งขึ้นมาที่เครื่อง แปลว่าแจ้งเตือนขึ้นเครื่องใช้ได้แล้วครับ — ข้อความนี้เก็บอยู่ในกล่องแจ้งเตือนด้วย").slice(
        0,
        900
      );

    if (!pushConfigured()) {
      return NextResponse.json(
        { ok: false, error: "ยังไม่ได้ตั้งค่า FCM บนเซิร์ฟเวอร์ (env FCM_*)" },
        { status: 503 }
      );
    }

    const devices = await deviceCount(upn);
    // เก็บเข้ากล่องด้วย เพื่อให้เห็นทั้งสองทางว่ามาถึงจริง
    await addNotice(upn, { kind: "system", title, body });
    // addNotice ยิง push ให้แล้ว แต่มันกันซ้ำภายใน 10 นาที — ยิงตรงอีกครั้งไม่ได้
    // เพราะจะได้สองใบ จึงอ่านผลจากจำนวนเครื่องที่ลงทะเบียนไว้
    return NextResponse.json({ ok: true, upn, devices, title });
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 401 });
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

/** ดูสถานะเฉย ๆ ไม่ส่งอะไร */
export async function GET(req: Request) {
  try {
    assertConfigured();
    const upn = await requireUserOrCron(req);
    return NextResponse.json({ configured: pushConfigured(), devices: await deviceCount(upn), upn });
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 401 });
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

// ยิงจริงจาก sendPush ตรง ๆ ไม่ผ่าน addNotice ไว้ใช้ตอนอยากทดสอบซ้ำ ๆ ถี่ ๆ
export async function PUT(req: Request) {
  try {
    assertConfigured();
    const upn = await requireUserOrCron(req);
    const url = new URL(req.url);
    const sent = await sendPush(upn, {
      title: (url.searchParams.get("title") || "🔔 ทดสอบแจ้งเตือน").slice(0, 120),
      body: (url.searchParams.get("body") || "ทดสอบส่งซ้ำ — ไม่บันทึกลงกล่อง").slice(0, 900),
      tag: "system",
    });
    return NextResponse.json({ ok: true, sent, devices: await deviceCount(upn) });
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 401 });
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
