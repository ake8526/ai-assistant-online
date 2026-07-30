// Natural-language command handling — ported from morning_brief/commands.py.
// The web / LINE sends free text; the LLM classifies it into an intent + params
// and we execute. Booking asks for confirmation first (choose_slot) per requirement.
import { buildForEvents, buildForToday } from "@/lib/brief";
import { buildDigest, formatStoriesText } from "@/lib/digest";
import { normalizeDue, resolveResponsible } from "@/lib/followup";
import {
  GraphEvent,
  UserInfo,
  createEvent,
  getEventsRange,
  resolveUser,
  resolveUserInfo,
  searchFiles,
  searchUsers,
  stripHonorificPublic,
} from "@/lib/graph";
import { chat } from "@/lib/llm";
import { listRecentOnline } from "@/lib/meetings";
import { busyRanges, findCommonSlots, formatBusy, formatFree, freeRanges } from "@/lib/scheduling";
import {
  addPlace,
  addTask,
  deletePlace,
  getPrimaryPlace,
  incrementVisit,
  listPlaces,
  listTasks,
  allSettings,
  updateTaskStatus,
} from "@/lib/store";
import {
  addMinutes,
  fmtDate,
  fmtDateTime,
  fmtHHMM,
  fmtTime,
  minutesOfDay,
  parseHHMM,
  parseWall,
  periodRange,
  resolveDay,
  wallIso,
} from "@/lib/time";

const WORK_START_HOUR = Number(process.env.WORK_START_HOUR || 9);
const AUTO_BOOK = (process.env.AUTO_BOOK || "false").toLowerCase() === "true";

export type CommandContext = {
  history?: { role?: string; text?: string }[];
  last_intent?: string;
  last_person?: string;
  last_person_mail?: string;
  files?: { id?: string; name?: string; url?: string; is_folder?: boolean }[];
  selected?: { start: string; person?: { mail?: string; displayName?: string } };
};

export type CommandResult = {
  intent: string;
  reply: string;
  data?: unknown;
  files?: unknown[];
  slots?: unknown[];
  choices?: unknown[];
  meeting?: unknown;
  person?: { mail: string; displayName?: string };
  map_url?: string | null;
  map_where?: string;
};

