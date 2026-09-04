/**
 * LINE chat survey (pilot) — same CORE copy as /survey, gated per-user.
 * Session lives in settings; short confirms never reach RSVP while active.
 */
import { getLineId, pushLineMessages, replyLineMessages } from "@/lib/line";
import { card, postbackRow, uriRow } from "@/lib/lineCards";
import { deleteSetting, getSetting, setSetting } from "@/lib/store";
import { insertSurveyResponse } from "@/lib/surveyResponses";

const APP_BASE = (process.env.NEXT_PUBLIC_APP_BASE_URL || "https://ktis-ai-assistant.vercel.app").replace(
  /\/$/,
  ""
);
const WEB_SURVEY_URL = `${APP_BASE}/survey`;

const SURVEY_ID = "line-short-v2";
const SESSION_KEY = "_survey_chat";
const OPS = "_ops";
const PILOT_KEY = "survey_chat_pilot";
/**
 * Optional allowlist for future mass-notify / blast only.
 * Taking the survey via /แบบสอบถาม is open to every linked user — no pilot gate.
 */
const DEFAULT_PILOTS = ["weerasak.pi@ktisgroup.com"];

export type SurveyQ = {
  id: string;
  kind: string;
  t: string;
  what: string;
  why: string;
  say: string;
  demoU: string;
  demoB: string;
};

