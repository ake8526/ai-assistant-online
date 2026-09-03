/**
 * อ่านรูป (และเผื่อเสียงในอนาคต) ด้วยโมเดลของ Gemini โดยตรง
 *
 * ทำไมไม่ใช้ chat() ที่มีอยู่: ทางนั้นยิงผ่าน endpoint แบบ OpenAI-compatible ซึ่งส่งได้
 * แต่ข้อความล้วน และวิ่งผ่านลูกโซ่ qwen → groq → gemini ส่วนงานอ่านรูปต้องยิง endpoint
 * ของ Gemini ตรง ๆ และควรปักรุ่นของตัวเองไว้ต่างหาก
 *
 * เลือกรุ่นและปิดการคิดจากผลวัดจริง (3 ก.ย. 69) บนใบสั่งงานภาษาไทย 4 รายการ:
 *   gemini-3.1-flash-lite  ปิดการคิด  1.5 วิ  0.021 บาท/รูป  อ่านถูก 4/4
 *   gemini-flash-latest    ปิดการคิด  2.3 วิ  0.058 บาท/รูป  อ่านถูก 4/4
 * ความแม่นเท่ากันแต่ถูกกว่า 2.7 เท่า จึงปัก flash-lite เป็นค่าเริ่มต้น
 * (งานอ่านให้ตรงไม่ต้องให้เหตุผล การคิดจึงเป็นค่าใช้จ่ายเปล่า)
 *
 * ปักรุ่นตายตัวแปลว่าวันหนึ่งรุ่นนั้นจะโดนปลด (2.5-flash กับ 2.5-flash-lite โดนไปแล้ว)
 * จึงมีลิสต์สำรอง และเปลี่ยนได้จาก env โดยไม่ต้องแก้โค้ด
 */
import { trace } from "@/lib/trace";

const MEDIA_MODELS = [
  process.env.GEMINI_MEDIA_MODEL || "gemini-3.1-flash-lite",
  "gemini-3.1-flash-lite",
  "gemini-flash-latest",
];
const TIMEOUT_MS = Number(process.env.GEMINI_MEDIA_TIMEOUT_MS || 25000);

export type ReadTask = { title: string; owner: string; due: string };
export type ReadImageResult = {
  /** งานที่อ่านได้จากรูป — ว่างได้ถ้ารูปไม่ใช่รายการงาน */
  tasks: ReadTask[];
  /** ตัวอักษรที่โมเดลบอกว่าเห็นจริงในรูป — ใช้ตรวจว่างานที่ได้มาไม่ได้แต่งขึ้น */
  textSeen: string;
  /** ข้อความ/สาระในรูปแบบสั้น สำหรับกรณีที่ไม่ใช่รายการงาน */
  summary: string;
  /** ประเภทที่โมเดลคิดว่าเป็น เอาไว้เลือกวิธีตอบ */
  kind: "tasks" | "document" | "unreadable";
  model: string;
};

const PROMPT = `ขั้นแรก คัดลอกตัวอักษรทุกตัวที่เห็นในรูปนี้ออกมาก่อน แล้วค่อยตีความ
ตอบเป็น JSON เท่านั้น:
{
  "text_seen": "ตัวอักษรที่เห็นในรูป คัดลอกตามจริงทั้งหมด ถ้าไม่เห็นตัวอักษรเลยให้ใส่ค่าว่าง",
  "kind": "tasks" | "document" | "unreadable",
  "summary": "สรุปสิ่งที่อยู่ในรูป 1-3 บรรทัด",
  "tasks": [{"title":"สิ่งที่ต้องทำ","owner":"ผู้รับผิดชอบถ้ามี","due":"กำหนดเสร็จถ้ามี"}]
}

กติกาที่สำคัญที่สุด — ผิดข้อนี้แล้วคำตอบใช้ไม่ได้เลย:
- ทุกคำใน tasks ต้องมาจาก text_seen เท่านั้น ห้ามเติมงาน ชื่อคน หรือวันที่ที่ไม่ได้อยู่ในรูป
- ถ้ารูปเบลอ มืด ว่างเปล่า หรือไม่มีตัวอักษรที่อ่านออก ต้องตอบ kind = "unreadable",
  text_seen = "" และ tasks = [] ห้ามแต่งตัวอย่างขึ้นมาแทนเด็ดขาด
- การตอบว่าอ่านไม่ออก ถือว่าถูกต้อง ไม่ใช่ความล้มเหลว

กติกาอื่น:
- ถ้ามีรายการสิ่งที่ต้องทำ (ใบสั่งงาน ไวท์บอร์ดสรุปงาน รายการติดตาม) ให้ kind = "tasks" ดึงให้ครบทุกแถว
- ถ้าเป็นเอกสารทั่วไป (ใบเสนอราคา หนังสือ รายงาน) ให้ kind = "document" แล้วเขียน summary ให้ได้ใจความ tasks = []
- ช่องไหนไม่มีในรูปให้ใส่ค่าว่าง โดยเฉพาะชื่อคนและวันที่
- คัดลอกชื่อคนและตัวเลขตามที่เห็น อย่าแปลงเป็นชื่อที่คุ้นเคยกว่า`;

