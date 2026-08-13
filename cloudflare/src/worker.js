/**
 * KTIS AI Assistant — ตัวตั้งเวลาหลัก (primary scheduler)
 *
 * ทำไมต้องมี: Vercel Cron บนแพลน Hobby รับประกันแค่ "ยิงภายใน 1 ชั่วโมง" (ของจริง
 * สายประจำ ~25–32 นาที) และ GitHub Actions ก็ throttle schedule ความถี่สูงเหลือ
 * ~1 ครั้ง/ชม. ทั้งสองทางจึงส่งข่าวเช้าไม่ตรงเวลา — ดู docs/morning-delivery-plan.md
 *
 * หลักการ: Worker ไม่รู้ (และไม่ต้องรู้) ว่าใครตั้งกี่โมง — เวลาส่งของแต่ละคนอยู่ใน
 * ฐานข้อมูล (settings: news_time / brief_time) ฝั่ง Vercel เป็นคนตัดสิน Worker แค่
 * "เคาะทุกนาที" ในช่วงเช้าให้ทัน แล้วปล่อยให้ isDueNow ตัดสินว่าถึงเวลาของใคร
 * เพิ่ม/ย้ายเวลาผู้ใช้ได้จากในแอปโดยไม่ต้องแก้ Worker
 *
 * ทุกนาทีในช่วง 05:30–08:20 (เวลาไทย):
 *   /api/morning/prewarm?stage=auto  เตรียมเนื้อหาล่วงหน้า (ข่าวก่อนเวลา 4–12 นาที,
 *                                    ตารางก่อน 1–3 นาที) — ส่งเวลาจริงจึงเป็นแค่ push
 *   /api/brief/run?only=both         ส่งของใครที่ถึงเวลานาทีนี้ (ข่าวก่อน, ตารางตามหลัง
 *                                    1 นาทีตามกฎใน lib/notify.ts)
 *
 * ทุก 5 นาที 08:20–20:55: ส่งที่ค้าง + สรุปประชุมจาก transcript + เตือนงาน (ต้นชั่วโมง)
 * + แจ้งนัดใหม่ในปฏิทิน — งานกลุ่มนี้เคยพึ่ง GitHub Actions ที่รันจริงแค่ชั่วโมงละครั้ง
 *
 * Deploy: ดู cloudflare/README.md (ต้องตั้ง secret CRON_SECRET ให้ตรงกับ Vercel)
 */

const BKK_OFFSET_MS = 7 * 60 * 60 * 1000;

/** ช่วงเช้าที่เคาะทุกนาที (ครอบทุกเวลาที่ผู้ใช้ตั้งไว้จริง: 06:00 และ 07:00) */
const MORNING_FROM_MIN = 5 * 60 + 30; // 05:30
const MORNING_TO_MIN = 8 * 60 + 20; // 08:20

/** ช่วงงานกลางวัน (ทุก 5 นาที) */
const DAY_FROM_MIN = 8 * 60 + 20;
const DAY_TO_MIN = 20 * 60 + 55;

/** เวลาตรวจย้อนหลังว่าเมื่อเช้าส่งตรงเวลาไหม (หลังหมดช่วงเช้าแล้ว) */
const PUNCTUALITY_CHECK_MIN = 8 * 60 + 30; // 08:30

/** Cloudflare อาจยิงก่อนวินาทีที่ 0 เล็กน้อย — รอให้ถึงนาทีจริงก่อนส่ง (สูงสุด 3 วิ) */
const MAX_ALIGN_MS = 3_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (n) => String(n).padStart(2, "0");

/** เวลาไทยของ instant นี้ (ใช้ getUTC* เพราะเลื่อน epoch มาแล้ว) */
function bkkOf(ms) {
  return new Date(ms + BKK_OFFSET_MS);
}

function hhmmOf(bkk) {
  return `${pad(bkk.getUTCHours())}:${pad(bkk.getUTCMinutes())}`;
}