export const SURVEY_Q: SurveyQ[] = [
  {
    "id": "q1",
    "kind": "มีอยู่แล้ว",
    "t": "ถามตารางนัดของตัวเอง",
    "what": "พิมพ์ถามปฏิทิน Outlook ของตัวเองด้วยภาษาพูด — วันนี้ พรุ่งนี้ ทั้งเดือน หรือเจาะเวลาว่า “10 โมงติดอะไร”",
    "why": "ได้อะไร: ตอบได้ทันทีว่าว่างไหม โดยไม่ต้องเปิดแอป Outlook แล้วเลื่อนหาวัน",
    "say": "ตารางวันนี้",
    "demoU": "ตารางวันนี้",
    "demoB": "🗓️ ประชุมวันนี้ (3 รายการ):\n\n  09:00-09:30 · Daily stand-up IT 💻 ออนไลน์\n  13:30-15:00 · ทบทวนงบลงทุน Q4 📍 ห้อง KTISX ชั้น 3\n  16:00-16:30 · คุยผู้รับเหมาระบบไฟฟ้า"
  },
  {
    "id": "q2",
    "kind": "มีอยู่แล้ว",
    "t": "ดูว่าคนอื่นว่างไหม",
    "what": "ถามตารางเพื่อนร่วมงานด้วยชื่อเล่น ชื่อจริง หรืออีเมล เห็นได้เท่าที่ปฏิทินเขาเปิดให้ (เท่ากับที่เปิดดูใน Outlook เองได้)",
    "why": "ได้อะไร: ไม่ต้องเดินไปถามหรือทักไลน์ถามว่าว่างไหม รู้คำตอบก่อนรบกวนเขา",
    "say": "ดูตารางเบสพรุ่งนี้",
    "demoU": "ดูตารางเบสพรุ่งนี้",
    "demoB": "🗓️ ตารางของ เบส (ณัฐกฤต) — พุธ 3 ก.ย.\n  09:00-10:00 · ประชุมฝ่ายผลิต\n  15:00-16:00 · สัมภาษณ์พนักงานใหม่\n\nช่วงที่ว่าง: 10:00-15:00 · หลัง 16:00"
  },
  {
    "id": "q3",
    "kind": "มีอยู่แล้ว",
    "t": "นัดประชุม · หาเวลาว่าง · จองห้อง",
    "what": "บอกชื่อคนกับวัน ระบบเทียบปฏิทินทุกคนแล้วเสนอช่วงว่างพร้อมกัน จองห้องประชุมที่ลงทะเบียนไว้ ส่งคำเชิญ และผู้ถูกเชิญกดรับ/ขอเลื่อนได้ใน LINE",
    "why": "ได้อะไร: ตัดงานไล่ถามว่าใครว่างเมื่อไร และจองห้องพร้อมนัดในคำสั่งเดียว",
    "say": "จองห้อง KTISX พรุ่งนี้ 10 โมง",
    "demoU": "หาเวลาที่เบสกับนนท์ว่างตรงกันวันจันทร์",
    "demoB": "🟢 ช่วงที่ว่างตรงกันทุกคน\nจันทร์ 8 ก.ย. · 3 คน"
  },
  {
    "id": "q4",
    "kind": "มีอยู่แล้ว",
    "t": "สรุปประชุมให้เอง พร้อมงานที่ต้องตาม",
    "what": "ประชุม Teams ที่เปิดถอดเสียงไว้ พอจบระบบสรุปเป็นลิงก์อ่านบนมือถือ และดึงงานที่ตกลงกันออกมาพร้อมชื่อผู้รับผิดชอบ",
    "why": "ได้อะไร: ไม่ต้องมีคนจดสรุป และงานที่คุยกันไม่หายไปพร้อมกับการปิดห้องประชุม",
    "say": "สรุปประชุม",
    "demoU": "สรุปประชุม",
    "demoB": "🧾 สรุปประชุมพร้อมแล้วครับ\n“ทบทวนงบลงทุน Q4” · 1 ชม. 28 นาที"
  },
  {
    "id": "q5",
    "kind": "มีอยู่แล้ว",
    "t": "ดูงานค้าง + ปิดงาน + ซิงค์ Microsoft To Do",
    "what": "กดปุ่มเมนู “งานที่ต้องตาม” หรือพิมพ์ “ดูงานที่ต้องติดตาม” — เห็นงานค้างทั้งหมด ปิดด้วยเลข และซิงค์กับลิสต์ To Do ชื่อ KTIS X ได้",
    "why": "ได้อะไร: เห็นงานค้างใน LINE ได้ทันที · ปิดงานบนมือถือหรือในแอป To Do ก็อัปเดตถึงกัน · ไม่ต้องมีสมุดจดอีกเล่ม",
    "say": "ดูงานที่ต้องติดตาม",
    "demoU": "ดูงานที่ต้องติดตาม",
    "demoB": "✅ งานที่ต้องติดตาม (4 งาน)\n\n1. ⚠️ ส่งตัวเลขค่าไฟไลน์ 2 — เลยกำหนด 1 วัน\n2. 🤖 ประเมินค่าลิขสิทธิ์ระบบใหม่ — ศุกร์ (เบส)\n3. ทำสลิปการประชุม — พรุ่งนี้ 17:00\n4. ตรวจสัญญา — จ. หน้า"
  },
  {
    "id": "q6",
    "kind": "มีอยู่แล้ว",
    "t": "ค้นและสรุปไฟล์ใน OneDrive",
    "what": "ค้นไฟล์จากมือถือ ให้ช่วยอ่านสรุป และผูกไฟล์ไว้กับนัดประชุม พอถึงเวลาประชุมก็เรียกอ่านได้เลย",
    "why": "ได้อะไร: หาไฟล์ได้ตอนอยู่หน้างาน และเข้าประชุมโดยรู้ว่าเอกสารเขียนว่าอะไร",
    "say": "หาไฟล์ งบ Q3",
    "demoU": "หาไฟล์ งบ Q3",
    "demoB": "📂 เจอ 2 ไฟล์\nคำค้น: งบ Q3"
  },
  {
    "id": "q7",
    "kind": "มีอยู่แล้ว",
    "t": "บรีฟเช้า — สรุปทั้งวันก่อนเริ่มงาน",
    "what": "ทุกเช้าตามเวลาที่ตั้งไว้ ระบบส่งสรุปนัดของวัน งานค้าง และงานที่เลยกำหนด มาให้เอง ไม่ต้องสั่ง",
    "why": "ได้อะไร: เปิดมือถือปุ๊บรู้ทั้งวัน ไม่ต้องไล่เปิดปฏิทินกับรายการงานทีละอัน",
    "say": "สรุปตารางเช้า",
    "demoU": "สรุปตารางเช้า",
    "demoB": "☀️ สวัสดีตอนเช้าครับ — อังคาร 2 ก.ย.\n\nวันนี้มี 3 นัด\n 09:00 Daily stand-up IT (ออนไลน์)\n 13:30 ทบทวนงบลงทุน Q4 (ห้อง KTISX ชั้น 3)\n 16:00 คุยผู้รับเหมาระบบไฟฟ้า\n\n⚠️ งานเลยกำหนด 1 งาน\nงานที่ครบกำหนดวันนี้: 1 งาน"
  },
  {
    "id": "q8",
    "kind": "มีอยู่แล้ว",
    "t": "เตือนก่อนประชุม & แจ้งเมื่อมีนัดใหม่",
    "what": "เตือนล่วงหน้าก่อนประชุมเริ่มพร้อมลิงก์เข้าห้อง และทักมาบอกเมื่อมีคนส่งนัดใหม่เข้าปฏิทินคุณ หรือนัดถูกยกเลิก",
    "why": "ได้อะไร: ไม่พลาดประชุมเพราะไม่ได้เปิดเมล และรู้ทันทีว่ามีใครมาจองเวลาทับ",
    "say": "(ระบบส่งให้เอง)",
    "demoU": "(ระบบส่งให้เอง)",
    "demoB": "🔔 อีก 15 นาทีจะถึงประชุม\n\nทบทวนงบลงทุน Q4\n🕐 13:30 - 15:00\n📍 ห้อง KTISX ชั้น 3\n📎 มีเอกสารผูกไว้ 2 ไฟล์"
  },
  {
    "id": "q9",
    "kind": "มีอยู่แล้ว",
    "t": "สรุปข่าวที่ติดตาม",
    "what": "เลือกแหล่งข่าวเอง (เว็บ · YouTube · เพจ) ระบบสรุปเป็นหัวข้อย่อยภาษาไทยส่งให้ตามเวลาที่ตั้ง",
    "why": "ได้อะไร: ตามข่าวที่เกี่ยวกับงานได้โดยไม่ต้องไล่เปิดหลายเว็บตอนเช้า",
    "say": "ข่าววันนี้",
    "demoU": "ข่าววันนี้",
    "demoB": "📰 ข่าววันนี้ — 2 เรื่องที่คุณติดตาม\n\n1) ราคาน้ำตาลทรายดิบขยับขึ้น 2.1%\n • แรงซื้อจากจีนกลับมาหลังสต๊อกลด\n\n2) ครม. เคาะช่วยเหลือชาวไร่อ้อย 8,000 ล้าน\n • จ่ายตามผลผลิตจริง เริ่มเดือนหน้า"
  },
  {
    "id": "q10",
    "kind": "ทดลองแล้ว",
    "t": "สั่งงานด้วยเสียง",
    "what": "อัดเสียงส่งเข้า LINE แทนการพิมพ์ ระบบถอดเสียง ให้ตรวจก่อน แล้วทำตามคำสั่ง — ยังไม่เปิดใน LINE OA (webhook ยังไม่รับไฟล์เสียง)",
    "why": "ได้อะไรถ้าเปิด: คนหน้างาน/ในรถสั่งงานได้โดยไม่พิมพ์ไทยยาว ๆ\nสถานะจริง: ทดลองกับโมเดลแล้ว — ประโยคสั่งงานไทย 3 ประโยค ถอดตรง 3/3 และแยก intent ได้ · ยังไม่ได้ต่อเข้า LINE และยังไม่ทดสอบเสียงคนจริงในที่ดัง",
    "say": "🎙 (ข้อความเสียง) — ยังใช้ใน LINE ไม่ได้",
    "demoU": "🎙 ข้อความเสียง 0:06",
    "demoB": "ถอดเสียงได้ว่า:\n“เพิ่มงานส่งรายงานค่าไฟให้เบส ศุกร์นี้ห้าโมงเย็น”\nถูกต้องไหมครับ\n\n(⚠️ ตัวอย่างเมื่อเปิดใช้แล้ว — ตอนนี้ส่งเสียงใน LINE ยังไม่ทำงาน)"
  },
  {
    "id": "q12",
    "kind": "ทดลองแล้ว",
    "t": "ถาม-ตอบระเบียบและคู่มือภายในองค์กร",
    "what": "เอาระเบียบบริษัท คู่มือ HR เข้าคลัง แล้วถามเป็นภาษาพูด — ยังไม่มีคลังเอกสารในระบบ มีแค่การทดลองโมเดลกับเอกสารตัวอย่าง",
    "why": "ได้อะไรถ้าเปิด: ไม่ต้องโทรถาม HR/IT เรื่องเดิมซ้ำ ๆ ได้คำตอบอ้างอิงหน้าเอกสาร\nสถานะจริง: ทดลองใส่ระเบียบเบิกค่าเดินทางแล้วถาม 4 ข้อ — ตอบถูก+อ้างข้อ 3/3 และข้อนอกเอกสารตอบว่าไม่พบ (ไม่มั่ว) · งานจริงคือรวบรวมเอกสารและอัปเดตคลัง",
    "say": "เบิกค่าเดินทางใช้เอกสารอะไรบ้าง — ยังไม่มีใน LINE",
    "demoU": "เบิกค่าเดินทางใช้เอกสารอะไรบ้าง",
    "demoB": "📚 ตามระเบียบการเบิกจ่าย (ปรับปรุง 2567) ข้อ 4.2\n\nต้องแนบ\n • ใบเสร็จรับเงินตัวจริง\n • แบบฟอร์ม กจ.03 ที่หัวหน้างานเซ็น\n • สำเนาใบอนุญาตเดินทาง (กรณีข้ามจังหวัด)\n\nยื่นภายใน 15 วันนับจากวันเดินทางกลับ\n🔗 ระเบียบการเบิกจ่าย_2567.pdf หน้า 12\n\n(⚠️ ตัวอย่างเมื่อมีคลังเอกสารแล้ว — ตอนนี้ยังไม่มีในระบบ)"
  },
  {
    "id": "b1",
    "kind": "ทดลองแล้ว",
    "t": "ถ่ายรูปเอกสาร แล้วให้กลายเป็นงาน",
    "what": "ถ่ายใบสั่งงานหรือไวท์บอร์ด ระบบอ่านตัวอักษรแล้วเปลี่ยนเป็นรายการงาน — ยังไม่เปิด (ส่งรูปใน LINE ตอนนี้ใช้แนบเข้านัด ไม่ได้อ่าน OCR สร้างงาน)",
    "why": "ได้อะไรถ้าเปิด: กระดาษหน้างานเข้าระบบได้เลย ไม่ต้องคีย์ใหม่\nสถานะจริง: ทดลองโมเดลอ่านใบสั่งงานไทยได้ครบ 4/4 แถวแม้ภาพเอียง · แสงน้อย+เบลออาจเพี้ยนชื่อสั้น ๆ จึงต้องให้ตรวจก่อนยืนยัน · ยังไม่ได้ต่อเข้า LINE เป็นฟีเจอร์นี้",
    "say": "📷 (รูปถ่าย) — ยังไม่สร้างงานจากรูป",
    "demoU": "📷 [รูปถ่าย] ไวท์บอร์ดสรุปงาน.jpg",
    "demoB": "อ่านข้อความในรูปได้ 6 บรรทัด — จะให้ทำอะไรดีครับ\n\n(⚠️ ตัวอย่างเมื่อเปิดใช้แล้ว — ตอนนี้ส่งรูป = แนบเข้านัดเท่านั้น)"
  },
  {
    "id": "b4",
    "kind": "มีอยู่แล้ว",
    "t": "“วันนี้ไปไม่ไหว” — จัดการนัดทั้งวันทีเดียว",
    "what": "บอกครั้งเดียวว่าวันนี้ไปไม่ไหว ระบบยกนัดของวันนี้ที่มีคนอื่นเกี่ยวข้องมาให้ดูก่อน แล้วเลือกได้ว่าจะ “แจ้งอย่างเดียว” หรือ “ยกเลิกนัดที่คุณเป็นผู้จัดด้วย”",
    "why": "ได้อะไร: ตอนป่วยไม่ต้องไล่แจ้งทีละคน ไม่มีใครนั่งรอเก้อ · ทวนให้ดูก่อนเสมอ ยังไม่แตะอะไรจนกว่าจะกดยืนยัน",
    "say": "วันนี้ลาป่วย จัดการนัดให้ที",
    "demoU": "วันนี้ลาป่วย จัดการนัดให้ที",
    "demoB": "🤒 วันนี้มี 2 นัดที่มีคนอื่นเกี่ยวข้อง\n\n1) 13:30-15:00 · ทบทวนงบลงทุน Q4 — คุณเป็นผู้จัด (แจ้ง 2 คน)\n2) 16:00-16:30 · ตรวจรับงานระบบไฟฟ้า — คุณเป็นผู้เข้าร่วม (แจ้ง 1 คน)\n\nจะแจ้งทั้งหมด 3 คน · ยกเลิกได้ 1 นัดที่คุณเป็นผู้จัด\nยังไม่ได้ทำอะไรจนกว่าจะกดยืนยันครับ"
  },
  {
    "id": "b7",
    "kind": "มีอยู่แล้ว",
    "t": "สรุป “ตอนที่คุณไม่อยู่”",
    "what": "กลับจากลา ประชุมยาว หรือออกต่างจังหวัด — พิมพ์ครั้งเดียวได้ครบว่าช่วงที่ไม่อยู่มีอะไรเกิดขึ้น: ประชุมที่พลาดพร้อมสรุป งานใหม่ที่ถูกมอบให้ นัดที่เข้ามาใหม่ และอะไรเลยกำหนดไปแล้ว",
    "why": "ได้อะไร: ทุกวันนี้ระบบทักมาบอกทีละเรื่องตอนที่มันเกิด ถ้าไม่ได้เปิดไลน์ตอนนั้นก็เลื่อนผ่านไปแล้ว — อันนี้คือปุ่ม “ตามให้ที” ที่ไม่ต้องไล่หาเอง",
    "say": "ช่วงที่ผมไม่อยู่มีอะไรบ้าง",
    "demoU": "ช่วง 3 วันที่ผมไม่อยู่ มีอะไรบ้าง",
    "demoB": "📋 สรุปช่วง 1-3 ก.ย. ที่คุณไม่อยู่\n\n🗓 ประชุมที่พลาด 2 นัด\n • ทบทวนงบลงทุน Q4 (1 ก.ย.) — มีสรุปแล้ว\n • Kick-off ระบบ WMS (2 ก.ย.) — มีสรุปแล้ว\n\n✅ งานใหม่ที่ถูกมอบให้คุณ 2 งาน\n • ส่งตัวเลขค่าไฟไลน์ 2 — เลยกำหนด 1 วัน ⚠️\n • ทำสไลด์เปรียบเทียบผู้ขาย — 8 ก.ย.\n\n📥 นัดใหม่ที่เข้ามา 1 นัด\n • ประชุมด่วนแผนรับมือฝนตกหนัก — พรุ่งนี้ 08:30"
  },
  {
    "id": "b6",
    "kind": "มีอยู่แล้ว",
    "t": "รายงานสรุปประจำสัปดาห์",
    "what": "สั่งดูเมื่อไรก็ได้ด้วย “สรุปสัปดาห์นี้” หรือเปิดสวิตช์ครั้งเดียวให้ส่งเองทุกศุกร์ 17:00 — ประชุมไปกี่ชั่วโมง งานที่ครบกำหนดปิดไปแล้วกี่ใบ ค้างกี่ใบ และสัปดาห์หน้าหนักวันไหน",
    "why": "ได้อะไร: เห็นภาพรวมของตัวเองโดยไม่ต้องทำรายงานเอง และรู้ล่วงหน้าว่าสัปดาห์หน้าแน่นแค่ไหน",
    "say": "สรุปสัปดาห์นี้",
    "demoU": "สรุปสัปดาห์นี้",
    "demoB": "📈 สรุปสัปดาห์นี้ (31/08/2569 – 04/09/2569)\n\n🗓 ประชุม 11 นัด · รวม 14 ชม. 20 นาที\n✅ งานที่ครบกำหนดช่วงนี้ 5 งาน — ปิดแล้ว 3 · ยังค้าง 2 ⚠️\n📌 ตอนนี้ค้างอยู่ 4 งาน (เกินกำหนด 1 ⚠️)\n📤 มอบให้คนอื่นแล้วยังค้าง 2 งาน · 1 คน\n🕰 ค้างนานสุด: “ส่งตัวเลขค่าไฟไลน์ 2” (9 วัน)\n\n— ช่วงถัดไป —\n🗓 มีนัดแล้ว 6 นัด\n   หนักสุด วันอังคาร 08/09/2569 (3 นัด)\n✅ งานครบกำหนด 2 งาน"
  }
];

