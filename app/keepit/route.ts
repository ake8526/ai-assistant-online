import { NextResponse } from 'next/server';

// ดาวน์โหลด KeepIt (แอปจัดการของในบ้าน/สต็อกร้านค้า) — รุ่นพรีวิว
// ชี้ไป raw ของ GitHub เหมือน /download เพื่อไม่ให้ไฟล์ APK กินโควตา Vercel
export async function GET() {
  return NextResponse.redirect('https://raw.githubusercontent.com/ake8526/ai-assistant-online/main/public/KeepIt-Preview.apk', 302);
}
