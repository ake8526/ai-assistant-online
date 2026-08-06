import { NextResponse } from "next/server";
import { verifyGpsCaptureToken } from "@/lib/gpsCapture";
import { addPlace, clearPendingLineLocation } from "@/lib/store";
import { getLineId, pushLineToId } from "@/lib/line";
import { assertConfigured } from "@/lib/supabaseServer";

export const runtime = "nodejs";

/** POST { token, lat, lng, label? } — save current GPS as work/home for signed token. */
export async function POST(req: Request) {
  try {
    assertConfigured();
    const body = await req.json().catch(() => ({}));
    const token = String(body.token || "");
    const lat = Number(body.lat);
    const lng = Number(body.lng);
    const labelIn = String(body.label || "").trim();

    const payload = verifyGpsCaptureToken(token);
    if (!payload) {
      return NextResponse.json({ error: "ลิงก์หมดอายุหรือไม่ถูกต้อง — ขอลิงก์ใหม่จากแชท LINE ได้ครับ" }, { status: 401 });
    }
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return NextResponse.json({ error: "อ่านพิกัด GPS ไม่สำเร็จ" }, { status: 400 });
    }
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      return NextResponse.json({ error: "พิกัดไม่ถูกต้อง" }, { status: 400 });
    }

    const where = payload.category === "home" ? "บ้าน" : "ที่ทำงาน";
    const addr =
      labelIn ||
      `GPS ${lat.toFixed(5)}, ${lng.toFixed(5)}`;

    await addPlace(payload.upn, payload.category, addr, addr, true, { lat, lng });
    await clearPendingLineLocation(payload.upn);

    // Confirm back in LINE when possible
    try {
      const lineId = await getLineId(payload.upn);
      if (lineId) {
        await pushLineToId(
          lineId,
          payload.category === "home"
            ? `บันทึกบ้านจาก GPS แล้วครับ 🏠\n${addr}`
            : `บันทึกที่ทำงานจาก GPS แล้วครับ 📍\n${addr}\nต่อไปกด «วางแผนเดินทาง» ได้เลย`
        );
      }
    } catch {
      /* best-effort */
    }

    return NextResponse.json({ ok: true, category: payload.category, where, address: addr });
  } catch (e) {
    console.error("[set-gps]", String(e).slice(0, 200));
    return NextResponse.json({ error: "บันทึกไม่สำเร็จ — ลองใหม่อีกครั้งครับ" }, { status: 500 });
  }
}
