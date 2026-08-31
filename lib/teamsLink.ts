/**
 * ลิงก์เข้าประชุม Teams ที่เปิด "แอป Teams" ก่อน ไม่ใช่เปิดในหน้าเว็บ
 *
 * ปุ่มเดิมเป็น <a href={joinUrl}> ธรรมดา กดในแอปเราแล้วมันเปิด Teams เวอร์ชันเว็บ
 * ค้างอยู่ใน WebView ซึ่งเข้าประชุมไม่ได้จริง (ไมค์/กล้องใช้ไม่ได้ ต้องล็อกอินใหม่)
 *
 * บน Android ใช้ intent: URL ซึ่งเป็นวิธีมาตรฐานที่บอกได้ทั้งสองอย่างในลิงก์เดียว:
 *   - package=com.microsoft.teams → เปิดแอป Teams ถ้าติดตั้งอยู่
 *   - S.browser_fallback_url=…    → ถ้าไม่มีแอป ให้ไปลิงก์ประชุมตามปกติ
 * (MainActivity ดัก intent: แล้วยิง Intent ให้ พร้อมถอยไป fallback เองถ้าไม่มีแอป)
 *
 * นอกแอป (เบราว์เซอร์บนคอม/มือถือ) คืนลิงก์เดิม เพราะเบราว์เซอร์จัดการเองได้ดีกว่า
 * — เดสก์ท็อปจะถามว่าจะเปิดแอป Teams ไหม ซึ่งเป็นพฤติกรรมที่คนคุ้นอยู่แล้ว
 */

/** ลิงก์ประชุมของ Teams หรือไม่ — ลิงก์อื่น (Zoom/Meet) ไม่ต้องแตะ */
export function isTeamsMeetingUrl(url: string): boolean {
  return /^https?:\/\/[^/]*teams(?:\.live)?\.(?:microsoft|com)/i.test(url) || /teams\.microsoft\.com\//i.test(url);
}

/**
 * แปลงลิงก์ประชุมให้เปิดแอป Teams (เฉพาะตอนอยู่ในแอป Android ของเรา)
 *
 * `inApp` ให้ส่งผลของ appBridge() มา — ไม่เดาจาก user agent เพราะ WebView อื่น
 * (LINE, Facebook) ดัก intent: ไม่ได้ กดแล้วจะค้างไปเลย
 */
export function teamsHref(joinUrl: string, inApp: boolean): string {
  if (!joinUrl || !inApp || !isTeamsMeetingUrl(joinUrl)) return joinUrl;
  try {
    const u = new URL(joinUrl);
    // intent: เอาส่วน # ไปเขียนพารามิเตอร์ของตัวเอง ลิงก์ที่มี # อยู่แล้วจะเพี้ยน
    if (u.hash) return joinUrl;
    const rest = `${u.host}${u.pathname}${u.search}`;
    return (
      `intent://${rest}#Intent;scheme=https;package=com.microsoft.teams;` +
      `S.browser_fallback_url=${encodeURIComponent(joinUrl)};end`
    );
  } catch {
    return joinUrl; // ลิงก์เสียก็ปล่อยตามเดิม อย่าทำให้ปุ่มพัง
  }
}