/** รายการงานที่ต้องยิงในนาทีนี้ */
export function planFor(bkk) {
  const minute = bkk.getUTCMinutes();
  const minOfDay = bkk.getUTCHours() * 60 + minute;
  const dow = bkk.getUTCDay(); // 0 = อาทิตย์
  const weekday = dow >= 1 && dow <= 5;
  const jobs = [];

  if (minOfDay >= MORNING_FROM_MIN && minOfDay < MORNING_TO_MIN) {
    // ส่งก่อน เตรียมทีหลัง — prewarm ตอบกลับ ~5 วิ ถ้ายิงก่อนจะทำให้การส่งเลื่อนไป
    // 5 วินาที ซึ่งกินเป้า "ถึงมือ 07:00" ทั้งสองงานไม่ขึ้นแก่กันในนาทีเดียวกัน
    jobs.push({ label: "deliver", path: "/api/brief/run?only=both", align: true });
    jobs.push({ label: "prewarm", path: "/api/morning/prewarm?stage=auto" });
  }

  // หลังหมดช่วงเช้า: ตรวจว่าเมื่อเช้าส่งตรงเวลาไหม ถ้าช้าเกิน 5 นาทีจะแจ้งผู้ดูแล
  if (minOfDay === PUNCTUALITY_CHECK_MIN) {
    jobs.push({ label: "punctuality check", path: "/api/morning/punctuality" });
  }

  if (minOfDay >= DAY_FROM_MIN && minOfDay <= DAY_TO_MIN && minute % 5 === 0) {
    jobs.push({ label: "deliver (late)", path: "/api/brief/run?only=both" });
    if (weekday) {
      jobs.push({ label: "meeting summaries", path: "/api/summaries/run" });
      if (minute === 0) jobs.push({ label: "task reminders", path: "/api/reminders/run" });
    }
    jobs.push({ label: "calendar notify", path: "/api/calendar/notify" });
  }

  return jobs;
}

async function fire(env, job) {
  const base = (env.BASE || "").replace(/\/+$/, "");
  if (!base) return { label: job.label, ok: false, error: "BASE not configured" };
  if (!env.CRON_SECRET) return { label: job.label, ok: false, error: "CRON_SECRET not set" };
  try {
    const res = await fetch(base + job.path, {
      method: "POST",
      headers: { "x-cron-secret": env.CRON_SECRET, "cache-control": "no-store" },
      signal: AbortSignal.timeout(job.timeoutMs || 30_000),
    });
    const body = (await res.text()).slice(0, 300);
    return { label: job.label, ok: res.ok, status: res.status, body };
  } catch (e) {
    // prewarm ตอบกลับเร็วแล้วทำงานต่อเบื้องหลังบน Vercel — timeout ที่นี่ไม่ได้แปลว่างานล้ม
    return { label: job.label, ok: false, error: String(e).slice(0, 200) };
  }
}

async function tick(scheduledMs, env) {
  const jobs = planFor(bkkOf(scheduledMs));
  if (!jobs.length) return [];

  // งานที่ต้องตรงเวลา: ถ้ามาถึงก่อนวินาทีที่ 0 ให้รอจนถึงนาทีจริงก่อน
  if (jobs.some((j) => j.align)) {
    const drift = scheduledMs - Date.now();
    if (drift > 0) await sleep(Math.min(drift, MAX_ALIGN_MS));
  }

  const out = [];
  for (const job of jobs) {
    const r = await fire(env, job);
    out.push(r);
    console.log(`[cron] ${hhmmOf(bkkOf(Date.now()))} ${r.label} → ${r.ok ? r.status : r.error}`);
  }
  return out;
}

export default {
  async scheduled(event, env) {
    await tick(event.scheduledTime, env);
  },

  /**
   * ทดสอบด้วยมือ (ต้องมี ?key=<CRON_SECRET>):
   *   /                 → ดูว่านาทีนี้จะยิงอะไร
   *   /?at=07:00&dow=1  → ดูแผนของนาทีนั้น (ไม่ยิง)
   *   /?run=1           → ยิงงานของนาทีนี้จริง
   */
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!env.CRON_SECRET || url.searchParams.get("key") !== env.CRON_SECRET) {
      return new Response("unauthorized", { status: 401 });
    }
    const at = url.searchParams.get("at");
    let bkk = bkkOf(Date.now());
    if (at && /^\d{1,2}:\d{2}$/.test(at)) {
      const [h, m] = at.split(":").map(Number);
      const dow = parseInt(url.searchParams.get("dow") || "", 10);
      bkk = new Date(bkk.getTime());
      bkk.setUTCHours(h, m, 0, 0);
      if (Number.isFinite(dow) && dow >= 0 && dow <= 6) {
        bkk.setUTCDate(bkk.getUTCDate() + ((dow - bkk.getUTCDay() + 7) % 7));
      }
    }
    const plan = planFor(bkk);
    if (url.searchParams.get("run") !== "1") {
      return Response.json({ bkk: hhmmOf(bkk), dow: bkk.getUTCDay(), plan });
    }
    const results = [];
    for (const job of plan) results.push(await fire(env, job));
    return Response.json({ bkk: hhmmOf(bkk), results });
  },
};
