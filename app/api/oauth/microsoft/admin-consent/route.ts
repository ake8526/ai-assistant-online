import { NextResponse } from "next/server";
import { adminConsentUrl, isMicrosoftOAuthConfigured } from "@/lib/msGraphOAuth";

/**
 * พาแอดมินไปหน้าอนุมัติสิทธิ์แทนทั้งองค์กร
 *
 * ทำไมไม่ใช้ปุ่ม "Grant admin consent" ใน Azure portal: ปุ่มนั้นอนุมัติเฉพาะ
 * สิทธิ์ที่ "ลงทะเบียนไว้" ในหน้า API permissions ซึ่งไม่จำเป็นต้องตรงกับที่โค้ด
 * ขอจริงตอนล็อกอิน (เราขอแบบ dynamic) ลิงก์นี้อนุมัติ "ชุดที่โค้ดขอจริง" จึงไม่มี
 * ทางหลุดให้ผู้ใช้เจอหน้าขออนุญาตเพราะสิทธิ์ตัวใดตัวหนึ่งตกสำรวจ
 *
 * ?only=todo อนุมัติเฉพาะ Tasks.ReadWrite (ไม่แตะสิทธิ์อื่น)
 * ไม่ใส่ = ชุดเต็มที่แอปขอ — ผู้ใช้จะไม่เห็นหน้าขออนุญาตอีกเลย
 *
 * เปิดให้ใครก็กดได้โดยตั้งใจ: ปลายทางคือหน้าของ Microsoft ที่บังคับสิทธิ์
 * ระดับแอดมินอยู่แล้ว คนทั่วไปกดไปก็ได้แค่ข้อความว่าอนุมัติไม่ได้
 */
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  if (!isMicrosoftOAuthConfigured()) return NextResponse.redirect(`${url.origin}/todo/expired?why=oauth`);
  const only = url.searchParams.get("only") === "todo";
  return NextResponse.redirect(adminConsentUrl(only ? "todo" : "all"));
}