const INTENT_SYSTEM = `คุณคือตัวแยกเจตนา (intent parser) ของผู้ช่วยงาน
ผู้ใช้จะพิมพ์คำสั่งภาษาไทย/อังกฤษ ให้ตอบกลับเป็น JSON เท่านั้น:

{
  "intent": "<หนึ่งใน: get_brief | get_news | list_meetings | my_availability | list_tasks | add_task | complete_task | summarize_meetings | find_meeting_time | cancel_meeting | open_map | open_map_home | plan_commute | set_work_location | set_home_location | show_work_location | clear_work_location | search_files | summarize_file | unknown>",
  "params": { ... }
}

ความหมายของแต่ละ intent:
- get_brief = สรุปเตรียมตัว/แนะนำสำหรับนัดวันนี้ (ไม่ใช่การสรุปไฟล์)
- get_news = สรุป "ข่าว/ฟีดที่ติดตาม" (RSS + คลิป YouTube ที่ subscribe) — เช่น "มีข่าวอะไรบ้าง", "สรุปข่าววันนี้", "ข่าวที่ติดตาม", "มีคลิปใหม่อะไรบ้าง"
- list_meetings = ดู "รายการประชุม/นัด" ในปฏิทิน (วันนี้/พรุ่งนี้/สัปดาห์นี้/เดือนนี้)
- my_availability = ดู "เวลาว่างของตัวเอง" ในปฏิทิน (ช่วงไหนว่าง/ตารางว่าง)
- list_tasks = ดูงานที่ต้องติดตาม (ไม่ใช่ประชุม)
- summarize_meetings = สรุป "ประชุมที่จบไปแล้ว" จาก transcript
- summarize_file = อ่านหรือสรุปเนื้อหาในไฟล์ที่ค้นพบ หรือไฟล์ที่ผู้ใช้อ้างถึง (เช่น "อ่านและสรุป", "สรุปไฟล์นี้", "อ่านอันแรก", "สรุปให้ฟัง")
- search_files = ค้นหาไฟล์ใน OneDrive

สำคัญ: หากบริบทก่อนหน้าเพิ่งมีการค้นหาไฟล์ (search_files หรือ file_results) แล้วผู้ใช้พิมพ์ว่า "อ่านและสรุป", "สรุปให้ฟัง", "อ่านไฟล์" ให้เลือก intent เป็น "summarize_file" เสมอ (ห้ามเลือก get_brief)!

ความต่อเนื่องของบทสนทนา (สำคัญมาก — ห้ามเริ่มคิดใหม่เอง):
ระบบจะแนบ [ประวัติการสนทนาก่อนหน้า] และ [บริบทล่าสุด] (มี last_person = คน/เรื่องที่กำลังคุยอยู่) มาให้ ให้ถือว่าบทสนทนาต่อเนื่องกันเสมอ:
- ถ้าผู้ใช้พิมพ์ต่อเนื่องโดย "ไม่ได้เอ่ยชื่อคนใหม่" (เช่น เจาะจงวัน/เวลาเพิ่ม เช่น "วันที่ 30 ตอน 9 โมง", "แล้วบ่ายล่ะ", "ช่วงเช้าว่างไหม") ให้เข้าใจว่ายังพูดถึงคน/เรื่องเดิมใน last_person — ต้องปล่อย params.person ให้ "ว่าง" ไว้ (ระบบจะเติม last_person ให้เอง)
- ห้ามตีความคำบอกวัน/เวลา เช่น "ตอน", "โมง", "เช้า", "บ่าย", "เย็น", "ครึ่ง", "ทุ่ม" เป็นชื่อคนเด็ดขาด
- ใส่ params.person เฉพาะเมื่อผู้ใช้เอ่ย "ชื่อคนใหม่จริง ๆ" เท่านั้น

รายละเอียด params:
- list_meetings: { "period": "today|tomorrow|week|month|upcoming", "date": "วันที่เจาะจง เช่น 31 หรือ 2026-07-31 (ถ้าผู้ใช้ระบุวัน)", "after": "HH:MM (ถ้าบอก เช่น หลัง 9 โมงครึ่ง)", "before": "HH:MM (ถ้าบอก เช่น ก่อนเที่ยง)", "person": "ชื่อ/อีเมลคนอื่น ถ้าถามว่าคนนั้น 'ติด/ไม่ว่าง/มีนัด' ช่วงไหน (ถ้าไม่ระบุ = ตัวเอง)" }
- summarize_file: { "file_index": 0 }
- my_availability: { "period": "today|tomorrow|week", "person": "ชื่อ/อีเมลคนที่อยากดูตาราง (ถ้าไม่ระบุ = ตัวเอง)" }
- add_task: { "title": "...", "responsible": "...", "due": "YYYY-MM-DD HH:MM หรือ null" }
- complete_task: { "task_id": <number> }
- find_meeting_time: { "attendees": ["email หรือชื่อ"], "duration_min": 30, "note": "..." }
- get_brief / get_news / list_tasks / summarize_meetings: {}

ตัวอย่าง:
"เดือนนี้มีประชุมอะไรบ้าง" -> {"intent":"list_meetings","params":{"period":"month"}}
"วันนี้มีนัดอะไร" -> {"intent":"list_meetings","params":{"period":"today"}}
"ประชุมสัปดาห์นี้" -> {"intent":"list_meetings","params":{"period":"week"}}
"มีประชุมอะไรไหม" -> {"intent":"list_meetings","params":{"period":"upcoming"}}
"วันที่ 31 มีอะไร" -> {"intent":"list_meetings","params":{"date":"31"}}
"วันที่ 31 หลัง 09:30 มีอะไร" -> {"intent":"list_meetings","params":{"date":"31","after":"09:30"}}
"พรุ่งนี้ช่วงบ่ายมีประชุมอะไร" -> {"intent":"list_meetings","params":{"period":"tomorrow","after":"12:00"}}
"นนท์วันที่ 31 หลัง 09:00 ติดอะไร" -> {"intent":"list_meetings","params":{"person":"นนท์","date":"31","after":"09:00"}}
"สมชายพรุ่งนี้ติดประชุมช่วงไหน" -> {"intent":"list_meetings","params":{"person":"สมชาย","period":"tomorrow"}}
(หมายเหตุ: คำถามที่เจาะจง "วันที่/ช่วงเวลา" ว่ามีนัดอะไร ให้ใช้ list_meetings เสมอ ห้ามใช้ get_brief)
(หมายเหตุ: ถ้าถามว่าคนอื่น "ติด/ไม่ว่าง/มีนัด/ติดประชุม" ช่วงไหน ให้ใช้ list_meetings พร้อม person; แต่ถ้าถามว่า "ว่างไหม/ตารางว่าง" ให้ใช้ my_availability)
"ดูตารางว่าง" -> {"intent":"my_availability","params":{"period":"week"}}
"วันนี้ว่างกี่โมง" -> {"intent":"my_availability","params":{"period":"today"}}
"เบสว่างช่วงไหน" -> {"intent":"my_availability","params":{"person":"เบส","period":"week"}}
"งานค้างมีอะไรบ้าง" -> {"intent":"list_tasks","params":{}}
"สรุปงานเช้านี้ให้หน่อย" -> {"intent":"get_brief","params":{}}
"มีข่าวอะไรบ้าง" -> {"intent":"get_news","params":{}}
"สรุปข่าววันนี้" -> {"intent":"get_news","params":{}}
"มีคลิปใหม่อะไรบ้าง" -> {"intent":"get_news","params":{}}
(หมายเหตุ: "ข่าว/ฟีด/คลิป/ช่องที่ติดตาม/subscribe" = get_news; ส่วน "สรุปงาน/เตรียมตัวนัดวันนี้" = get_brief — อย่าสับสน)
"เพิ่มงาน: ส่งรายงานให้ฝ่ายบัญชี ภายในพรุ่งนี้ 5 โมงเย็น" -> {"intent":"add_task","params":{"title":"ส่งรายงานให้ฝ่ายบัญชี","due":"พรุ่งนี้ 17:00"}}
"ปิดงานหมายเลข 3" -> {"intent":"complete_task","params":{"task_id":3}}
"นัดประชุมกับสมชายและสมหญิง 30 นาที" -> {"intent":"find_meeting_time","params":{"attendees":["สมชาย","สมหญิง"],"duration_min":30}}
"ยกเลิกนัด" -> {"intent":"cancel_meeting","params":{}}
"เปิดแผนที่ไปที่ทำงาน" -> {"intent":"open_map","params":{}}
"วางแผนเดินทางไปทำงานพรุ่งนี้" -> {"intent":"plan_commute","params":{"place":"work","period":"tomorrow"}}
"พรุ่งนี้ควรออกจากบ้านกี่โมง" -> {"intent":"plan_commute","params":{"place":"work","period":"tomorrow"}}
"วางแผนเดินทางกลับบ้าน" -> {"intent":"plan_commute","params":{"place":"home","period":"today"}}
(หมายเหตุ: "วางแผน/เผื่อเวลา/ควรออกกี่โมง/พรุ่งนี้ไปทำงาน" = plan_commute (ไม่เปิดแผนที่ทันที); ส่วน "เปิดแผนที่/นำทางเดี๋ยวนี้" = open_map)
"ตั้งที่ทำงานเป็น 199 หมู่ 2 ต.หนองโพ อ.ตาคลี" -> {"intent":"set_work_location","params":{"address":"199 หมู่ 2 ต.หนองโพ อ.ตาคลี"}}
"ดูที่ทำงานที่ตั้งไว้" -> {"intent":"show_work_location","params":{}}
"ลบที่ทำงาน" -> {"intent":"clear_work_location","params":{}}
"เปิดแผนที่กลับบ้าน" -> {"intent":"open_map_home","params":{}}
"ตั้งบ้านเป็น 55 หมู่บ้านสุขใจ" -> {"intent":"set_home_location","params":{"address":"55 หมู่บ้านสุขใจ"}}
"ไปหาลูกค้าบริษัท ABC" -> {"intent":"open_map","params":{"place":"ABC"}}
"หาไฟล์งบประมาณ Q3" -> {"intent":"search_files","params":{"query":"งบประมาณ Q3"}}
"หาไฟล์ excel ai" -> {"intent":"search_files","params":{"query":"ai","filetype":"excel"}}
(หมายเหตุ: คำบอกชนิดไฟล์ เช่น excel/word/pdf/powerpoint ให้แยกไปที่ filetype ห้ามใส่ใน query)
ห้ามแต่งข้อมูลเกินจากที่ผู้ใช้พูด`;