const SCALE = [
  { v: 5, e: "🔥", t: "อยากได้มากที่สุด", s: "รีบทำอันนี้ให้จบก่อนเลย" },
  { v: 4, e: "👍", t: "ชอบ อยากได้", s: "ได้ใช้กับงานที่ทำอยู่แน่" },
  { v: 3, e: "🙂", t: "มีก็ดี", s: "ใช้บ้างเป็นครั้งคราว" },
  { v: 2, e: "🤔", t: "เฉย ๆ", s: "ยังไม่เห็นภาพว่าจะใช้ตอนไหน" },
  { v: 1, e: "🙅", t: "ไม่ต้องมีก็ได้", s: "ไม่เกี่ยวกับงานผม" },
  { v: 0, e: "⛔", t: "ไม่มีดีกว่า", s: "มีแล้วรกเปล่า ๆ อย่าทำเลย" },
] as const;

function scaleLabel(s: (typeof SCALE)[number]): string {
  return `${s.e} ${s.t}`;
}

type Phase = "intro" | "channel" | "try" | "rate" | "star" | "done";

type Session = {
  phase: Phase;
  idx: number;
  answers: Record<string, number>;
  star: string | null;
  ts: number;
};

const SURVEY_ACTIONS = new Set([
  "svstart",
  "svline",
  "svweb",
  "svtry",
  "svskip",
  "svrate",
  "svstar",
  "svsubmit",
  "svcancel",
  "svagain",
]);

