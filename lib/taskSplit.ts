/**
 * แยกข้อความ "เพิ่มงาน" ที่มีหลายข้อ ออกเป็นงานทีละรายการ
 *
 * เคสจริงที่พัง (chat_logs 31 ส.ค. 2026 16:15 ทาง LINE): ผู้ใช้ส่ง
 *
 *   เพิ่มงาน
 *   1.สรุปไลน์ผู้ช่วย พรุ่งนี้ ผู้รับผิดชอบฉันเอง ก่อนวันนี้ 16.30
 *   2.เพิ่มUser การ์ดออนไลน์ผู้รับผิดชอบฉันเอง ก่อน17.00 วันนี้
 *   3.หาโซลูชั่นแสดงผลการ์ดชาวไร่แบบใหม่ผู้รับผิดชอบ ก่อน 17.00
 *
 * รอบแรกได้งานเดียวที่เอาทั้งสามข้อมาต่อกันเป็นชื่อ รอบที่สอง (หลังแก้) ยังได้
 * งานเดียวอยู่ เพราะ handle() ยุบช่องว่างทั้งหมดรวมทั้งบรรทัดใหม่เป็นช่องว่าง
 * เดียวก่อนถึงตัวแยก — ตัวแยกเดิมมองหาเลขข้อที่ "ต้นบรรทัด" จึงไม่เจออะไรเลย
 * บทเรียน: ทดสอบทั้งเส้นทางจริง ไม่ใช่แค่ตัวโมดูล
 *
 * ตัวแยกรุ่นนี้จึงหาเลขข้อกลางบรรทัดได้ด้วย และกันเลขที่ไม่ใช่เลขข้อสองชั้น:
 *  1. หลังจุดต้องไม่ใช่ตัวเลข — "ก่อนวันนี้ 16.30" ไม่ใช่ข้อที่ 16
 *  2. เลขข้อต้องเรียง 1, 2, 3 … ต่อกันจริง ไม่ใช่เลขที่หลงมาในประโยค
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

/** ประโยคที่เป็นคำสั่ง "เพิ่มงาน" — ใช้เป็นเงื่อนไขก่อนแยก ไม่ให้ไปแตะประโยคอื่น */
export const ADD_TASK_LEAD = /^\s*(?:ช่วย)?\s*(?:เพิ่ม|สร้าง|บันทึก|จด)\s*(?:งาน|ทาสก์|task)s?/i;

/** พิมพ์ "ผู้รับผิดชอบ" ผิดได้หลายแบบ (ผุ้ / ผู / ผู้) จึงรับให้หมด */
const RESP = /ผ[ูุ]?้?\s*รับผิดชอบ\s*/;

/** คำที่บอกว่าท่อนที่เหลือคือกำหนดส่ง */
const DUE = /(?:ก่อน|ภายใน|ไม่เกิน|ให้เสร็จ|เสร็จ)\s*/;

function tidy(s: string): string {
  return s.replace(/\s+/g, " ").replace(/^[\s,.;:–—-]+|[\s,.;:–—-]+$/g, "").trim();
}

/** ตำแหน่งหัวข้อหนึ่งข้อ: at = จุดที่เครื่องหมายเริ่ม, end = จุดที่เนื้อหาเริ่ม */
type Mark = { at: number; end: number; n: number | null };

/**
 * หาเครื่องหมายขึ้นข้อทั้งหมด: "1." "2)" หรือ bullet - – — • *
 *
 * ต้องมีต้นข้อความ/ช่องว่างนำหน้า เพื่อไม่ให้ไปตัดกลางคำ เช่น "ก่อน17.00"
 */
function findMarks(body: string): Mark[] {
  const out: Mark[] = [];
  const re = /(?:^|\s)(?:(\d{1,2})\s*[.)]|([-–—•*]))[ \t]*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const end = m.index + m[0].length;
    if (m[1]) {
      // "16.30" คือเวลา ไม่ใช่ข้อที่ 16 — หลังจุดของเลขข้อต้องไม่ใช่ตัวเลข
      if (/\d/.test(body[end] || "")) {
        re.lastIndex = m.index + m[0].length;
        continue;
      }
      out.push({ at: m.index, end, n: parseInt(m[1], 10) });
    } else {
      out.push({ at: m.index, end, n: null });
    }
    re.lastIndex = end;
  }
  return out;
}

/** เลือกชุดเครื่องหมายที่เชื่อได้ว่าเป็นรายการจริง */
function pickMarks(marks: Mark[]): { marks: Mark[]; numbered: boolean } {
  // เลขข้อต้องเรียง 1, 2, 3 … ถ้าเจอ "2." ลอย ๆ ข้อเดียวถือว่าไม่ใช่รายการ
  const seq: Mark[] = [];
  let want = 1;
  for (const mk of marks) {
    if (mk.n === want) {
      seq.push(mk);
      want++;
    }
  }
  if (seq.length >= 2) return { marks: seq, numbered: true };

  const bullets = marks.filter((mk) => mk.n === null);
  if (bullets.length >= 2) return { marks: bullets, numbered: false };

  return { marks: [], numbered: false };
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

  // "ก่อน 17.00" ไม่มีคำบอกวัน = วันนี้ ตามที่คนพูดกันจริง ถ้าปล่อยไปเปล่า ๆ
  // normalizeDue อ่านไม่ออกและงานจะไม่มีกำหนดส่งเลย (เคสข้อ 3 ของผู้ใช้)
  if (/^\d{1,2}[.:]\d{2}\s*(?:น\.?)?$/.test(duePhrase)) duePhrase = `วันนี้ ${duePhrase}`;

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

  const picked = pickMarks(findMarks(body));
  if (!picked.marks.length) return [];

  const parts: string[] = [];
  // ถ้าเป็นรายการเลขข้อ อะไรที่อยู่ก่อน "1." คือคำนำ ไม่ใช่งาน
  // ส่วนรายการ bullet แบบ "A - B - C" ท่อนแรกคือข้อแรกจริง จึงเก็บไว้
  if (!picked.numbered) {
    const head = body.slice(0, picked.marks[0].at).trim();
    if (head.length > 1) parts.push(head);
  }
  for (let i = 0; i < picked.marks.length; i++) {
    const start = picked.marks[i].end;
    const stop = i + 1 < picked.marks.length ? picked.marks[i + 1].at : body.length;
    const part = body.slice(start, stop).trim();
    if (part.length > 1) parts.push(part);
  }

  if (parts.length < 2) return [];

  return parts.map(parseTaskItem).filter((t) => t.title.length > 0);
}
