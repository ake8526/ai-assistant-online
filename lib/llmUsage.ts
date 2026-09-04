/**
 * นับโทเค็นและค่าใช้จ่ายของทุกครั้งที่เรียก AI
 *
 * ทำไมต้องมี: ทุกผู้ให้บริการส่ง usage กลับมาพร้อมคำตอบอยู่แล้ว แต่โค้ดเดิมอ่านแค่
 * ช่อง content แล้วทิ้งที่เหลือ เวลาถามว่า "เดือนนี้ใช้ไปกี่บาท" จึงตอบไม่ได้เลย
 * ต้องไปเปิดหน้าเว็บของ Google เอง ซึ่งบอกได้แค่ยอดรวม ไม่ได้บอกว่าเป็นค่าอะไร
 * — สรุปข่าว สรุปประชุม อ่านรูป หรือแค่แยกเจตนาข้อความที่คนพิมพ์เข้ามา
 *
 * สิ่งที่ต้องรู้ก่อนเชื่อตัวเลข:
 * - เป็น "ประมาณการ" เสมอ คิดจากโทเค็นที่ผู้ให้บริการรายงาน × ราคาที่ประกาศไว้
 *   ยอดจริงที่ถูกเรียกเก็บอยู่ที่หน้า billing ของแต่ละเจ้า ไม่ใช่ที่นี่
 * - ยังไม่ได้หักส่วนลด cached tokens (ถ้ามี) ตัวเลขจึงมีแต่จะสูงกว่าจริงเล็กน้อย
 * - ถ้าเครื่องดับก่อนเขียนลงฐาน ยอดของนาทีนั้นหายไปเลย ไม่มีการทวงคืน
 *   ยอมแลกเพื่อไม่ให้การนับเงินไปถ่วงคำตอบที่ผู้ใช้รออยู่
 *
 * เก็บใน settings (owner `_llm`, key `use:YYYY-MM-DD`) เพราะ migration ยังค้างอยู่
 * และหนึ่งแถวต่อวันอ่านง่ายกว่าหนึ่งแถวต่อครั้ง — เดือนหนึ่งอ่านแค่ 31 แถว
 */
import { admin } from "@/lib/supabaseServer";
import { nowWall, wallIso } from "@/lib/time";

const OWNER = "_llm";
const PREFIX = "use:";

/* ---------------------------------------------------------------- ราคา ---- */

/**
 * ราคาต่อ 1 ล้านโทเค็น (USD) — ตรวจจากหน้าราคาทางการ 4 ก.ย. 2569
 *   Gemini  ai.google.dev/gemini-api/docs/pricing
 *   Groq    console.groq.com/docs/models
 *   Qwen    alibabacloud.com/help/en/model-studio/model-pricing (ช่วง 0-32K)
 *
 * ราคาขยับได้ และรุ่นใหม่โผล่ได้ทุกเดือน รุ่นที่ไม่มีในตารางนี้จะยังนับโทเค็นให้
 * แต่ไม่คิดเงิน แล้วขึ้นเตือนบนหน้า /monitor/usage ว่ามีรุ่นที่ยังไม่รู้ราคา
 * — เดาราคาเองแล้วเงียบ อันตรายกว่าบอกว่าไม่รู้
 */
export const PRICE: Record<string, { in: number; out: number }> = {
  // Gemini — โปรโมชันถึง 31 ธ.ค. 2569 หลังจากนั้น flash ขึ้นเป็นเท่าตัว
  "gemini-3.8-flash": { in: 0.75, out: 3.75 },
  "gemini-3.7-flash": { in: 0.75, out: 3.75 },
  "gemini-3.6-flash": { in: 0.75, out: 3.75 },
  "gemini-3.5-flash": { in: 1.5, out: 9.0 },
  "gemini-3.5-flash-lite": { in: 0.3, out: 2.5 },
  "gemini-3.1-flash-lite": { in: 0.25, out: 1.5 },
  "gemini-2.5-flash": { in: 0.3, out: 2.5 },
  "gemini-2.5-flash-lite": { in: 0.1, out: 0.4 },
  // Groq
  "openai/gpt-oss-120b": { in: 0.15, out: 0.6 },
  "openai/gpt-oss-20b": { in: 0.075, out: 0.3 },
  "qwen/qwen3.6-27b": { in: 0.6, out: 3.0 },
  "qwen/qwen3.8-27b": { in: 0.8, out: 4.0 },
  // Qwen (DashScope international)
  "qwen3-max": { in: 1.2, out: 6.0 },
};