export function isSurveyAction(act: string): boolean {
  return SURVEY_ACTIONS.has(act);
}

function clip(s: string, n: number): string {
  const t = String(s || "");
  return t.length <= n ? t : t.slice(0, n - 1) + "…";
}

function statusLine(kind: string): string {
  if (kind === "ทดลองแล้ว") return "🧪 ทดลองโมเดลแล้ว — ยังไม่เปิดใน LINE";
  if (kind === "ข้อเสนอ" || kind === "ไอเดียใหม่") return "💡 ข้อเสนอ — ยังไม่มีในระบบ";
  return "✅ มีแล้ว ใช้ได้เลยใน LINE";
}

function statusBadge(kind: string): object {
  const text = statusLine(kind);
  const proto = kind === "ทดลองแล้ว";
  const idea = kind === "ข้อเสนอ" || kind === "ไอเดียใหม่";
  return {
    type: "box",
    layout: "vertical",
    backgroundColor: proto ? "#fff7ed" : idea ? "#eef2ff" : "#e8f8ee",
    cornerRadius: "999px",
    paddingAll: "6px",
    margin: "none",
    contents: [
      {
        type: "text",
        text,
        size: "xxs",
        color: proto ? "#c2410c" : idea ? "#4338ca" : "#06753a",
        weight: "bold",
        wrap: true,
        align: "center",
      },
    ],
  };
}

function flexMsg(
  altText: string,
  contents: object,
  extraQr?: { label: string; data: string; displayText?: string }[]
): object {
  return {
    type: "flex",
    altText: altText.slice(0, 400),
    contents,
    quickReply: qr([
      ...(extraQr || []),
      { label: "ยกเลิกสำรวจ", data: "a=svcancel", displayText: "ยกเลิกแบบสำรวจ" },
    ]),
  };
}

function qr(
  items: { label: string; data?: string; message?: string; displayText?: string }[]
) {
  return {
    items: items.slice(0, 13).map((it) => {
      if (it.message) {
        return {
          type: "action",
          action: {
            type: "message",
            label: it.label.slice(0, 20),
            text: it.message.slice(0, 300),
          },
        };
      }
      return {
        type: "action",
        action: {
          type: "postback",
          label: it.label.slice(0, 20),
          data: (it.data || "").slice(0, 300),
          displayText: (it.displayText || it.label).slice(0, 60),
        },
      };
    }),
  };
}

