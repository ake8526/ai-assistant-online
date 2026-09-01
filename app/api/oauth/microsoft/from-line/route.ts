import { NextResponse } from "next/server";
import { buildMicrosoftAuthUrl, isMicrosoftOAuthConfigured } from "@/lib/msGraphOAuth";
import { makeConsentToken, verifyConsentToken } from "@/lib/consentLink";

/**
 * เริ่มขั้นตอนอนุญาตสิทธิ์ To Do จากลิงก์ที่กดมาจาก LINE
 *
 * /api/oauth/microsoft/start ต้องมี id token ของผู้ใช้ติดมาใน query ซึ่งในไลน์
 * ไม่มี — ตัวนี้ใช้ token ที่เราเซ็นเองแทน (lib/consentLink) แล้วส่งต่อเข้า
 * หน้าอนุญาตของ Microsoft เหมือนกัน
 *
 * ปลายทางหลังอนุญาตต้องเป็นหน้าที่เปิดได้โดยไม่ต้องล็อกอิน เพราะคนกดอยู่ใน
 * เบราว์เซอร์ในแอป LINE ที่ไม่มีเซสชันของเรา — /account?ms=connected จะเด้ง
 * ไปหน้าล็อกอินแล้วดูเหมือนอนุญาตไม่สำเร็จทั้งที่สำเร็จ
 */
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const p = verifyConsentToken(url.searchParams.get("t") || "");
  if (!p) return NextResponse.redirect(`${url.origin}/todo/expired`);
  if (!isMicrosoftOAuthConfigured()) return NextResponse.redirect(`${url.origin}/todo/expired?why=oauth`);

  // token ใบใหม่อายุ 1 ชม. สำหรับหน้าผลลัพธ์ — ใบที่กดมาอาจเหลืออายุไม่พอ
  // ให้เดินจนจบขั้นตอนอนุญาต (เลือกบัญชี ใส่รหัส MFA)
  const back = `/todo/${makeConsentToken(p.upn, 60 * 60_000)}`;
  const state = Buffer.from(JSON.stringify({ upn: p.upn, back }), "utf-8").toString("base64url");
  return NextResponse.redirect(buildMicrosoftAuthUrl(state));
}