// ---------------------------------------------------------------------------
// Name extraction from scheduling questions (deterministic — see Python original)
// ---------------------------------------------------------------------------
const NAME_PREFIX = [
  "ขอดูตารางว่าง", "ขอดูตาราง", "ดูตารางว่างของ", "ดูตารางว่าง", "ดูตารางของ", "ดูตาราง",
  "ตารางว่างของ", "ตารางว่าง", "ตารางของ", "ตาราง", "ขอเช็คตาราง", "เช็คตาราง", "ขอดู", "ขอเช็ค",
  "เช็ค", "เช็ก", "ดูให้", "ดู", "ขอ", "มีนัดกับ", "มีประชุมกับ", "มีนัด", "มีประชุม", "มี",
  "วันนี้", "พรุ่งนี้", "มะรืนนี้", "มะรืน", "สัปดาห์นี้", "อาทิตย์นี้", "เดือนนี้", "ของ",
];
const NAME_SUFFIX = [
  "ให้หน่อยครับ", "ให้หน่อยค่ะ", "ให้หน่อย", "หน่อยครับ", "หน่อยค่ะ", "หน่อย", "ครับผม", "ครับ",
  "ค่ะ", "คะ", "นะครับ", "นะคะ", "นะ", "จ้า", "ด้วย", "ที",
  "ว่างช่วงไหน", "ว่างกี่โมง", "ว่างไหม", "ว่างมั้ย", "ว่างบ้าง", "ว่างรึเปล่า", "ว่างหรือเปล่า", "ว่าง",
  "ติดประชุมช่วงไหน", "ติดประชุม", "ติดอะไรบ้าง", "ติดอะไร", "ติดคิว", "ติดไหม", "ติดมั้ย", "ติด",
  "มีนัดอะไร", "มีนัดไหม", "มีนัด", "มีประชุมอะไร", "มีประชุม", "มีอะไรบ้าง", "มีอะไร",
  "ช่วงไหน", "ช่วงบ่าย", "ช่วงเช้า", "ช่วงเย็น", "ช่วง", "กี่โมง",
  "หลังเที่ยง", "ก่อนเที่ยง", "เที่ยง", "บ่าย", "เช้า", "เย็น", "หลัง", "ก่อน",
  "อะไรบ้าง", "อะไร", "บ้าง", "ไหม", "มั้ย", "หรือยัง", "หรือเปล่า", "รึเปล่า",
  "วันนี้", "พรุ่งนี้", "สัปดาห์นี้", "เดือนนี้", "ประชุม", "นัด", "คิว",
];
const SELF_WORDS = new Set(["", "ฉัน", "ผม", "ดิฉัน", "ตัวเอง", "เรา", "ของฉัน", "ของผม"]);
const SELF_HINT = ["ของฉัน", "ของผม", "ตัวเอง", "ตัวฉัน", "ผมเอง", "ฉันเอง", "ตารางฉัน", "ตารางผม", "ฉันว่าง", "ผมว่าง", "ของตัวเอง"];

function mentionsSelf(text: string): boolean {
  return SELF_HINT.some((w) => (text || "").includes(w));
}

