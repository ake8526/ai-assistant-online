/**
 * รหัสของ build ที่กำลังให้บริการ — ใช้ร่วมกันระหว่างหน้าเว็บกับ /api/version
 *
 * หน้าเว็บฝังค่านี้ไว้ใน <meta> ตอนเซิร์ฟเวอร์วาดหน้า ค่าที่ฝังจึงเป็นรหัสของ
 * "โค้ดที่กำลังรันอยู่จริง" ไม่ใช่รหัสที่เซิร์ฟเวอร์ตอบตอนนี้ เทียบสองค่านี้แล้ว
 * จึงรู้ว่า JavaScript ในจอเป็นของเก่าหรือยัง — ซึ่งเป็นเรื่องที่ WebView ของแอป
 * ทำให้เกิดขึ้นได้ง่าย เพราะมันไม่โหลดหน้าใหม่ตอนเปิดจากรายการแอปล่าสุด
 */
export function buildId(): string {
  return String(
    process.env.VERCEL_GIT_COMMIT_SHA ||
      process.env.VERCEL_DEPLOYMENT_ID ||
      process.env.NEXT_PUBLIC_BUILD_ID ||
      "dev"
  ).slice(0, 12);
}