async function pilotList(): Promise<string[]> {
  const raw = await getSetting(OPS, PILOT_KEY);
  let extra: string[] = [];
  if (raw) {
    try {
      const list = JSON.parse(raw) as unknown;
      if (Array.isArray(list)) extra = list.map((x) => String(x).toLowerCase());
    } catch {
      /* ignore */
    }
  }
  return [...new Set([...DEFAULT_PILOTS, ...extra].map((u) => u.toLowerCase()))];
}

export async function isSurveyPilot(upn: string): Promise<boolean> {
  return (await pilotList()).includes((upn || "").toLowerCase());
}

export async function setSurveyPilots(upns: string[]): Promise<string[]> {
  const clean = [
    ...new Set(upns.map((u) => u.trim().toLowerCase()).filter((u) => u.includes("@"))),
  ];
  await setSetting(OPS, PILOT_KEY, JSON.stringify(clean));
  return clean;
}

async function loadSession(upn: string): Promise<Session | null> {
  const raw = await getSetting(upn.toLowerCase(), SESSION_KEY);
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as Session;
    if (!o || typeof o.phase !== "string") return null;
    // expire after 2 days
    if (o.ts && Date.now() - o.ts > 2 * 24 * 60 * 60 * 1000) {
      await clearSession(upn);
      return null;
    }
    return o;
  } catch {
    return null;
  }
}

async function saveSession(upn: string, s: Session): Promise<void> {
  await setSetting(upn.toLowerCase(), SESSION_KEY, JSON.stringify({ ...s, ts: Date.now() }));
}

async function clearSession(upn: string): Promise<void> {
  try {
    await deleteSetting(upn.toLowerCase(), SESSION_KEY);
  } catch {
    /* ignore */
  }
}

export async function hasActiveSurvey(upn: string): Promise<boolean> {
  return !!(await loadSession(upn));
}

async function send(
  via: "push" | "reply",
  upn: string,
  messages: object[],
  replyToken?: string
): Promise<void> {
  noteSurveyLog(summarizeMessages(messages));
  if (via === "reply" && replyToken) {
    await replyLineMessages(replyToken, messages.slice(0, 5));
    return;
  }
  const lineId = await getLineId(upn);
  if (!lineId) throw new Error("ยังไม่ได้เชื่อม LINE");
  await pushLineMessages(lineId, messages.slice(0, 5));
}

/** Readable label for monitor/chat_logs when user taps a survey postback. */
export function surveyActionLabel(act: string, data: URLSearchParams): string | null {
  switch (act) {
    case "svstart":
      return "เริ่มสำรวจ";
    case "svcancel":
      return "ยกเลิกแบบสำรวจ";
    case "svline":
      return "ตอบในแชท LINE";
    case "svweb":
      return "เปิดแบบบนเว็บ";
    case "svtry":
      return "ลองคำสั่งตัวอย่าง";
    case "svskip":
      return "ให้คะแนนเลย";
    case "svsubmit":
      return "ส่งคำตอบแบบสำรวจ";
    case "svagain":
      return "เริ่มสำรวจใหม่";
    case "svrate": {
      const v = parseInt(data.get("v") || "", 10);
      const s = SCALE.find((x) => x.v === v);
      return s ? `ให้คะแนน: ${scaleLabel(s)}` : `ให้คะแนน: ${data.get("v") || "?"}`;
    }
    case "svstar": {
      const id = decodeURIComponent(data.get("id") || "");
      const q = SURVEY_Q.find((x) => x.id === id);
      return q ? `เลือกดาว: ${q.t}` : "เลือกดาว";
    }
    default:
      return null;
  }
}

let lastSurveyLog = "";

function resetSurveyLog() {
  lastSurveyLog = "";
}

function noteSurveyLog(s: string) {
  const t = (s || "").trim();
  if (!t) return;
  lastSurveyLog = lastSurveyLog ? `${lastSurveyLog}\n——\n${t}` : t;
}

/** Consume the last survey reply summary for chat_logs. */
export function takeSurveyLog(): string {
  const s = lastSurveyLog.trim() || "(แบบสำรวจ LINE)";
  lastSurveyLog = "";
  return s.slice(0, 4000);
}

function summarizeMessages(messages: object[]): string {
  const parts: string[] = [];
  for (const raw of messages) {
    const m = raw as {
      type?: string;
      text?: string;
      altText?: string;
      contents?: unknown;
      template?: { text?: string; type?: string };
    };
    if (m.type === "text" && m.text) {
      parts.push(m.text);
      continue;
    }
    if (m.type === "flex") {
      parts.push(summarizeFlex(m.altText || "", m.contents));
      continue;
    }
    if (m.type === "template") {
      parts.push(m.altText || m.template?.text || "[ปุ่มลิงก์]");
      continue;
    }
  }
  return parts.join("\n\n");
}

function summarizeFlex(altText: string, contents: unknown): string {
  const c = contents as {
    header?: { contents?: { text?: string }[] };
    body?: { contents?: unknown };
  } | null;
  if (!c) return altText || "[การ์ด]";
  const title = c.header?.contents?.[0]?.text || altText || "การ์ด";
  const sub = c.header?.contents?.[1]?.text || "";
  const texts: string[] = [];
  const walk = (node: unknown) => {
    if (!node) return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (typeof node !== "object") return;
    const o = node as { type?: string; text?: string; contents?: unknown };
    if (o.type === "text" && o.text) texts.push(o.text);
    if (o.contents) walk(o.contents);
  };
  walk(c.body?.contents);
  const uniq = [...new Set(texts)].slice(0, 14);
  return [`[การ์ด] ${title}`, sub, ...uniq].filter(Boolean).join("\n");
}

