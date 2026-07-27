import { NextResponse } from "next/server";
import Parser from "rss-parser";

const parser = new Parser();

export interface Story {
  id: string;
  title: string;
  source: string;
  kind: "rss" | "youtube" | "facebook";
  whatHappened: string;
  cause: string;
  progress: string;
  conclusion: string;
  shortLink: string;
  rawLink: string;
  publishedAt: string;
}

const DEMO_STORIES: Story[] = [
  {
    id: "story-1",
    title: "สรุปผลประกอบการ Alphabet (Google) รายได้โตจากธุรกิจ Cloud & Gemini AI",
    source: "Blognone IT News",
    kind: "rss",
    whatHappened: "Alphabet เผยผลประกอบการไตรมาสล่าสุด เติบโตอย่างแข็งแกร่งด้วยรายได้จาก Google Cloud และการให้บริการโซลูชัน Gemini AI แก่องค์กร",
    cause: "องค์กรทั่วโลกเร่งปรับตัวสู่ยุค AI ทำให้มีความต้องการใช้งานโครงสร้างพื้นฐานคลาวด์และโมเดลประมวลผลขนาดใหญ่เพิ่มขึ้นเท่าตัว",
    progress: "บริษัทประกาศขยายการลงทุนใน Data Center ภูมิภาคเอเชียตะวันออกเฉียงใต้ รวมถึงประเทศไทย เพิ่มเติมกว่า 1 พันล้านดอลลาร์",
    conclusion: "ผลประกอบการมีแนวโน้มทำสถิติสูงสุดใหม่อย่างต่อเนื่องตามทิศทางความต้องการเทคโนโลยี AI ในตลาดโลก",
    shortLink: "/r/demo-google-cloud",
    rawLink: "https://www.blognone.com",
    publishedAt: new Date().toISOString(),
  },
  {
    id: "story-2",
    title: "เปิดตัวแบตเตอรี่ EV ยุคใหม่ ชาร์จไว 10 นาที วิ่งได้ไกล 500 กิโลเมตร",
    source: "The Standard Tech",
    kind: "facebook",
    whatHappened: "ค่ายรถยนต์ชั้นนำประกาศความสำเร็จในการพัฒนาแบตเตอรี่รถยนต์ไฟฟ้าชนิดใหม่ที่รองรับการชาร์จความเร็วสูงพิเศษ",
    cause: "เพื่อขจัดข้อจำกัดด้านระยะเวลาการชาร์จและระยะทาง ซึ่งเป็นปัจจัยหลักที่ผู้บริโภคกังวลในการเปลี่ยนมาใช้รถ EV",
    progress: "เทคโนโลยีผ่านการทดสอบความปลอดภัยขั้นสูงสุดแล้ว และเตรียมเข้าสู่สายการผลิตเพื่อติดตั้งในรถยนต์รุ่นใหม่ปีหน้า",
    conclusion: "คาดว่านวัตกรรมนี้จะช่วยเร่งการเปลี่ยนผ่านสู่อุตสาหกรรมยานยนต์ไฟฟ้าทั่วโลกอย่างก้าวกระโดด",
    shortLink: "/r/demo-ev-tech",
    rawLink: "https://thestandard.co",
    publishedAt: new Date().toISOString(),
  },
  {
    id: "story-3",
    title: "อัปเดตฟีเจอร์ใหม่ YouTube & AI Creator Tools ช่วยสรุปและตัดต่อวิดีโออัตโนมัติ",
    source: "YouTube Official Channel",
    kind: "youtube",
    whatHappened: "YouTube เปิดตัวชุดเครื่องมือ AI ใหม่สำหรับ Creator ช่วยสรุปไฮไลท์และแปลซับไตเติลภาษาต่างๆ ได้ทันที",
    cause: "การแข่งขันในตลาดวิดีโอสั้นและแพลตฟอร์มคอนเทนต์สูงขึ้น YouTube จึงพัฒนา AI ช่วยลดเวลาในการผลิตและตัดต่อ",
    progress: "เริ่มเปิดให้ Creator ในบางประเทศทดลองใช้งานแล้ว ก่อนจะปล่อยอัปเดตให้ใช้งานทั่วโลกเร็วๆ นี้",
    conclusion: "จะช่วยให้ผู้สร้างคอนเทนต์เข้าถึงผู้ชมต่างภาษาได้ง่ายขึ้น และสร้างสรรค์วิดีโอคุณภาพได้รวดเร็วยิ่งขึ้น",
    shortLink: "/r/demo-yt-tools",
    rawLink: "https://www.youtube.com",
    publishedAt: new Date().toISOString(),
  },
];

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const upn = searchParams.get("upn") || "user@company.com";

  return NextResponse.json({
    ok: true,
    user: upn,
    count: DEMO_STORIES.length,
    stories: DEMO_STORIES,
  });
}
