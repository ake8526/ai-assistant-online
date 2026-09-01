import { NextResponse } from "next/server";
import { AuthError, resolveUser } from "@/lib/auth";
import { getLineId, lineQuotaReading } from "@/lib/line";
import { getDelegatedGraphToken, hasMicrosoftToken } from "@/lib/msGraphOAuth";
import { admin, assertConfigured } from "@/lib/supabaseServer";
import { deviceCount, pushConfigured } from "@/lib/push";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

export type HealthLevel = "ok" | "warn" | "down";
export type HealthPart = { key: string; name: string; level: HealthLevel; note: string };
export type Health = { level: HealthLevel; label: string; parts: HealthPart[] };

/**
 * สถานะระบบจริงของสามอย่างที่แอปพึ่ง
 *
 * หน้าตั้งค่าเคยเขียน "ปกติ" ค้างไว้ในโค้ด ซึ่งขึ้นว่าปกติแม้ตอนที่ของพังจริง
 * ตรงนี้ถามของจริงทั้งสามทาง:
 *  - Supabase: ยิงคิวรีเบา ๆ หนึ่งครั้ง
 *  - Microsoft Graph: ขอ access token ของผู้ใช้ ซึ่งต้องคุยกับ Entra จริง
 *    (refresh token หมดอายุหรือถูกถอนสิทธิ์จะรู้ตรงนี้ ไม่ใช่ตอนกดดูตาราง)
 *  - LINE: มีบัญชีผูกไว้ไหม และโควตา push เดือนนี้เหลือเท่าไร — โควตาหมดคือ
 *    สาเหตุจริงที่ข้อความอัตโนมัติเงียบไปทั้งระบบ ไม่ใช่ cron พัง
 */
export async function GET(req: Request) {
  try {
    assertConfigured();
    const upn = await resolveUser(req);

    const parts: HealthPart[] = [];

    // ---- Supabase ----
    try {
      const { error } = await admin.from("settings").select("key", { count: "exact", head: true }).limit(1);
      if (error) throw new Error(error.message);
      parts.push({ key: "db", name: "ฐานข้อมูล (Supabase)", level: "ok", note: "ต่อได้ปกติ" });
    } catch (e) {
      parts.push({
        key: "db",
        name: "ฐานข้อมูล (Supabase)",
        level: "down",
        note: `ต่อไม่ได้: ${(e as Error).message}`.slice(0, 160),
      });
    }

    // ---- Microsoft Graph (สิทธิ์ของผู้ใช้คนนี้) ----
    try {
      const linked = await hasMicrosoftToken(upn);
      if (!linked) {
        parts.push({
          key: "graph",
          name: "Microsoft 365 (Graph)",
          level: "warn",
          note: "ยังไม่อนุญาตปฏิทิน — จะเห็นเท่าที่ 365 แชร์ให้",
        });
      } else {
        const token = await getDelegatedGraphToken(upn);
        parts.push(
          token
            ? { key: "graph", name: "Microsoft 365 (Graph)", level: "ok", note: "สิทธิ์ใช้งานได้" }
            : {
                key: "graph",
                name: "Microsoft 365 (Graph)",
                level: "down",
                note: "สิทธิ์หมดอายุ — ต้องกดอนุญาตใหม่",
              }
        );
      }
    } catch (e) {
      parts.push({
        key: "graph",
        name: "Microsoft 365 (Graph)",
        level: "down",
        note: String((e as Error).message || e).slice(0, 160),
      });
    }

    // ---- LINE ----
    try {
      const [lineId, quota] = await Promise.all([getLineId(upn), lineQuotaReading()]);
      if (!lineId) {
        parts.push({ key: "line", name: "LINE", level: "warn", note: "ยังไม่ผูกบัญชี — ข้อความเตือนส่งไม่ได้" });
      } else if (quota && quota.left !== null && quota.left <= 0) {
        parts.push({
          key: "line",
          name: "LINE",
          level: "down",
          note: `โควตาส่งเดือนนี้หมด (ใช้ ${quota.used}/${quota.limit}) — ตอบในแชทยังได้`,
        });
      } else if (quota && quota.left !== null && quota.left <= 30) {
        parts.push({
          key: "line",
          name: "LINE",
          level: "warn",
          note: `เหลือส่งได้ ${quota.left} ข้อความในเดือนนี้`,
        });
      } else {
        parts.push({
          key: "line",
          name: "LINE",
          level: "ok",
          note:
            quota && quota.left !== null ? `ผูกแล้ว · เหลือส่งได้ ${quota.left} ข้อความ` : "ผูกแล้ว · ส่งได้ปกติ",
        });
      }
    } catch (e) {
      parts.push({ key: "line", name: "LINE", level: "warn", note: String((e as Error).message || e).slice(0, 160) });
    }

    /* ---- แจ้งเตือนขึ้นเครื่อง (FCM) ----
       แยกสองเรื่องให้ชัด: ตั้งค่าฝั่งเซิร์ฟเวอร์แล้วหรือยัง กับเครื่องนี้ลงทะเบียน
       แล้วหรือยัง — ทั้งคู่พังเงียบเหมือนกันถ้าไม่บอก */
    try {
      if (!pushConfigured()) {
        parts.push({
          key: "push",
          name: "แจ้งเตือนขึ้นเครื่อง",
          level: "warn",
          note: "ยังไม่ได้ตั้งค่า FCM บนเซิร์ฟเวอร์ (env FCM_*)",
        });
      } else {
        const n = await deviceCount(upn);
        parts.push({
          key: "push",
          name: "แจ้งเตือนขึ้นเครื่อง",
          level: n ? "ok" : "warn",
          note: n
            ? `พร้อมส่ง · ลงทะเบียนไว้ ${n} เครื่อง`
            : "เซิร์ฟเวอร์พร้อมแล้ว แต่ยังไม่มีเครื่องลงทะเบียน — ต้องใช้แอปรุ่นที่มี Firebase",
        });
      }
    } catch (e) {
      parts.push({
        key: "push",
        name: "แจ้งเตือนขึ้นเครื่อง",
        level: "warn",
        note: String((e as Error).message || e).slice(0, 160),
      });
    }

    const level: HealthLevel = parts.some((p) => p.level === "down")
      ? "down"
      : parts.some((p) => p.level === "warn")
        ? "warn"
        : "ok";
    const label = level === "ok" ? "ปกติ" : level === "warn" ? "มีบางอย่างต้องดู" : "มีปัญหา";

    const health: Health = { level, label, parts };
    return NextResponse.json(health, { headers: NO_STORE });
  } catch (e) {
    const status = e instanceof AuthError ? 401 : 500;
    return NextResponse.json({ error: String(e instanceof AuthError ? e.message : e) }, { status });
  }
}
