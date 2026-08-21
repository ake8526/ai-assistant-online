import { CONFIG } from "./config.js";
import { WHITELIST, CATEGORIES, matchSource } from "../config/sources.js";
import { getProvider } from "./providers/index.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function withRetry(fn, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (err) {
      last = err;
      const s = err?.status ?? err?.response?.status;
      const msg = err?.message || "";
      const transient = s === 429 || s === 529 || (s >= 500 && s < 600) || /429|5\d\d|network|timeout|ECONN|fetch failed/i.test(msg);
      if (!transient || i === tries - 1) throw err;
      await sleep(1000 * 2 ** i);
    }
  }
  throw last;
}

function whitelistBlock() {
  const l = (s) => `- ${s.name} (${s.domain})`;
  return ["GLOBAL:", ...WHITELIST.global.map(l), "", "THAI:", ...WHITELIST.thai.map(l)].join("\n");
}

// ---- Phase 1: research (provider searches the open web) ----
function researchSystem() {
  const { recencyHours, maxStories } = CONFIG.brief;
  return `คุณคือนักข่าวสายเทคโนโลยี ค้นเว็บหาข่าวเทคที่สำคัญที่สุดในรอบ ~${recencyHours} ชม.ที่ผ่านมา ทั้งระดับโลกและไทย ในหมวด AI, Startup, Funding, Policy, Gadget

กติกา:
- ค้นได้ทั่วเว็บ แต่เลือกเฉพาะเรื่องที่ "มีสำนักข่าวใน whitelist รายงาน" และแนบ url ที่เป็นโดเมนใน whitelist เท่านั้น
- รวบรวมผู้สมัครสูงสุด ~${maxStories + 4} เรื่อง เรียงตามความสำคัญ (impact + ความใหม่)

whitelist:
${whitelistBlock()}

ผลลัพธ์: เขียนรายการข่าวผู้สมัคร (ภาษาไทย) แต่ละอันมี: หมวด | พาดหัว(ไทย) | สรุป 2–3 ประโยค(ไทย คงศัพท์เทคนิค EN) | ชื่อสำนักข่าว | url ต้นทาง`;
}
function researchUser(recent) {
  const already = recent?.length ? recent.map((r) => `- ${r.title || r.url}`).join("\n") : "(ยังไม่มี)";
  return `วันนี้: ${new Date().toISOString()}\nรวบรวมข่าวเทคเด่นในรอบ ${CONFIG.brief.recencyHours} ชม.\n\nข่าวที่ส่งไปแล้ว (เลี่ยงซ้ำ):\n${already}`;
}

// ---- Phase 2: format notes → strict JSON (no browsing) ----
function formatSystem() {
  const { minStories, maxStories } = CONFIG.brief;
  return `แปลงบันทึกข่าวเป็น JSON อย่างเดียว ห้ามมีข้อความอื่นนอกก้อน JSON

- เลือก ${minStories}–${maxStories} ข่าวสำคัญสุด (วันข่าวน้อยเลือกน้อยได้ ต่ำสุด ${minStories}; ถ้ามีเด่นจริงน้อยกว่านั้นคืนเท่าที่มี แม้ 0–2 อย่าถมข่าวไม่สำคัญ)
- ตัดข่าวซ้ำ/ที่เคยส่งแล้ว
- category ต้องเป็นหนึ่งใน [${CATEGORIES.join(", ")}]
- summary_th เข้าใจจบในตัว (เกิดอะไร + ทำไมสำคัญ) คงศัพท์เทคนิค EN
- url ต้องเป็นโดเมนใน whitelist

ปิดท้ายด้วย JSON ก้อนเดียว: {"stories":[{"category","headline_th","summary_th","source_name","url"}]}`;
}
function formatUser(notes, already, extra = "") {
  return `บันทึกจากการค้นหา:\n${notes}\n\nข่าวที่ส่งไปแล้ว (ห้ามซ้ำ):\n${already}\n\nแปลงเป็น JSON ตาม schema${extra}`;
}

function extractJson(text) {
  const fences = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)];
  let raw = fences.length ? fences[fences.length - 1][1] : null;
  if (!raw) { const s = text.indexOf("{"), e = text.lastIndexOf("}"); if (s === -1 || e === -1) return null; raw = text.slice(s, e + 1); }
  try { return JSON.parse(raw.trim()); } catch { return null; }
}

function sanitize(stories) {
  const out = [], seen = new Set();
  for (const s of Array.isArray(stories) ? stories : []) {
    if (!s?.url || !s?.headline_th) continue;
    const src = matchSource(s.url);
    if (!src) continue;
    const key = s.url.split("?")[0].toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      category: CATEGORIES.includes(s.category) ? s.category : "AI",
      headline_th: String(s.headline_th).trim(),
      summary_th: String(s.summary_th || "").trim(),
      source_name: s.source_name || src.name,
      source_domain: src.domain,
      url: s.url.trim(),
    });
  }
  return out.slice(0, CONFIG.brief.maxStories);
}

export async function runAgent({ recent = [] } = {}) {
  const provider = getProvider(); // auto-selected by which API key is set
  const already = recent?.length ? recent.map((r) => `- ${r.title || r.url}`).join("\n") : "(ไม่มี)";

  const notes = await withRetry(() => provider.research(researchSystem(), researchUser(recent)));

  let parsed = extractJson(await withRetry(() => provider.format(formatSystem(), formatUser(notes, already))));
  if (!parsed) parsed = extractJson(await withRetry(() => provider.format(formatSystem(), formatUser(notes, already, " — ตอบเป็น JSON ล้วนเท่านั้น"))));
  if (!parsed) throw new Error(`Agent (${provider.name}) could not produce valid JSON`);

  return { stories: sanitize(parsed.stories), provider: provider.name, notes };
}
