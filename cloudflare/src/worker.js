/**
 * KTIS AI Assistant — ตัวตั้งเวลาหลัก (primary scheduler)
 *
 * ทำไมต้องมี: Vercel Cron บนแพลน Hobby รับประกันแค่ "ยิงภายใน 1 ชั่วโมง" (ของจริง
 * สายประจำ ~25–32 นาที) และ GitHub Actions ก็ throttle schedule ความถี่สูงเหลือ
 * ~1 ครั้ง/ชม. ทั้งสองทางจึงส่งข่าวเช้าไม่ตรงเวลา — ดู docs/morning-delivery-plan.md
 *
 * ตัวนี้ทำงานทุกนาที (cron "* * * * *") แล้วตัดสินใจเองจากเวลาไทย ข้อดี:
 *   - ตรงระดับนาที และไม่ติดเพดาน 3 cron triggers ต่อ Worker
 *   - ตารางเวลาทั้งหมดอยู่ในไฟล์เดียว อ่านรวดเดียวจบ
 *
 * เวลาไทย (จ–ศ):
 *   06:50 / 06:53 / 06:56  เตรียมข่าวล่วงหน้า (build ~100 วิ, รอบหลังข้ามถ้าเตรียมแล้ว)
 *   06:59                  เตรียมตารางเช้า + ปลุก function กัน cold start
 *   07:00                  ส่งข่าว   ← ต้องถึงมือตอนนี้
 *   07:01                  ส่งสรุปประชุม/ตาราง (ข่าว + 1 นาที)
 *   07:02–07:10            ตามเก็บทุกนาที (ถ้าส่งแล้วจะข้ามเอง ไม่ส่งซ้ำ)
 *
 * ทุกวัน 08:00–20:55 ทุก 5 นาที: สรุปประชุมจาก transcript, เตือนงาน (ต้นชั่วโมง),
 * แจ้งนัดใหม่ในปฏิทิน — งานกลุ่มนี้เคยพึ่ง GitHub Actions ที่รันจริงแค่ชั่วโมงละครั้ง
 *
 * Deploy: ดู cloudflare/README.md (ต้องตั้ง secret CRON_SECRET ให้ตรงกับ Vercel)
 */

const BKK_OFFSET_MS = 7 * 60 * 60 * 1000;

const PREWARM_NEWS_AT = ["06:50", "06:53", "06:56"];
const PREWARM_BRIEF_AT = "06:59";
const SEND_NEWS_AT = "07:00";
const SEND_BRIEF_AT = "07:01";
const CATCHUP_FROM = "07:02";
const CATCHUP_UNTIL = "07:10";

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
  const at = hhmmOf(bkk);
  const dow = bkk.getUTCDay(); // 0 = อาทิตย์
  const weekday = dow >= 1 && dow <= 5;
  const hour = bkk.getUTCHours();
  const minute = bkk.getUTCMinutes();
  const jobs = [];

  if (weekday) {
    if (PREWARM_NEWS_AT.includes(at)) {
      jobs.push({ label: "prewarm news", path: "/api/morning/prewarm?stage=news" });
    }
    if (at === PREWARM_BRIEF_AT) {
      jobs.push({ label: "prewarm brief", path: "/api/morning/prewarm?stage=brief" });
    }
    if (at === SEND_NEWS_AT) {
      jobs.push({ label: "send news", path: "/api/brief/run?only=news", align: true });
    }
    if (at === SEND_BRIEF_AT) {
      jobs.push({ label: "send brief", path: "/api/brief/run?only=brief", align: true });
    }
    if (at >= CATCHUP_FROM && at <= CATCHUP_UNTIL) {
      // ตามเก็บ: ถ้าส่งครบแล้ว isDueNow/claimSend จะตอบ skip ไม่ส่งซ้ำ
      jobs.push({ label: "catch-up", path: "/api/brief/run?only=both" });
    }
  }

  // งานกลางวัน 07:00–20:55 ทุก 5 นาที
  if (hour >= 7 && hour <= 20 && minute % 5 === 0) {
    // ผู้ใช้ตั้งเวลาส่งเองได้ (settings: news_time / brief_time) — poll นี้ทำให้
    // เวลาที่ไม่ใช่ค่าเริ่มต้น 07:00/07:01 ก็ยังได้ส่ง (สร้างสดตอนนั้น จึงช้ากว่า)
    if (!jobs.some((j) => j.path.startsWith("/api/brief/run"))) {
      jobs.push({ label: "delivery poll", path: "/api/brief/run?only=both" });
    }
    if (weekday && hour >= 8) {
      jobs.push({ label: "meeting summaries", path: "/api/summaries/run" });
      if (minute === 0) jobs.push({ label: "task reminders", path: "/api/reminders/run" });
    }
    if (hour >= 8) jobs.push({ label: "calendar notify", path: "/api/calendar/notify" });
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
    // prewarm ตอบกลับเร็ว (ทำงานต่อเบื้องหลังบน Vercel) — timeout ที่นี่ไม่ได้แปลว่างานล้ม
    return { label: job.label, ok: false, error: String(e).slice(0, 200) };
  }
}

async function tick(scheduledMs, env) {
  const jobs = planFor(bkkOf(scheduledMs));
  if (!jobs.length) return [];

  // ส่งงานที่ต้องตรงเวลา: ถ้าเรามาถึงก่อนวินาทีที่ 0 ให้รอจนถึงนาทีจริง
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
   *   /            → ดูว่านาทีนี้จะยิงอะไร
   *   /?at=07:00&dow=1 → ดูแผนของนาทีนั้น (ไม่ยิง)
   *   /?run=1      → ยิงงานของนาทีนี้จริง
   */
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!env.CRON_SECRET || url.searchParams.get("key") !== env.CRON_SECRET) {
      return new Response("unauthorized", { status: 401 });
    }
    const at = url.searchParams.get("at");
    let bkk = bkkOf(Date.now());
    if (at && /^\d{2}:\d{2}$/.test(at)) {
      const [h, m] = at.split(":").map(Number);
      const dow = parseInt(url.searchParams.get("dow") || "", 10);
      bkk = new Date(bkk);
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