/**
 * ชื่อ alias ที่ Google ชี้ไปยังรุ่นจริง — ราคาต้องตามรุ่นที่มันชี้อยู่
 * วันที่ Google ย้าย latest ไปรุ่นถัดไป บรรทัดนี้ต้องตามไปแก้ ไม่งั้นคิดเงินผิดเงียบ ๆ
 */
const ALIAS: Record<string, string> = {
  "gemini-flash-latest": "gemini-3.8-flash", // ตรวจ 3 ก.ย. 2569
};

/** บาทต่อดอลลาร์ที่ใช้แปลง — ตั้งค่าใหม่ได้ที่ env โดยไม่ต้องแก้โค้ด */
export function usdThb(): number {
  const n = Number(process.env.USD_THB || 35);
  return Number.isFinite(n) && n > 0 ? n : 35;
}

export function priceOf(model: string): { in: number; out: number } | null {
  const m = (model || "").trim();
  return PRICE[m] || PRICE[ALIAS[m] || ""] || null;
}

/* ------------------------------------------------------------ โครงข้อมูล ---- */

export type Bucket = { n: number; in: number; out: number; usd: number };
export type DayUsage = Bucket & {
  /** จำนวนครั้งที่นับโทเค็นได้แต่ไม่รู้ราคา — ยอดเงินของวันนั้นจึงต่ำกว่าจริง */
  unpriced: number;
  /** แยกตามรุ่น: "provider/model" */
  by: Record<string, Bucket>;
  /** แยกตามงาน: news / meeting / ocr / intent / chat */
  task: Record<string, Bucket>;
};

/** ป้ายภาษาไทยของงานแต่ละชนิด — ใช้ทั้งหน้าเว็บและที่อื่นที่ต้องแสดงผล */
export const TASK_TH: Record<string, string> = {
  news: "สรุปข่าว",
  meeting: "สรุปประชุม",
  ocr: "อ่านรูป",
  voice: "ถอดเสียง",
  intent: "แยกเจตนา",
  parse: "อ่านข้อมูล",
  chat: "ตอบแชท",
};

function emptyBucket(): Bucket {
  return { n: 0, in: 0, out: 0, usd: 0 };
}

function emptyDay(): DayUsage {
  return { ...emptyBucket(), unpriced: 0, by: {}, task: {} };
}

function addInto(b: Bucket, d: Bucket): void {
  b.n += d.n;
  b.in += d.in;
  b.out += d.out;
  b.usd += d.usd;
}

function mergeDay(base: DayUsage, add: DayUsage): DayUsage {
  addInto(base, add);
  base.unpriced += add.unpriced;
  for (const [k, v] of Object.entries(add.by)) {
    base.by[k] = base.by[k] || emptyBucket();
    addInto(base.by[k], v);
  }
  for (const [k, v] of Object.entries(add.task)) {
    base.task[k] = base.task[k] || emptyBucket();
    addInto(base.task[k], v);
  }
  return base;
}

function parseDay(raw: string | null): DayUsage {
  if (!raw) return emptyDay();
  try {
    const p = JSON.parse(raw) as Partial<DayUsage>;
    return {
      n: Number(p.n) || 0,
      in: Number(p.in) || 0,
      out: Number(p.out) || 0,
      usd: Number(p.usd) || 0,
      unpriced: Number(p.unpriced) || 0,
      by: (p.by as Record<string, Bucket>) || {},
      task: (p.task as Record<string, Bucket>) || {},
    };
  } catch {
    return emptyDay();
  }
}

const round4 = (n: number) => Math.round(n * 10000) / 10000;

function trimForStorage(d: DayUsage): DayUsage {
  d.usd = round4(d.usd);
  for (const b of [...Object.values(d.by), ...Object.values(d.task)]) b.usd = round4(b.usd);
  return d;
}

/* -------------------------------------------------------------- บันทึก ---- */

export type UsageInput = {
  provider: string;
  model: string;
  task: string;
  promptTokens: number;
  completionTokens: number;
};

/** คิวรอเขียน — รวมทุกครั้งที่เรียก AI ในหนึ่ง request ให้เขียนฐานข้อมูลรอบเดียว */
const pending = new Map<string, DayUsage>();
let flushArmed = false;

function todayKey(): string {
  return PREFIX + wallIso(nowWall()).slice(0, 10);
}