function personFromText(text: string): string {
  let s = (text || "")
    .replace(/\d{1,2}:\d{2}/g, " ")
    .replace(/\d+/g, " ")
    .replace(/วันที่/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  let changed = true;
  while (changed && s) {
    changed = false;
    for (const p of NAME_PREFIX) {
      if (s.startsWith(p)) {
        s = s.slice(p.length).trim();
        changed = true;
        break;
      }
    }
    if (changed) continue;
    for (const suf of NAME_SUFFIX) {
      if (s.endsWith(suf)) {
        s = s.slice(0, -suf.length).trim();
        changed = true;
        break;
      }
    }
  }
  s = s ? stripHonorificPublic(s).replace(/^[ .,/-]+|[ .,/-]+$/g, "") : "";
  return SELF_WORDS.has(s) ? "" : s;
}

// ---------------------------------------------------------------------------
// Intent parsing
// ---------------------------------------------------------------------------
function historyLines(context?: CommandContext): string[] {
  const lines: string[] = [];
  for (const turn of context?.history || []) {
    const role = turn.role === "me" || turn.role === "user" ? "ผู้ใช้" : "ผู้ช่วย";
    const t = (turn.text || "").trim().replace(/\n/g, " ");
    if (t) lines.push(`${role}: ${t.slice(0, 200)}`);
  }
  return lines.slice(-6);
}

async function parseIntent(text: string, context?: CommandContext): Promise<{ intent: string; params: Record<string, unknown> }> {
  const textClean = text.trim();
  const textLower = textClean.toLowerCase();

  // Fast deterministic rule after a file search
  if (context?.last_intent === "file_results") {
    if (["อ่านและสรุป", "สรุปให้ฟัง", "อ่านสรุป", "สรุปไฟล์", "อ่านไฟล์", "อ่านอันแรก", "สรุปอันแรก"].some((kw) => textLower.includes(kw))) {
      return { intent: "summarize_file", params: { file_index: 0 } };
    }
  }

  let prompt = textClean;
  if (context) {
    const parts: string[] = [];
    const hist = historyLines(context);
    if (hist.length) parts.push("[ประวัติการสนทนาก่อนหน้า]\n" + hist.join("\n"));
    const compact: Record<string, unknown> = {};
    if (context.last_intent) compact.last_intent = context.last_intent;
    if (context.last_person) compact.last_person = context.last_person;
    if (context.files?.length) compact.files = context.files.slice(0, 3).map((f) => f.name).filter(Boolean);
    if (Object.keys(compact).length) parts.push(`[บริบทล่าสุด: ${JSON.stringify(compact)}]`);
    parts.push(`คำสั่งผู้ใช้ล่าสุด: ${textClean}`);
    prompt = parts.join("\n");
  }

  const raw = await chat(INTENT_SYSTEM, prompt, { temperature: 0, json: true });
  try {
    const parsed = JSON.parse(raw);
    return { intent: parsed.intent || "unknown", params: parsed.params || {} };
  } catch {
    return { intent: "unknown", params: {} };
  }
}

async function continuedPerson(
  text: string,
  context?: CommandContext
): Promise<{ name: string | null; mail: string | null; info: UserInfo | null }> {
  if (mentionsSelf(text)) return { name: null, mail: null, info: null };
  const det = personFromText(text);
  if (det) {
    const info = await resolveUserInfo(det);
    if (info?.mail) return { name: det, mail: info.mail, info };
  }
  const lastMail = context?.last_person_mail;
  const lastName = context?.last_person;
  if (lastMail) return { name: lastName || lastMail, mail: lastMail, info: { mail: lastMail, displayName: lastName } };
  if (lastName) return { name: lastName, mail: null, info: null };
  return { name: null, mail: null, info: null };
}

// ---------------------------------------------------------------------------
// Sub-responses
// ---------------------------------------------------------------------------
async function availabilityResponse(
  requesterUpn: string,
  email: string,
  displayName: string,
  period: string
): Promise<CommandResult> {
  const { start, end, label } = periodRange(period);
  const ranges = await freeRanges(email, start, end, requesterUpn);
  const slots = ranges.map((r) => ({
    start: wallIso(r.start),
    end: wallIso(r.end),
    label: `${fmtDateTime(r.start)}-${fmtTime(r.end)}`,
  }));
  const reply = slots.length
    ? `🗓️ เวลาว่างของ ${displayName} (${label}) 👇 เลือกช่วงเพื่อจองได้เลยครับ`
    : formatFree(ranges, label, displayName);
  return { intent: "availability", reply, person: { mail: email, displayName }, slots };
}

function eventStartMinutes(ev: GraphEvent): number | null {
  const d = ev.start?.dateTime ? parseWall(ev.start.dateTime) : null;
  return d ? minutesOfDay(d) : null;
}

function windowLabel(label: string, after: number | null, before: number | null): string {
  if (after !== null && before !== null) return `${label} ช่วง ${fmtHHMM(after)}–${fmtHHMM(before)}`;
  if (after !== null) return `${label} หลัง ${fmtHHMM(after)}`;
  if (before !== null) return `${label} ก่อน ${fmtHHMM(before)}`;
  return label;
}

async function personBusyResponse(
  requesterUpn: string,
  person: string,
  day: { start: Date; end: Date; label: string } | null,
  period: string,
  after: number | null,
  before: number | null,
  preInfo?: UserInfo | null
): Promise<CommandResult> {
  let info = preInfo;
  if (!info?.mail) info = await resolveUserInfo(person);
  if (!info?.mail) {
    return { intent: "list_meetings", reply: `หาคนชื่อ “${person}” ในองค์กรไม่เจอครับ ลองระบุอีเมลได้ไหม` };
  }
  const who = info.displayName || person;
  const range = day || periodRange(period);
  const label = windowLabel(range.label, after, before);

  const inWindow = (m: number | null) =>
    m === null || ((after === null || m >= after) && (before === null || m < before));

  // Prefer the real calendar (shows subjects); fall back to free/busy.
  let events: GraphEvent[] | null = null;
  try {
    events = await getEventsRange(info.mail, wallIso(range.start), wallIso(range.end));
  } catch {
    events = null;
  }

  if (events !== null) {
    const rows: { sd: Date; ed: Date; subj: string }[] = [];
    for (const ev of [...events].sort((a, b) => (a.start?.dateTime || "").localeCompare(b.start?.dateTime || ""))) {
      const m = eventStartMinutes(ev);
      if (m !== null && !inWindow(m)) continue;
      const sd = ev.start?.dateTime ? parseWall(ev.start.dateTime) : null;
      const ed = ev.end?.dateTime ? parseWall(ev.end.dateTime) : null;
      if (!sd || !ed) continue;
      const priv = ["private", "personal", "confidential"].includes((ev.sensitivity || "").toLowerCase());
      rows.push({ sd, ed, subj: priv ? "(นัดส่วนตัว)" : ev.subject || "(ไม่มีหัวข้อ)" });
    }
    if (!rows.length) {
      return {
        intent: "list_meetings",
        reply: `✅ ${who} ว่างครับ (${label}) — ไม่มีนัดในช่วงนี้`,
        person: { mail: info.mail, displayName: who },
      };
    }
    const lines = [`📌 ตารางของ ${who} (${label}):`, ""];
    let lastDay: string | null = null;
    for (const r of rows) {
      const d = fmtDate(r.sd);
      if (d !== lastDay) {
        lines.push(`— ${d} —`);
        lastDay = d;
      }
      lines.push(`  ${fmtTime(r.sd)}-${fmtTime(r.ed)} · ${r.subj}`);
    }
    return { intent: "list_meetings", reply: lines.join("\n"), person: { mail: info.mail, displayName: who } };
  }

  // fallback: free/busy blocks only (no subjects)
  let ranges = await busyRanges(info.mail, range.start, range.end, requesterUpn);
  ranges = ranges.filter(
    (r) => (after === null || minutesOfDay(r.end) > after) && (before === null || minutesOfDay(r.start) < before)
  );
  let reply: string;
  if (!ranges.length) {
    reply = `✅ ${who} ว่างครับ (${label}) — ไม่มีคิวติดในช่วงนี้`;
  } else {
    const lines = [`📌 ${who} ติดคิวช่วงนี้ครับ (${label}):`, "", "(ดูหัวข้อประชุมไม่ได้ — แสดงเฉพาะช่วงเวลาที่ไม่ว่าง)"];
    let lastDay: string | null = null;
    for (const r of ranges) {
      const d = fmtDate(r.start);
      if (d !== lastDay) {
        lines.push(`— ${d} —`);
        lastDay = d;
      }
      lines.push(`  ${fmtTime(r.start)} - ${fmtTime(r.end)} (ไม่ว่าง)`);
    }
    reply = lines.join("\n");
  }
  return { intent: "list_meetings", reply, person: { mail: info.mail, displayName: who } };
}

function formatEventsSimple(events: GraphEvent[], label: string): string {
  if (!events.length) {
    return `ช่วง${label}ยังไม่มีนัดประชุมในปฏิทินครับ 👍\n\nพิมพ์ได้ เช่น “งานค้างมีอะไรบ้าง” หรือ “นัดประชุมกับ...”`;
  }
  const lines = [`🗓️ ประชุม${label} (${events.length} รายการ):`, ""];
  let lastDay: string | null = null;
  for (const ev of [...events].sort((a, b) => (a.start?.dateTime || "").localeCompare(b.start?.dateTime || ""))) {
    const sd = ev.start?.dateTime ? parseWall(ev.start.dateTime) : null;
    const ed = ev.end?.dateTime ? parseWall(ev.end.dateTime) : null;
    const tt = sd && ed ? `${fmtTime(sd)}-${fmtTime(ed)}` : "?";
    const d = sd ? fmtDate(sd) : "?";
    if (d !== lastDay) {
      lines.push(`— ${d} —`);
      lastDay = d;
    }
    lines.push(`  ${tt} · ${ev.subject || "(ไม่มีหัวข้อ)"}`);
  }
  return lines.join("\n");
}

const BOOK_CTX_SYSTEM = `ผู้ใช้ได้เลือกช่วงเวลาว่างของบุคคลไว้แล้ว และกำลังพิมพ์คำสั่งต่อ
ให้ตีความว่าเขาต้องการจองประชุมอย่างไร ตอบเป็น JSON เท่านั้น:
{
  "is_booking": true/false,
  "duration_min": 30,
  "subject": "หัวข้อประชุม",
  "extra_people": []
}
ตัวอย่าง:
"จองเลย" -> {"is_booking":true,"duration_min":30,"subject":"ประชุม","extra_people":[]}
"นัด 1 ชั่วโมง เรื่องอัปเดตงาน IT" -> {"is_booking":true,"duration_min":60,"subject":"อัปเดตงาน IT","extra_people":[]}
"จองพร้อมสมชายด้วย" -> {"is_booking":true,"duration_min":30,"subject":"ประชุม","extra_people":["สมชาย"]}
"ดูงานค้าง" -> {"is_booking":false,"duration_min":30,"subject":"","extra_people":[]}`;

async function bookFromContext(userUpn: string, text: string, sel: NonNullable<CommandContext["selected"]>): Promise<CommandResult | null> {
  const raw = await chat(BOOK_CTX_SYSTEM, text, { temperature: 0, json: true });
  let p: { is_booking?: boolean; duration_min?: number; subject?: string; extra_people?: string[] };
  try {
    p = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!p.is_booking) return null;

  const duration = Number(p.duration_min || 30);
  const subject = p.subject || "ประชุม";
  const person = sel.person || {};
  const attendees: string[] = person.mail ? [person.mail] : [];
  for (const name of p.extra_people || []) {
    const em = await resolveUser(name);
    if (em) attendees.push(em);
  }

  const start = parseWall(sel.start);
  if (!start) return { intent: "error", reply: "⚠️ ช่วงเวลาที่เลือกไม่ถูกต้อง ลองเลือกใหม่อีกครั้งครับ" };
  const end = addMinutes(start, duration);
  try {
    await createEvent(userUpn, subject, wallIso(start), wallIso(end), attendees);
  } catch (e) {
    return {
      intent: "error",
      reply: `⚠️ จองไม่สำเร็จ: ${String(e).slice(0, 150)}\n(อาจต้องเพิ่มสิทธิ์ Calendars.ReadWrite)`,
    };
  }
  const who = person.displayName || attendees[0] || "";
  const extra = attendees.length > 1 ? ` +${attendees.length - 1} คน` : "";
  return {
    intent: "booked",
    reply: `✅ จองประชุมแล้ว!\n📌 ${subject}\n👤 ${who}${extra}\n🕐 ${fmtDateTime(start)} (${duration} นาที)`,
  };
}

async function searchFilesSmart(userUpn: string, query: string, filetype: string) {
  const found = new Map<string, Awaited<ReturnType<typeof searchFiles>>[number]>();
  const add = (items: Awaited<ReturnType<typeof searchFiles>>) => {
    for (const f of items) found.set(f.webUrl || f.name || "", f);
  };
  if (query) {
    add(await searchFiles(userUpn, query));
    if (!found.size) {
      for (const w of query.split(/\s+/)) if (w.length > 1) add(await searchFiles(userUpn, w));
    }
  }
  if (!found.size && filetype) add(await searchFiles(userUpn, filetype));

  let files = [...found.values()];
  if (filetype) {
    const typed = files.filter((f) => (f.name || "").toLowerCase().endsWith("." + filetype));
    if (typed.length) files = typed;
  }
  return files;
}

function navUrl(locationText?: string | null, lat?: string | null, lng?: string | null): string | null {
  if (locationText && locationText.trim().startsWith("http")) return locationText.trim();
  let dest: string;
  if (lat && lng) dest = `${lat},${lng}`;
  else if (locationText && locationText.trim()) dest = locationText.trim();
  else return null;
  return "https://www.google.com/maps/dir/?api=1&destination=" + encodeURIComponent(dest);
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------
export async function handleCommand(
  userUpn: string,
  text: string,
  context?: CommandContext,
  lite = false
): Promise<CommandResult> {
  try {
    return await handle(userUpn, text, context, lite);
  } catch (e) {
    return { intent: "error", reply: `⚠️ เกิดข้อผิดพลาด: ${String(e).slice(0, 200)}` };
  }
}

async function handle(userUpn: string, text: string, context?: CommandContext, lite = false): Promise<CommandResult> {
  // if the user has a selected time slot, try to act on it first
  if (context?.selected) {
    const booked = await bookFromContext(userUpn, text, context.selected);
    if (booked) return booked;
  }

  const { intent, params } = await parseIntent(text, context);

  if (intent === "summarize_file") {
    const files = context?.files || [];
    let target: (typeof files)[number] | null = null;
    if (files.length) {
      const textLower = text.toLowerCase();
      const sorted = [...files].sort((a, b) => (b.name || "").length - (a.name || "").length);
      target = sorted.find((f) => f.name && textLower.includes(f.name.toLowerCase())) || null;
      if (!target) {
        target =
          sorted.find((f) => {
            const noExt = (f.name || "").toLowerCase().replace(/\.[^.]+$/, "");
            return noExt.length > 3 && textLower.includes(noExt);
          }) || null;
      }
      if (!target) target = files.find((f) => !f.is_folder) || files[0];
    }
    if (!target) {
      const res = await searchFiles(userUpn, text);
      if (res.length) target = { id: res[0].id, name: res[0].name, url: res[0].webUrl };
    }
    if (!target) {
      return { intent, reply: "ไม่พบไฟล์ที่ต้องการให้อ่านและสรุปครับ ลองพิมพ์ค้นหาไฟล์ก่อน เช่น “หาไฟล์ ...”" };
    }
    const fileName = target.name || "เอกสาร";
    if (target.is_folder) {
      return {
        intent,
        reply: `📁 **โฟลเดอร์:** ${fileName}\n\n(เป็นโฟลเดอร์จัดเก็บเอกสาร สามารถคลิกเพื่อดูไฟล์ฉบับเต็มด้านในบน OneDrive ได้ครับ)`,
      };
    }
    if ([".jpg", ".jpeg", ".png", ".gif"].some((ext) => fileName.toLowerCase().endsWith(ext))) {
      return {
        intent,
        reply: `🖼️ **ไฟล์รูปภาพ:** ${fileName}\n\n(ไฟล์นี้เป็นรูปภาพ สามารถคลิกเปิดดูรูปภาพฉบับเต็มบน OneDrive ได้จากลิงก์ด้านบนครับ)`,
      };
    }
    // Text extraction from Office ZIPs isn't ported yet — summarize what we can fetch as text.
    return {
      intent,
      reply: `📄 **ไฟล์:** ${fileName}\n\n(สามารถคลิกเปิดดูไฟล์บน OneDrive ได้จากลิงก์ด้านบนครับ)`,
    };
  }

  if (intent === "get_brief") {
    if (lite) {
      const { start, end } = periodRange("today");
      return {
        intent,
        reply: formatEventsSimple(await getEventsRange(userUpn, wallIso(start), wallIso(end)), "วันนี้"),
      };
    }
    return { intent, reply: await buildForToday(userUpn) };
  }

  if (intent === "get_news") {
    const { stories, skipped, note } = await buildDigest(userUpn);
    if (!stories.length) {
      const extra = skipped.length ? `\n(ข้าม: ${skipped.join(", ")})` : "";
      return {
        intent,
        reply:
          (note || "ยังไม่มีข่าวให้สรุปครับ") +
          "\n\nเชื่อม YouTube หรือเพิ่มแหล่งข่าวได้ที่หน้า “ติดตามข่าว / ฟีด” แล้วลองพิมพ์ “มีข่าวอะไรบ้าง” อีกครั้งครับ" +
          extra,
      };
    }
    const extra = skipped.length ? `\n\n(ข้ามบางแหล่ง: ${skipped.join(", ")})` : "";
    return { intent, reply: formatStoriesText(stories) + extra, data: stories };
  }

  if (intent === "list_meetings") {
    const period = (params.period as string) || "upcoming";
    const day = params.date ? resolveDay(String(params.date)) : null;
    const after = parseHHMM(params.after);
    const before = parseHHMM(params.before);

    const { name: person, info: personInfo } = await continuedPerson(text, context);
    if (person) return personBusyResponse(userUpn, person, day, period, after, before, personInfo);

    let { start, end, label } = day || periodRange(period);
    let events = await getEventsRange(userUpn, wallIso(start), wallIso(end));

    if (!events.length && !day && (period === "today" || period === "tomorrow")) {
      const up = periodRange("upcoming");
      events = await getEventsRange(userUpn, wallIso(up.start), wallIso(up.end));
      if (events.length) label = `${label}ไม่มีนัด — นัดที่กำลังจะมาถึง (${up.label})`;
      start = up.start;
      end = up.end;
    }

    if (after !== null || before !== null) {
      events = events.filter((ev) => {
        const m = eventStartMinutes(ev);
        if (m === null) return false;
        return (after === null || m >= after) && (before === null || m < before);
      });
      label = windowLabel(label, after, before);
    }

    if (!events.length) {
      return {
        intent,
        reply:
          `ช่วง${label}ยังไม่มีนัดประชุมในปฏิทินครับ 👍\n\n` +
          "ระหว่างนี้ผมช่วยอะไรได้บ้าง เช่น:\n" +
          "  • ดูงานที่ต้องติดตาม — พิมพ์ “งานค้างมีอะไรบ้าง”\n" +
          "  • นัดประชุมใหม่ — พิมพ์ “นัดประชุมกับ...”\n" +
          "  • เพิ่มงานเตือนความจำ — พิมพ์ “เพิ่มงาน: ...”",
        data: [],
      };
    }
    const reply = lite ? formatEventsSimple(events, label) : await buildForEvents(userUpn, events, label);
    return { intent, reply, data: events };
  }

  if (intent === "my_availability") {
    const period = (params.period as string) || "week";
    const det = mentionsSelf(text) ? "" : personFromText(text);
    if (det) {
      const cands = await searchUsers(det);
      if (cands.length > 1) {
        return {
          intent: "choose_person",
          reply: `เจอหลายคนที่ตรงกับ “${det}” เลือกคนที่ต้องการดูตารางครับ 👇`,
          choices: cands.map((c) => ({ mail: c.mail, displayName: c.displayName, period })),
        };
      }
      if (cands.length === 1) {
        return availabilityResponse(userUpn, cands[0].mail, cands[0].displayName || det, period);
      }
      // name didn't resolve → fall through to the ongoing subject
    }
    if (!mentionsSelf(text)) {
      const lastMail = context?.last_person_mail;
      const lastName = context?.last_person;
      if (lastMail) return availabilityResponse(userUpn, lastMail, lastName || lastMail, period);
      if (lastName) {
        const cands = await searchUsers(lastName);
        if (cands.length === 1) return availabilityResponse(userUpn, cands[0].mail, cands[0].displayName || lastName, period);
      }
    }
    const { start, end, label } = periodRange(period);
    const ranges = await freeRanges(userUpn, start, end, userUpn);
    return { intent, reply: formatFree(ranges, label) };
  }

  if (intent === "set_work_location" || intent === "set_home_location") {
    const isHome = intent === "set_home_location";
    const addr = String(params.address || "").trim();
    if (!addr) {
      return { intent, reply: isHome ? "ระบุที่อยู่บ้านด้วยครับ เช่น “ตั้งบ้านเป็น ...”" : "ระบุที่อยู่ที่ทำงานด้วยครับ เช่น “ตั้งที่ทำงานเป็น ...”" };
    }
    await addPlace(userUpn, isHome ? "home" : "work", addr, addr, true);
    return {
      intent,
      reply: isHome
        ? `บันทึกบ้านแล้วครับ 🏠\n${addr}`
        : `บันทึกที่ทำงานหลักแล้วครับ 📍\n${addr}\nต่อไปพิมพ์ “เปิดแผนที่ไปที่ทำงาน” ได้เลย`,
    };
  }

  if (intent === "show_work_location") {
    const p = await getPrimaryPlace(userUpn, "work");
    if (!p) return { intent, reply: "ยังไม่ได้ตั้งที่ทำงานครับ ตั้งได้ที่เมนู ⚙️ หรือพิมพ์ “ตั้งที่ทำงานเป็น ...”" };
    return { intent, reply: `📍 ที่ทำงานหลัก: ${p.label}\n${p.location || ""}` };
  }

  if (intent === "clear_work_location") {
    const p = await getPrimaryPlace(userUpn, "work");
    if (p) await deletePlace(p.id);
    return { intent, reply: "ลบที่ทำงานหลักที่ตั้งไว้แล้วครับ" };
  }

  if (intent === "open_map" || intent === "open_map_home") {
    const category = intent === "open_map_home" ? "home" : "work";
    let where = category === "home" ? "บ้าน" : "ที่ทำงาน";
    const placeQuery = String(params.place || "").trim();
    let place = null;
    if (placeQuery) {
      const matches = (await listPlaces(userUpn)).filter((p) =>
        (p.label || "").toLowerCase().includes(placeQuery.toLowerCase())
      );
      place = matches[0] || null;
      where = place ? place.label : placeQuery;
    } else {
      place = await getPrimaryPlace(userUpn, category);
    }
    if (!place) return { intent, reply: `ยังไม่ได้ตั้ง${where}ครับ ตั้งได้ที่เมนู ⚙️ หรือพิมพ์ “ตั้ง${where}เป็น ...”` };
    const url = navUrl(place.location, place.lat, place.lng);
    if (!url) return { intent, reply: `“${where}” ยังไม่มีที่อยู่/พิกัดครับ แก้ไขได้ที่เมนู ⚙️` };
    await incrementVisit(place.id);
    return { intent, reply: `เปิดแผนที่ไป${where}ให้แล้วครับ 🗺️`, map_url: url };
  }

  if (intent === "plan_commute") {
    const category = params.place === "home" ? "home" : "work";
    const where = category === "home" ? "บ้าน" : "ที่ทำงาน";
    const place = await getPrimaryPlace(userUpn, category);
    if (!place) {
      return { intent, reply: `ยังไม่ได้ตั้ง${where}ครับ ตั้งได้ที่เมนู ⚙️ ก่อนนะครับ แล้วผมจะช่วยวางแผนให้` };
    }
    const url = navUrl(place.location, place.lat, place.lng);

    const day = params.date ? resolveDay(String(params.date)) : null;
    const { start, end, label: dayLabel } = day || periodRange((params.period as string) || "tomorrow");

    let first: { m: number; subj: string } | null = null;
    for (const ev of await getEventsRange(userUpn, wallIso(start), wallIso(end))) {
      const m = eventStartMinutes(ev);
      if (m === null) continue;
      if (!first || m < first.m) {
        const priv = ["private", "personal", "confidential"].includes((ev.sensitivity || "").toLowerCase());
        first = { m, subj: priv ? "(นัดส่วนตัว)" : ev.subject || "(ไม่มีหัวข้อ)" };
      }
    }

    const s = await allSettings(userUpn);
    const workStart = s.work_start || `${String(WORK_START_HOUR).padStart(2, "0")}:00`;

    const lines = [`🚗 วางแผนเดินทางไป${where} (${dayLabel})`, ""];
    if (category === "work") {
      let arrive = workStart;
      lines.push(`🕗 เข้างาน ${workStart} น.`);
      if (first) {
        const fh = fmtHHMM(first.m);
        lines.push(`📌 นัดแรก ${fh} น. — ${first.subj}`);
        if (fh < workStart) arrive = fh;
      }
      lines.push("", `👉 ควรไปถึงก่อน ${arrive} น. เผื่อเวลาเดินทาง+หาที่จอดด้วยนะครับ`);
    } else {
      lines.push("👉 กดปุ่มด้านล่างเพื่อดูเส้นทาง/สภาพจราจรก่อนออกเดินทางได้เลยครับ");
    }
    lines.push(url ? "แตะปุ่มด้านล่างเพื่อเปิดเส้นทาง (ดูเวลาเดินทางจริงจากการจราจรได้)" : `(“${where}” ยังไม่มีพิกัด/ที่อยู่ครบ เปิดเส้นทางไม่ได้ — เพิ่มได้ที่ ⚙️)`);
    return { intent, reply: lines.join("\n"), map_url: url, map_where: where };
  }

  if (intent === "search_files") {
    const q = String(params.query || "").trim();
    let ft = String(params.filetype || "").trim().toLowerCase();
    ft = ({ excel: "xlsx", word: "docx", powerpoint: "pptx", ppt: "pptx", สเปรดชีต: "xlsx", เอกสาร: "docx" } as Record<string, string>)[ft] || ft;
    if (!q && !ft) return { intent, reply: "ระบุคำค้นไฟล์ด้วยครับ เช่น “หาไฟล์งบประมาณ”" };
    const files = await searchFilesSmart(userUpn, q, ft);
    if (!files.length) {
      const what = q || `ชนิด .${ft}`;
      return { intent, reply: `ไม่พบไฟล์ที่ตรงกับ “${what}” ใน OneDrive ครับ` };
    }
    const label = q || `.${ft}`;
    return {
      intent: "file_results",
      reply: `เจอ ${files.length} ไฟล์ที่ตรงกับ “${label}” ครับ 👇`,
      files: files.map((f) => ({
        id: f.id,
        name: f.name,
        url: f.webUrl,
        is_folder: !!(f as { folder?: unknown }).folder,
        modified: f.lastModifiedDateTime,
      })),
    };
  }

  if (intent === "cancel_meeting") {
    const { start, end } = periodRange("upcoming");
    const events = await getEventsRange(userUpn, wallIso(start), wallIso(end));
    if (!events.length) return { intent, reply: "ไม่มีนัดที่จะยกเลิกในช่วง 2 สัปดาห์ข้างหน้าครับ" };
    const choices = events.map((ev) => {
      const sd = ev.start?.dateTime ? parseWall(ev.start.dateTime) : null;
      return { event_id: ev.id, label: `${sd ? fmtDateTime(sd) : "?"} — ${ev.subject || "(ไม่มีหัวข้อ)"}` };
    });
    return { intent: "choose_cancel", reply: "เลือกนัดที่ต้องการยกเลิกครับ 👇", choices };
  }

  if (intent === "list_tasks") {
    const tasks = await listTasks(userUpn);
    const pending = tasks.filter((t) => t.status === "pending" || t.status === "overdue");
    return { intent, reply: `มีงานค้าง ${pending.length} รายการ`, data: pending };
  }

  if (intent === "add_task") {
    const title = String(params.title || "").trim();
    if (!title) return { intent, reply: "ไม่พบชื่องานที่จะเพิ่ม" };
    const responsible = String(params.responsible || "");
    const tid = await addTask({
      owner_upn: userUpn,
      title,
      responsible,
      responsible_upn: await resolveResponsible(responsible),
      due: normalizeDue(params.due),
      source: "manual",
    });
    return { intent, reply: `เพิ่มงานแล้ว (#${tid}): ${title}`, data: { id: tid } };
  }

  if (intent === "complete_task") {
    const tid = Number(params.task_id);
    if (tid && (await updateTaskStatus(tid, "done"))) return { intent, reply: `ปิดงาน #${tid} แล้ว` };
    return { intent, reply: "ไม่พบงานหมายเลขนั้น" };
  }

  if (intent === "summarize_meetings") {
    const choices = await listRecentOnline(userUpn);
    if (!choices.length) return { intent, reply: "ไม่พบประชุมออนไลน์ที่จบไปแล้วใน 14 วันที่ผ่านมาครับ" };
    return { intent: "choose_meeting", reply: "พบประชุมที่ผ่านมา เลือกอันที่ต้องการสรุปได้เลยครับ 👇", choices };
  }

  if (intent === "find_meeting_time") {
    const attendeesRaw = (params.attendees as string[]) || [];
    const duration = Number(params.duration_min || 30);
    const subject = String(params.note || params.subject || "ประชุม");

    const resolved: string[] = [];
    const unresolved: string[] = [];
    for (const a of attendeesRaw) {
      const em = await resolveUser(a);
      if (em) resolved.push(em);
      else unresolved.push(a);
    }
    if (!resolved.length) return { intent, reply: "ยังไม่ทราบว่าจะนัดกับใคร ลองระบุอีเมลผู้เข้าร่วมได้ไหมครับ" };

    const result = await findCommonSlots(userUpn, resolved, duration);
    if (!result.slots.length) return { intent, reply: formatBusy(result.busy) };

    if (AUTO_BOOK) {
      const s = result.slots[0];
      await createEvent(userUpn, subject, s.start, s.end, resolved);
      return { intent, reply: `จองให้เลยตามที่ตั้งค่าไว้ ✅\n${subject} — ${s.label}` };
    }
    const note = unresolved.length ? `\n(หาอีเมลไม่เจอ: ${unresolved.join(", ")})` : "";
    return {
      intent: "choose_slot",
      reply: `เจอเวลาที่ทุกคนว่างตรงกันครับ เลือกเพื่อจองได้เลย 👇${note}`,
      slots: result.slots,
      meeting: { attendees: resolved, duration, subject },
    };
  }

  return { intent: "unknown", reply: "ยังไม่เข้าใจคำสั่งนี้ ลองพิมพ์ใหม่อีกครั้งได้ไหมครับ" };
}
