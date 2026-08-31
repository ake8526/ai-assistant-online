/**
 * แยกข้อความ "เพิ่มงาน" ที่มีหลายข้อ ออกเป็นงานทีละรายการ
 *
 * เคสจริงที่พัง: ผู้ใช้ส่ง
 *
 *   เพิ่มงาน
 *   1.สรุปไลน์ผู้ช่วย พรุ่งนี้ ผู้รับผิดชอบฉันเอง ก่อนวันนี้ 16.30
 *   2.เพิ่มUser การ์ดออนไลน์ผู้รับผิดชอบฉันเอง ก่อน17.00 วันนี้
 *   3.หาโซลูชั่นแสดงผลการ์ดชาวไร่แบบใหม่ผู้รับผิดชอบ ก่อน 17.00 วันนี้
 *
 * แล้วได้งานเดียวชื่อ "1.สรุปไลน์ผู้ช่วย พรุ่งนี้ 2.เพิ่มUser ... 3.หาโซลูชั่น ..."
 * เพราะ add_task รับ title ตัวเดียว
 *
 * ไฟล์นี้ทำแค่งานกับสตริง ไม่ import อะไรเลย เพื่อให้ทดสอบแยกได้ ส่วนการแปลง
 * ข้อความวันเวลาเป็นวันจริงยังใช้ normalizeDue ของเดิม (ไฟล์นี้คืนเป็นวลีดิบ)
 */

export type SplitTask = {
  title: string;
  responsible: string;
  /** วลีกำหนดส่งดิบ ๆ เช่น "วันนี้ 16.30" — ส่งต่อให้ normalizeDue */
  duePhrase: string;
};

/** คำสั่งขึ้นต้นที่ต้องตัดออกก่อน ไม่ให้ติดไปเป็นชื่องาน */
const LEAD = /^\s*(?:ช่วย)?\s*(?:เพิ่ม|สร้าง|บันทึก|จด)\s*(?:งาน|ทาสก์|task)s?(?:ติดตาม)?\s*(?:ให้)?\s*[:：]?\s*/i;

/** ขึ้นข้อใหม่: "1." "2)" "-" "•" ที่ต้นบรรทัด (ผู้ใช้มักไม่เว้นวรรคหลังจุด) */
const ITEM = /(?:^|\n)[ \t]*(?:\d{1,2}\s*[.)]|[-–—•*])[ \t]*/g;

/** พิมพ์ "ผู้รับผิดชอบ" ผิดได้หลายแบบ (ผุ้ / ผู / ผู้) จึงรับให้หมด */
const RESP = /ผ[ูุ]?้?\s*รับผิดชอบ\s*/;

/** คำที่บอกว่าท่อนที่เหลือคือกำหนดส่ง */
const DUE = /(?:ก่อน|ภายใน|ไม่เกิน|ให้เสร็จ|เสร็จ)\s*/;

function tidy(s: string): string {
  return s.replace(/\s+/g, " ").replace(/^[\s,.;:–—-]+|[\s,.;:–—-]+$/g, "").trim();
}

/**
 * ดึงชื่อ / ผู้รับผิดชอบ / วลีกำหนดส่ง ออกจากข้อความหนึ่งข้อ
 *
 * ลำดับสำคัญ: หากำหนดส่งจาก "ก่อน…" ก่อนเสมอ ไม่ใช่กวาดหาวันจากทั้งข้อ
 * เพราะชื่องานเองก็มีคำบอกวันได้ — "สรุปไลน์ผู้ช่วย พรุ่งนี้" คำว่าพรุ่งนี้เป็น
 * ส่วนของชื่องาน ไม่ใช่กำหนดส่ง (กำหนดส่งคือ "ก่อนวันนี้ 16.30")
 */
export function parseTaskItem(raw: string): SplitTask {
  let rest = raw.replace(/\s+/g, " ").trim();
  let duePhrase = "";
  let responsible = "";

  const dueAt = rest.search(DUE);
  if (dueAt >= 0) {
    const m = rest.slice(dueAt).match(DUE);
    duePhrase = tidy(rest.slice(dueAt + (m ? m[0].length : 0)));
    rest = rest.slice(0, dueAt);
  }

  const respAt = rest.search(RESP);
  if (respAt >= 0) {
    const m = rest.slice(respAt).match(RESP);
    responsible = tidy(rest.slice(respAt + (m ? m[0].length : 0)));
    rest = rest.slice(0, respAt);
  }

  return { title: tidy(rest), responsible, duePhrase };
}

/**
 * แยกข้อความทั้งก้อนเป็นรายการงาน
 *
 * คืน [] เมื่อไม่ใช่ข้อความหลายข้อ ให้ผู้เรียกไปใช้ทางเดิม — แยกเฉพาะตอนที่
 * ผู้ใช้ใส่เลขข้อหรือ bullet มาชัด ๆ ถ้าเดาจากการขึ้นบรรทัดเปล่า ๆ เสี่ยงจะ
 * หักงานเดียวที่พิมพ์ยาวหลายบรรทัดออกเป็นหลายงาน
 */
export function splitAddTaskItems(raw: string): SplitTask[] {
  const text = String(raw || "").replace(/\r\n?/g, "\n");
  const body = text.replace(LEAD, "");

  const parts = body
    .split(ITEM)
    .map((p) => p.trim())
    .filter((p) => p.length > 1);

  if (parts.length < 2) return [];

  return parts
    .map(parseTaskItem)
    .filter((t) => t.title.length > 0);
}