/**
 * นับหนึ่งครั้ง — ไม่ await การเขียน ผู้ใช้บน LINE ไม่ควรรอเพราะเราอยากได้ตัวเลข
 *
 * เขียนหลังตอบเสร็จด้วย after() ของ Next ถ้าอยู่นอก request (สคริปต์ทดสอบ) ก็ปล่อย
 * ให้วิ่งเบื้องหลังไป ล้มก็เงียบ — การนับเงินห้ามทำให้คำตอบพัง
 */
export function recordUsage(u: UsageInput): void {
  const pin = Math.max(0, Math.round(u.promptTokens || 0));
  const pout = Math.max(0, Math.round(u.completionTokens || 0));
  if (!pin && !pout) return;

  const price = priceOf(u.model);
  const usd = price ? (pin * price.in + pout * price.out) / 1_000_000 : 0;
  const one: Bucket = { n: 1, in: pin, out: pout, usd };
  const delta = emptyDay();
  mergeDay(delta, {
    ...one,
    unpriced: price ? 0 : 1,
    by: { [`${u.provider}/${u.model}`]: { ...one } },
    task: { [u.task || "chat"]: { ...one } },
  });

  const key = todayKey();
  const cur = pending.get(key);
  pending.set(key, cur ? mergeDay(cur, delta) : delta);
  arm();
}

function arm(): void {
  if (flushArmed) return;
  flushArmed = true;
  const run = () => {
    flushArmed = false;
    void flushUsage().catch(() => {});
  };
  /* โหลด next/server แบบ dynamic: สคริปต์ทดสอบที่เรียก chat() นอก Next จะได้ไม่พัง
     ตั้งแต่ import — และ after() นอก request scope ก็โยน error ต้องรับไว้เอง
     ตัว import คืนค่าใน microtask เดียวกัน จึงยังทันก่อน response ถูกส่งออก */
  import("next/server")
    .then((m) => {
      try {
        m.after(run);
      } catch {
        setTimeout(run, 0);
      }
    })
    .catch(() => setTimeout(run, 0));
}

/** เขียนทุกอย่างที่ค้างในคิวลงฐาน — เรียกเองได้ในสคริปต์ที่อยากบังคับให้เขียนทันที */
export async function flushUsage(): Promise<void> {
  if (!pending.size) return;
  const snapshot = [...pending.entries()];
  pending.clear();
  for (const [key, delta] of snapshot) {
    let ok = false;
    try {
      ok = await addUsage(key, delta);
    } catch {
      ok = false;
    }
    if (!ok) {
      /* เขียนไม่สำเร็จ (แถวถูกแย่งจนหมดโควตาลองใหม่) — คืนกลับเข้าคิวให้ครั้งหน้าพาไป
         ดีกว่าทิ้งเงียบ ๆ แม้จะยังหายได้ถ้าเครื่องดับก่อน ซึ่งเขียนบอกไว้บนหน้าเว็บแล้ว */
      const back = pending.get(key);
      pending.set(key, back ? mergeDay(back, delta) : delta);
      console.warn(`[llmUsage] เขียนยอดของ ${key} ไม่สำเร็จ เก็บไว้รอบหน้า`);
    }
  }
}

/**
 * บวกยอดเข้าแถวของวันนั้นแบบกันชนกัน — คืน true เมื่อเขียนติดจริง
 *
 * แถวเดียวถูกเขียนจากหลายเครื่องพร้อมกันได้ (เช้าวันทำงานยิงสรุปให้ทุกคนพร้อมกัน)
 * อ่าน-แก้-เขียนธรรมดาจะกลืนยอดของกันเอง จึงเขียนแบบมีเงื่อนไข: อัปเดตเฉพาะเมื่อค่า
 * ในฐานยังเป็นค่าเดิมที่เราอ่านมา ถ้ามีคนแทรกก็อ่านใหม่แล้วลองอีกครั้ง
 *
 * จำนวนครั้งที่ยอมลองใหม่มาจากการวัดจริง ไม่ใช่เดา: ทดสอบด้วยผู้เขียน 12 รายพร้อมกัน
 * ตอนตั้งไว้ 5 ครั้ง หายไป 2 ราย เพราะทุกคนต้องเข้าคิวเขียนทีละคน คนที่แพ้ครบ 5 รอบ
 * ก็เงียบหายไปเลย — รอบละ 1 คนแปลว่าต้องเผื่อให้มากกว่าจำนวนคนที่แย่งกัน
 */