/**
 * ส่งรูปเข้าโมเดลแล้วคืนสิ่งที่อ่านได้
 * โยน error เมื่อทุกรุ่นล้ม — ผู้เรียกต้องบอกผู้ใช้ตรง ๆ ว่าอ่านไม่ได้ ไม่ใช่เงียบ
 */
export async function readImage(buffer: Buffer, mimeType: string): Promise<ReadImageResult> {
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "";
  if (!key) throw new Error("ยังไม่ได้ตั้ง GEMINI_API_KEY");

  /* ย่อรูปก่อนส่ง: โทเค็นเท่าเดิม (คิดตามจำนวนช่องไม่ใช่พิกเซล) แต่เวลาอัปโหลดสั้นลงมาก
     รูปจากมือถือสมัยนี้ 3-6 MB ซึ่งพอ base64 แล้วโตอีก 33% */
  let bytes = buffer;
  let mime = mimeType || "image/jpeg";
  if (buffer.length > 900_000) {
    try {
      const sharp = (await import("sharp")).default;
      bytes = await sharp(buffer).rotate().resize(1600, 1600, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();
      mime = "image/jpeg";
    } catch {
      /* ย่อไม่ได้ก็ส่งของเดิมไป */
    }
  }

  const body = JSON.stringify({
    contents: [{ parts: [{ text: PROMPT }, { inline_data: { mime_type: mime, data: bytes.toString("base64") } }] }],
    generationConfig: { temperature: 0, responseMimeType: "application/json", thinkingConfig: { thinkingBudget: 0 } },
  });

  let lastErr = "";
  for (const model of [...new Set(MEDIA_MODELS)]) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body, signal: controller.signal }
      );
      const json = await res.json();
      if (!res.ok) {
        lastErr = `${model}: ${String(json?.error?.message || res.status).slice(0, 120)}`;
        /* รุ่นถูกปลด/พารามิเตอร์ไม่รองรับ → ลองรุ่นถัดไป ไม่ใช่ล้มทั้งงาน */
        continue;
      }
      const raw = json.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text).join("") || "";
      const parsed = JSON.parse(raw) as Partial<ReadImageResult> & { text_seen?: string };
      const textSeen = String(parsed.text_seen || "").trim();
      let tasks = (parsed.tasks || [])
        .map((t) => ({
          title: String(t?.title || "").trim(),
          owner: String(t?.owner || "").trim(),
          due: String(t?.due || "").trim(),
        }))
        .filter((t) => t.title);

      /* ด่านกันแต่งเรื่อง — ทดสอบแล้วเจอของจริง: ส่งรูปเบลอที่ไม่มีตัวอักษรเลยเข้าไป
         โมเดลแต่งงานขึ้นมาสามงานพร้อมชื่อคนและวันที่ที่ดูสมจริงมาก (คุณสมชาย 25/10/2023)
         คำสั่ง "ห้ามเดา" ใน prompt อย่างเดียวกันไม่อยู่ จึงต้องตรวจด้วยโค้ดอีกชั้น:
         งานทุกใบต้องมีคำที่โผล่อยู่ใน text_seen จริง ไม่งั้นถือว่าแต่งขึ้นแล้วทิ้ง */
      const seen = textSeen.replace(/\s+/g, "");
      if (seen.length < 8) {
        tasks = [];
      } else {
        tasks = tasks.filter((t) => {
          const words = t.title.split(/\s+/).filter((w) => w.length >= 3);
          if (!words.length) return seen.includes(t.title.replace(/\s+/g, ""));
          const hit = words.filter((w) => seen.includes(w)).length;
          return hit / words.length >= 0.6;
        });
      }

      const kind = tasks.length ? "tasks" : seen.length < 8 ? "unreadable" : "document";
      const usage = json.usageMetadata || {};
      const dropped = (parsed.tasks || []).length - tasks.length;
      trace(
        "compose",
        `👁 อ่านรูป · ${model} · ${usage.totalTokenCount ?? "?"} โทเค็น · ${tasks.length} งาน` +
          (dropped > 0 ? ` · ตัดที่ไม่ตรงกับข้อความในรูปทิ้ง ${dropped}` : "")
      );
      return { tasks, textSeen, summary: seen.length < 8 ? "" : String(parsed.summary || "").trim(), kind, model };
    } catch (e) {
      lastErr = `${model}: ${String(e).slice(0, 120)}`;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(lastErr || "อ่านรูปไม่สำเร็จ");
}