function introMessage(): object {
  return {
    type: "text",
    text:
      "สวัสดีครับ 🙏\n" +
      "ขอรบกวนตอบแบบสำรวจสั้น ๆ ว่าอยากได้ฟังก์ชันไหนใน LINE มากที่สุด\n\n" +
      `ประมาณ ${SURVEY_Q.length} ข้อ · ลองดูตัวอย่างคำสั่งก่อน แล้วค่อยให้คะแนน\n\n` +
      "กด “เริ่มสำรวจ” ได้เลยครับ (หรือพิมพ์ ยกเลิกแบบสำรวจ เพื่อออก)",
    quickReply: qr([
      { label: "เริ่มสำรวจ", data: "a=svstart", displayText: "เริ่มสำรวจ" },
      { label: "ยกเลิก", data: "a=svcancel", displayText: "ยกเลิกแบบสำรวจ" },
    ]),
  };
}

function channelMessage(): object {
  const rows: object[] = [];
  const lineRow = postbackRow(
    "💬 ตอบในแชท LINE",
    "a=svline",
    "ตอบในแชท LINE",
    "ลองคำสั่งตัวอย่าง + ให้คะแนนในแชทนี้"
  );
  const webUri = uriRow("🌐 เปิดแบบบนเว็บ", WEB_SURVEY_URL, "หน้าเว็บเต็ม · มีเดโมเลื่อนอัตโนมัติ");
  const webPb = postbackRow(
    "ส่งลิงก์เว็บมาในแชท",
    "a=svweb",
    "เปิดแบบบนเว็บ",
    WEB_SURVEY_URL.replace(/^https?:\/\//, "").slice(0, 40)
  );
  if (lineRow) rows.push(lineRow);
  if (webUri) rows.push(webUri);
  if (webPb) rows.push(webPb);
  return flexMsg(
    "เลือกช่องทางทำแบบสำรวจ",
    card("เลือกช่องทางทำแบบสำรวจ", "เลือกอย่างใดอย่างหนึ่งได้เลย", rows),
    [
      { label: "💬 แชท LINE", data: "a=svline", displayText: "ตอบในแชท LINE" },
      { label: "🌐 เปิดเว็บ", data: "a=svweb", displayText: "เปิดแบบบนเว็บ" },
    ]
  );
}

function webLinkMessage(): object {
  return {
    type: "template",
    altText: "เปิดแบบสำรวจบนเว็บ",
    template: {
      type: "buttons",
      text: "เปิดแบบสำรวจบนเว็บได้ที่ปุ่มด้านล่างครับ — ทำเสร็จแล้วกลับมาใช้คำสั่งในแชทได้ปกติ",
      actions: [{ type: "uri", label: "เปิดแบบบนเว็บ", uri: WEB_SURVEY_URL }],
    },
  };
}

async function askChannel(upn: string, via: "push" | "reply", replyToken?: string): Promise<void> {
  const sess: Session = { phase: "channel", idx: 0, answers: {}, star: null, ts: Date.now() };
  await saveSession(upn, sess);
  await send(
    via,
    upn,
    [
      { type: "text", text: "ต้องการทำแบบสำรวจผ่านช่องทางไหนครับ?" },
      channelMessage(),
    ],
    replyToken
  );
}

function tryMessage(q: SurveyQ, idx: number): object {
  const cmd = (q.say || q.demoU || "ลองคำสั่ง").slice(0, 40);
  const rows: object[] = [
    statusBadge(q.kind),
    {
      type: "text",
      text: clip(q.what, 400),
      size: "sm",
      color: "#111111",
      wrap: true,
      margin: "md",
    },
  ];
  if (q.why) {
    rows.push({
      type: "text",
      text: clip(q.why, 350),
      size: "xs",
      color: "#555555",
      wrap: true,
      margin: "sm",
    });
  }
  rows.push({ type: "separator", margin: "lg" });
  const tryRow = postbackRow(
    clip("➤ " + cmd, 40),
    "a=svtry",
    cmd,
    "ตัวอย่างจำลอง — ไม่สั่งงานจริง"
  );
  const skipRow = postbackRow("ให้คะแนนเลย", "a=svskip", "ให้คะแนนเลย");
  if (tryRow) rows.push(tryRow);
  if (skipRow) rows.push(skipRow);
  return flexMsg(
    `ข้อ ${idx + 1}/${SURVEY_Q.length} · ${q.t}`,
    card(`ข้อ ${idx + 1}/${SURVEY_Q.length}`, q.t, rows)
  );
}

function rateMessage(q: SurveyQ, idx: number): object {
  const rows: object[] = [statusBadge(q.kind)];
  for (const s of SCALE) {
    const row = postbackRow(scaleLabel(s), `a=svrate&v=${s.v}`, scaleLabel(s), s.s);
    if (row) rows.push(row);
  }
  return flexMsg(
    `ข้อ ${idx + 1}/${SURVEY_Q.length} · ให้คะแนน · ${q.t}`,
    card(`ข้อ ${idx + 1}/${SURVEY_Q.length} · ให้คะแนน`, q.t, rows)
  );
}

function starMessage(sess: Session): object {
  const scored = SURVEY_Q.filter((q) => q.id in sess.answers).sort(
    (a, b) => (sess.answers[b.id] ?? 0) - (sess.answers[a.id] ?? 0)
  );
  const max = Math.max(0, ...scored.map((q) => sess.answers[q.id] ?? 0));
  const elig = scored.filter((q) => (sess.answers[q.id] ?? 0) === max && max > 0);
  if (!elig.length) {
    const again = postbackRow("เริ่มใหม่", "a=svagain", "เริ่มสำรวจใหม่");
    return flexMsg(
      "เลือกดาว",
      card("เลือกดาว", "ยังไม่มีคะแนน", again ? [again] : [])
    );
  }
  const rows: object[] = [];
  for (const q of elig.slice(0, 12)) {
    const row = postbackRow(
      clip("⭐ " + q.t, 40),
      `a=svstar&id=${encodeURIComponent(q.id)}`,
      "⭐ " + q.t,
      `คะแนน ${sess.answers[q.id]}`
    );
    if (row) rows.push(row);
  }
  return flexMsg(
    `เลือกเรื่องที่อยากให้ทำก่อน (คะแนน ${max})`,
    card("เลือก 1 เรื่องที่อยากให้ทำก่อน", `เฉพาะเรื่องที่ได้คะแนนสูงสุด (${max})`, rows)
  );
}

function doneMessage(sess: Session): object {
  const n = Object.keys(sess.answers).length;
  const starQ = SURVEY_Q.find((x) => x.id === sess.star);
  return {
    type: "text",
    text:
      `สรุปแล้ว ${n} ข้อ` +
      (starQ ? `\n⭐ ทำก่อน: ${starQ.t}` : "") +
      "\n\nกด “ส่งคำตอบ” เพื่อบันทึกครับ",
    quickReply: qr([
      { label: "ส่งคำตอบ", data: "a=svsubmit", displayText: "ส่งคำตอบ" },
      { label: "ตอบใหม่", data: "a=svagain", displayText: "ตอบใหม่" },
      { label: "ยกเลิก", data: "a=svcancel", displayText: "ยกเลิกแบบสำรวจ" },
    ]),
  };
}

async function askTry(upn: string, via: "push" | "reply", replyToken?: string): Promise<void> {
  let sess = (await loadSession(upn)) || {
    phase: "try" as Phase,
    idx: 0,
    answers: {},
    star: null,
    ts: Date.now(),
  };
  if (sess.idx >= SURVEY_Q.length) {
    sess.phase = "star";
    await saveSession(upn, sess);
    await send(via, upn, [starMessage(sess)], replyToken);
    return;
  }
  sess.phase = "try";
  await saveSession(upn, sess);
  const q = SURVEY_Q[sess.idx]!;
  await send(via, upn, [tryMessage(q, sess.idx)], replyToken);
}

async function askRate(upn: string, via: "push" | "reply", replyToken?: string): Promise<void> {
  const sess = await loadSession(upn);
  if (!sess || sess.idx >= SURVEY_Q.length) {
    await askTry(upn, via, replyToken);
    return;
  }
  sess.phase = "rate";
  await saveSession(upn, sess);
  const q = SURVEY_Q[sess.idx]!;
  await send(via, upn, [rateMessage(q, sess.idx)], replyToken);
}

/** Start or re-show intro — open to every linked user (opt-in via command; no blast). */
export async function startLineSurvey(
  upn: string,
  via: "push" | "reply" = "push",
  replyToken?: string
): Promise<string> {
  resetSurveyLog();
  const sess: Session = { phase: "intro", idx: 0, answers: {}, star: null, ts: Date.now() };
  await saveSession(upn, sess);
  await send(via, upn, [introMessage()], replyToken);
  return takeSurveyLog();
}

/** Push invite to a specific user (manual/script only — not a mass notify). */
export async function pushSurveyInvite(upn: string): Promise<void> {
  await startLineSurvey(upn, "push");
}

function isCancelText(text: string): boolean {
  return /^(ยกเลิกแบบสำรวจ|ยกเลิกสำรวจ|ล้างแบบสำรวจ|ยกเลิกการสำรวจ)$/i.test(text.trim());
}

function isStartText(text: string): boolean {
  return /^(เริ่มสำรวจ|แบบสำรวจ|สำรวจline|สำรวจ LINE)$/i.test(text.trim());
}

/**
 * Text handler — call early (before RSVP) when pilot starts, or whenever session is active.
 * Returns assistant log text if consumed, otherwise null.
 */
export async function handleLineSurveyText(
  upn: string,
  text: string,
  replyToken: string
): Promise<string | null> {
  resetSurveyLog();
  const t = (text || "").trim();
  if (!t) return null;

  if (isCancelText(t)) {
    const sess = await loadSession(upn);
    if (!sess) return null;
    await clearSession(upn);
    await send("reply", upn, [{ type: "text", text: "ยกเลิกแบบสำรวจแล้วครับ — กลับไปใช้คำสั่งปกติได้เลย" }], replyToken);
    return takeSurveyLog();
  }

  if (isStartText(t)) {
    const sess: Session = { phase: "channel", idx: 0, answers: {}, star: null, ts: Date.now() };
    await saveSession(upn, sess);
    await askChannel(upn, "reply", replyToken);
    return takeSurveyLog();
  }

  const sess = await loadSession(upn);
  if (!sess) return null;
  // Active survey: don't leak into RSVP / booking / LLM
  if (sess.phase === "intro") {
    await send("reply", upn, [introMessage()], replyToken);
    return takeSurveyLog();
  }
  if (sess.phase === "channel") {
    // User may have opened web via URI — don't trap free-text forever
    await send("reply", upn, [channelMessage()], replyToken);
    return takeSurveyLog();
  }
  if (sess.phase === "try") {
    const q = SURVEY_Q[sess.idx];
    if (q) await send("reply", upn, [tryMessage(q, sess.idx)], replyToken);
    else await askTry(upn, "reply", replyToken);
    return takeSurveyLog();
  }
  if (sess.phase === "rate") {
    const q = SURVEY_Q[sess.idx];
    if (q) await send("reply", upn, [rateMessage(q, sess.idx)], replyToken);
    else await askRate(upn, "reply", replyToken);
    return takeSurveyLog();
  }
  if (sess.phase === "star") {
    await send("reply", upn, [starMessage(sess)], replyToken);
    return takeSurveyLog();
  }
  if (sess.phase === "done") {
    await send("reply", upn, [doneMessage(sess)], replyToken);
    return takeSurveyLog();
  }
  return takeSurveyLog();
}

export async function handleLineSurveyPostback(
  upn: string,
  data: URLSearchParams,
  replyToken: string
): Promise<string> {
  resetSurveyLog();
  const act = data.get("a") || "";

  if (act === "svcancel") {
    await clearSession(upn);
    await send("reply", upn, [{ type: "text", text: "ยกเลิกแบบสำรวจแล้วครับ" }], replyToken);
    return takeSurveyLog();
  }

  if (act === "svagain") {
    await clearSession(upn);
    await startLineSurvey(upn, "reply", replyToken);
    return takeSurveyLog();
  }

  if (act === "svstart") {
    await askChannel(upn, "reply", replyToken);
    return takeSurveyLog();
  }

  if (act === "svline") {
    const sess: Session = { phase: "try", idx: 0, answers: {}, star: null, ts: Date.now() };
    await saveSession(upn, sess);
    await send(
      "reply",
      upn,
      [
        {
          type: "text",
          text: "โอเคครับ — ทำในแชทนี้เลย\nแต่ละข้อจะให้ลองคำสั่งตัวอย่างก่อน แล้วค่อยให้คะแนน",
        },
      ],
      replyToken
    );
    await askTry(upn, "push");
    return takeSurveyLog();
  }

  if (act === "svweb") {
    await clearSession(upn);
    await send(
      "reply",
      upn,
      [
        {
          type: "text",
          text: "เปิดแบบสำรวจบนเว็บได้ที่ปุ่มด้านล่างครับ\nทำเสร็จแล้วกลับมาใช้คำสั่งในแชทได้ปกติ",
        },
        webLinkMessage(),
      ],
      replyToken
    );
    return takeSurveyLog();
  }

  let sess = await loadSession(upn);
  if (!sess) {
    await startLineSurvey(upn, "reply", replyToken);
    return takeSurveyLog();
  }

  if (act === "svtry") {
    const q = SURVEY_Q[sess.idx];
    if (!q) {
      await askTry(upn, "reply", replyToken);
      return takeSurveyLog();
    }
    const demoCmd = q.demoU || q.say || "ตัวอย่างคำสั่ง";
    const demoAns = clip(q.demoB || "(ตัวอย่าง)", 4500);
    await send(
      "reply",
      upn,
      [
        {
          type: "text",
          text: clip(`ตัวอย่าง (จำลอง):\nคุณพิมพ์ → ${demoCmd}\n\nผู้ช่วยตอบ:\n${demoAns}`, 4900),
        },
      ],
      replyToken
    );
    // follow-up rate via push (reply token already used)
    await askRate(upn, "push");
    return takeSurveyLog();
  }

  if (act === "svskip") {
    await askRate(upn, "reply", replyToken);
    return takeSurveyLog();
  }

  if (act === "svrate") {
    const v = parseInt(data.get("v") || "", 10);
    if (!Number.isFinite(v) || v < 0 || v > 5) {
      await askRate(upn, "reply", replyToken);
      return takeSurveyLog();
    }
    const q = SURVEY_Q[sess.idx];
    if (!q) {
      await askTry(upn, "reply", replyToken);
      return takeSurveyLog();
    }
    sess.answers[q.id] = v;
    sess.idx += 1;
    await saveSession(upn, sess);
    const ack =
      v >= 5 ? "รับทราบครับ — อยากได้มาก 🔥" : v >= 4 ? "จดไว้แล้วครับ 👍" : v <= 0 ? "โอเคครับ จะไม่เร่งอันนี้" : "รับทราบครับ";
    const scored = `${ack}\n(บันทึก: ข้อ ${q.id} · ${q.t} → ${v}/5)`;
    if (sess.idx >= SURVEY_Q.length) {
      sess.phase = "star";
      await saveSession(upn, sess);
      await send("reply", upn, [{ type: "text", text: scored + "\nเหลือเลือกดาวอีกนิดเดียว" }, starMessage(sess)], replyToken);
      return takeSurveyLog();
    }
    await send("reply", upn, [{ type: "text", text: scored + "\nต่อไปข้อถัดไป…" }], replyToken);
    await askTry(upn, "push");
    return takeSurveyLog();
  }

  if (act === "svstar") {
    const id = decodeURIComponent(data.get("id") || "");
    if (!SURVEY_Q.some((q) => q.id === id)) {
      await send("reply", upn, [starMessage(sess)], replyToken);
      return takeSurveyLog();
    }
    sess.star = id;
    sess.phase = "done";
    await saveSession(upn, sess);
    await send("reply", upn, [doneMessage(sess)], replyToken);
    return takeSurveyLog();
  }

  if (act === "svsubmit") {
    await submitSession(upn, sess, replyToken);
    return takeSurveyLog();
  }

  // unknown — re-prompt
  if (sess.phase === "channel") await askChannel(upn, "reply", replyToken);
  else if (sess.phase === "try") await askTry(upn, "reply", replyToken);
  else if (sess.phase === "rate") await askRate(upn, "reply", replyToken);
  else if (sess.phase === "star") await send("reply", upn, [starMessage(sess)], replyToken);
  else if (sess.phase === "done") await send("reply", upn, [doneMessage(sess)], replyToken);
  else await startLineSurvey(upn, "reply", replyToken);
  return takeSurveyLog();
}

async function submitSession(upn: string, sess: Session, replyToken: string): Promise<void> {
  if (!Object.keys(sess.answers).length) {
    await send("reply", upn, [{ type: "text", text: "ยังไม่มีคำตอบให้ส่งครับ" }], replyToken);
    return;
  }
  const labels: Record<string, string> = {};
  const kinds: Record<string, string> = {};
  for (const q of SURVEY_Q) {
    labels[q.id] = q.t;
    kinds[q.id] = q.kind;
  }
  try {
    const saved = await insertSurveyResponse({
      survey_id: SURVEY_ID,
      name: upn.split("@")[0] || upn,
      dept: null,
      role_title: null,
      note: "(ส่งจาก LINE แชท)",
      star_id: sess.star,
      answers: sess.answers,
      comments: {},
      meta: {
        channel: "line",
        upn,
        labels,
        kinds,
        pilot: true,
      },
    });
    await clearSession(upn);
    await send(
      "reply",
      upn,
      [
        {
          type: "text",
          text:
            "✅ ส่งเรียบร้อยแล้ว ขอบคุณมากครับ" +
            (saved.id ? `\nรหัส ${String(saved.id).slice(0, 8)}…` : "") +
            "\n\nกลับไปใช้คำสั่งปกติได้เลย",
        },
      ],
      replyToken
    );
  } catch (e) {
    await send(
      "reply",
      upn,
      [
        {
          type: "text",
          text: "ส่งไม่สำเร็จ: " + String((e as Error).message || e).slice(0, 80),
          quickReply: qr([{ label: "ส่งอีกครั้ง", data: "a=svsubmit", displayText: "ส่งคำตอบ" }]),
        },
      ],
      replyToken
    );
  }
}