export async function addUsage(key: string, delta: DayUsage): Promise<boolean> {
  for (let attempt = 0; attempt < 24; attempt++) {
    const { data: row } = await admin
      .from("settings")
      .select("value")
      .eq("owner_upn", OWNER)
      .eq("key", key)
      .maybeSingle();
    const cur: string | null = row?.value ?? null;
    const next = JSON.stringify(trimForStorage(mergeDay(parseDay(cur), delta)));

    if (cur === null) {
      const { error } = await admin.from("settings").insert({ owner_upn: OWNER, key, value: next });
      if (!error) return true;
      /* ชนกันตอนสร้างแถวแรก — แถวมีแล้ว ลองใหม่ทันทีไม่ต้องรอ */
      continue;
    }
    const { data } = await admin
      .from("settings")
      .update({ value: next })
      .eq("owner_upn", OWNER)
      .eq("key", key)
      .eq("value", cur)
      .select("key");
    if (data && data.length) return true;
    await new Promise((r) => setTimeout(r, 20 + attempt * 12 + Math.random() * 50));
  }
  return false;
}

/* ---------------------------------------------------------------- อ่าน ---- */

export type UsageReport = {
  from: string;
  to: string;
  thbPerUsd: number;
  days: (Bucket & { d: string; unpriced: number })[];
  byModel: (Bucket & { id: string })[];
  byTask: (Bucket & { id: string })[];
  total: Bucket & { unpriced: number };
  today: Bucket;
  /** รุ่นที่โผล่มาแล้วแต่ยังไม่มีราคาในตาราง — ต้องไปเติมเอง */
  unknownModels: string[];
  prices: { id: string; in: number; out: number }[];
};

function sortBucket<T extends Bucket>(rows: T[]): T[] {
  return rows.sort((a, b) => b.usd - a.usd || b.in + b.out - (a.in + a.out));
}

export async function readUsage(days = 30): Promise<UsageReport> {
  const span = Math.min(120, Math.max(1, Math.round(days)));
  const end = nowWall();
  const start = new Date(end.getTime() - (span - 1) * 86400_000);
  const from = wallIso(start).slice(0, 10);
  const to = wallIso(end).slice(0, 10);

  const { data } = await admin
    .from("settings")
    .select("key,value")
    .eq("owner_upn", OWNER)
    .gte("key", PREFIX + from)
    .lte("key", PREFIX + to);

  const dayRows: (Bucket & { d: string; unpriced: number })[] = [];
  const byModel = new Map<string, Bucket>();
  const byTask = new Map<string, Bucket>();
  const total: Bucket & { unpriced: number } = { ...emptyBucket(), unpriced: 0 };
  let today: Bucket = emptyBucket();
  const todayD = to;

  for (const r of (data || []) as { key: string; value: string }[]) {
    if (!r.key.startsWith(PREFIX)) continue;
    const d = r.key.slice(PREFIX.length);
    const u = parseDay(r.value);
    dayRows.push({ d, n: u.n, in: u.in, out: u.out, usd: u.usd, unpriced: u.unpriced });
    addInto(total, u);
    total.unpriced += u.unpriced;
    if (d === todayD) today = { n: u.n, in: u.in, out: u.out, usd: u.usd };
    for (const [k, v] of Object.entries(u.by)) {
      const b = byModel.get(k) || emptyBucket();
      addInto(b, v);
      byModel.set(k, b);
    }
    for (const [k, v] of Object.entries(u.task)) {
      const b = byTask.get(k) || emptyBucket();
      addInto(b, v);
      byTask.set(k, b);
    }
  }

  dayRows.sort((a, b) => (a.d < b.d ? 1 : -1));

  const unknownModels = [...byModel.keys()]
    .filter((id) => !priceOf(id.split("/").slice(1).join("/")))
    .map((id) => id.split("/").slice(1).join("/"));

  return {
    from,
    to,
    thbPerUsd: usdThb(),
    days: dayRows,
    byModel: sortBucket([...byModel].map(([id, b]) => ({ id, ...b }))),
    byTask: sortBucket([...byTask].map(([id, b]) => ({ id, ...b }))),
    total,
    today,
    unknownModels: [...new Set(unknownModels)],
    prices: Object.entries(PRICE).map(([id, p]) => ({ id, ...p })),
  };
}
