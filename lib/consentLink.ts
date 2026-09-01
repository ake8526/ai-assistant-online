import crypto from "crypto";

/**
 * ลิงก์ขออนุญาตสิทธิ์ Microsoft ที่กดจาก LINE ได้
 *
 * ปุ่ม "อนุญาต" ในแอปใช้ id token ของผู้ใช้เป็นตัวระบุตัวตน แต่ในไลน์ไม่มี token
 * นั้น — มีแค่ LINE userId ที่ผูกกับ upn ไว้ในตาราง line_links ลิงก์นี้จึงพา upn
 * ไปด้วยในรูป token ที่เซ็น HMAC และมีวันหมดอายุ แบบเดียวกับลิงก์ดึง GPS
 * (lib/gpsCapture) ที่ใช้วิธีนี้อยู่แล้ว
 *
 * อายุสั้นโดยตั้งใจ: ลิงก์นี้เท่ากับสิทธิ์เริ่มขั้นตอนอนุญาตในนามคนคนนั้น
 * หลุดไปอยู่ในมือคนอื่นแล้วเขากดได้ ก็จะไปจบที่หน้าล็อกอิน Microsoft ของเขาเอง
 * ไม่ใช่ของเรา แต่ก็ไม่มีเหตุให้ต้องอายุยาว
 */

function secret(): string {
  return (
    process.env.GPS_CAPTURE_SECRET ||
    process.env.LINE_CHANNEL_SECRET ||
    process.env.NEXTAUTH_SECRET ||
    "ktis-consent-link-dev"
  );
}

export type ConsentPayload = { upn: string; want: "todo"; exp: number };

export function makeConsentToken(upn: string, ttlMs = 30 * 60_000): string {
  const payload: ConsentPayload = { upn: upn.toLowerCase(), want: "todo", exp: Date.now() + ttlMs };
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = crypto.createHmac("sha256", secret()).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifyConsentToken(token: string): ConsentPayload | null {
  const parts = String(token || "").split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  const expect = crypto.createHmac("sha256", secret()).update(body!).digest("base64url");
  try {
    const a = Buffer.from(sig!);
    const b = Buffer.from(expect);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  } catch {
    return null;
  }
  try {
    const p = JSON.parse(Buffer.from(body!, "base64url").toString("utf8")) as ConsentPayload;
    if (!p?.upn || p.want !== "todo") return null;
    if (!Number.isFinite(p.exp) || p.exp < Date.now()) return null;
    return p;
  } catch {
    return null;
  }
}

export function appBase(): string {
  return (process.env.NEXT_PUBLIC_APP_BASE_URL || "https://ktis-ai-assistant.vercel.app").replace(/\/$/, "");
}

export function todoConsentUrl(upn: string): string {
  return `${appBase()}/api/oauth/microsoft/from-line?t=${encodeURIComponent(makeConsentToken(upn))}`;
}
