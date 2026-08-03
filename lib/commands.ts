// Natural-language command handling — ported from morning_brief/commands.py.
// The web / LINE sends free text; the LLM classifies it into an intent + params
// and we execute. Booking asks for confirmation first (choose_slot) per requirement.
import { buildForEvents, buildMorningAgenda, buildMeetingPrep, resolveAgendaEventId } from "@/lib/brief";
import { buildDigest, formatStoriesText } from "@/lib/digest";
import { normalizeDue, resolveResponsible } from "@/lib/followup";
import {
  GraphEvent,
  UserInfo,
  createEvent,
  deleteEvent,
  getEventsRange,
  resolveUser,
  resolveUserInfo,
  searchFiles,
  searchUsers,
  stripHonorificPublic,
} from "@/lib/graph";
import { getUserGraphToken } from "@/lib/graphAuth";
import { chat } from "@/lib/llm";
import { listRecentOnline } from "@/lib/meetings";
import { calendarConsentNeededMessage } from "@/lib/msGraphOAuth";
import { notifyMeetingInviteOnLine } from "@/lib/meetingInvite";
import { busyRanges, findCommonSlots, formatBusy, formatFree, freeRanges, wantsLunchIncluded } from "@/lib/scheduling";
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
  listManagedFeeds,
  previewFeed,
  upsertFeed,
  updateFeed,
  deleteFeed,
  formatFeedList,
  resolveFeedByIndexOrId,
  detectFeedKind,
  getFeed,
} from "@/lib/feeds";
import {
  addMinutes,
  fmtDate,
  fmtDateTime,
  fmtHHMM,
  fmtTime,
  minutesOfDay,
  nowWall,
  parseHHMM,
  parseWall,
  periodRange,
  resolveDay,
  resolveWeekday,
  wallIso,
} from "@/lib/time";

const WORK_START_HOUR = Number(process.env.WORK_START_HOUR || 9);
const WORK_END_HOUR = Number(process.env.WORK_END_HOUR || 17);
const AUTO_BOOK = (process.env.AUTO_BOOK || "false").toLowerCase() === "true";

export type CommandContext = {
  history?: { role?: string; text?: string; ts?: number }[];
  /** Compact gist of turns that aged out of the 30-minute window. */
  summary?: string;
  last_intent?: string;
  last_person?: string;
  last_person_mail?: string;
  /** Last calendar day scope the user was talking about (today/tomorrow/week/…). */
  last_period?: string;
  files?: { id?: string; name?: string; url?: string; is_folder?: boolean }[];
  selected?: { start: string; person?: { mail?: string; displayName?: string } };
  /** Last multi-person schedule search — used for follow-ups like "ตอนเย็นว่างไหม". */
  last_meeting?: {
    attendees: string[];
    duration: number;
    subject?: string;
    window?: { start: string; end: string; label: string };
  };
};

export type CommandResult = {
  intent: string;
  reply: string;
  data?: unknown;
  files?: unknown[];
  slots?: unknown[];
  ranges?: unknown[];
  choices?: unknown[];
  /** Day scope used for this reply — stored so follow-ups keep the same day. */
  period?: string;
  meeting?: {
    attendees: string[];
    duration: number;
    subject: string;
    window?: { start: string; end: string; label: string };
  };
  person?: { mail: string; displayName?: string };
  map_url?: string | null;
  map_where?: string;
  /** LINE quick-reply follow-ups (message actions). */
  suggestions?: { label: string; text: string }[];
};

/** Interactive calendar must use the user's M365 token (Outlook-like rights). */
function needCalendarConsent(): CommandResult | null {
  if (getUserGraphToken()) return null;
  return { intent: "need_calendar_consent", reply: calendarConsentNeededMessage() };
}

const INTENT_SYSTEM = `คุณคือตัวแยกเจตนา (intent parser) ของผู้ช่วยงาน
ผู้ใช้จะพิมพ์คำสั่งภาษาไทย/อังกฤษ ให้ตอบกลับเป็น JSON เท่านั้น:

{
  "intent": "<หนึ่งใน: get_brief | prep_meeting | get_news | list_feeds | add_feed | remove_feed | edit_feed | list_meetings | my_availability | list_tasks | add_task | complete_task | summarize_meetings | find_meeting_time | cancel_meeting | open_map | open_map_home | plan_commute | set_work_location | set_home_location | show_work_location | clear_work_location | search_files | summarize_file | unknown>",
  "params": { ... }
}

ความหมายของแต่ละ intent:
- get_brief = ดูรายการตาราง/นัดวันนี้ (แสดงทั้งหมดแล้วถามว่าอยากให้แนะนำเตรียมตัวนัดไหน) — เช่น "สรุปตารางเช้า", "ตารางวันนี้", "มีนัดอะไรบ้างเช้านี้"
- prep_meeting = แนะนำเตรียมตัวนัดที่เลือก (อ่านหัวข้อ/รายละเอียดอีเมล/ไฟล์แนบ/ลิงก์) — เช่น "เตรียมนัด 1", "แนะนำประชุม 2", "ช่วยเตรียมตัวนัด Weekly Sync"
- get_news = สรุปเนื้อหาข่าว/โพสต์จากแหล่งที่ติดตามแล้ว — เช่น "มีข่าวอะไรบ้าง", "สรุปข่าววันนี้", "มีคลิปใหม่อะไรบ้าง" (ห้ามใช้เมื่อผู้ใช้ถามแค่ว่าติดตามแหล่งไหน)
- list_feeds = ดูรายการแหล่งข่าวที่ติดตาม (Facebook/RSS) — เช่น "ดูแหล่งข่าว", "รายการฟีด", "ติดตามอะไรบ้าง", "ตอนนี้ติดตามข่าวอะไรบ้าง", "ติดตามเพจอะไรบ้าง" (ไม่ใช่การสรุปข่าว)
- add_feed = เพิ่มแหล่งข่าว Facebook หรือ RSS — เช่น "เพิ่มแหล่งข่าว https://...", "ติดตามเพจ https://facebook.com/...", "เพิ่ม RSS https://... ชื่อ Extreme"
- remove_feed = ลบแหล่งข่าว — เช่น "ลบแหล่งข่าว", "เลิกติดตามเพจ", "ลบฟีด 1", "ลบแหล่งข่าวหมายเลข 2"
- edit_feed = แก้ชื่อหรือลิงก์แหล่งข่าว — เช่น "แก้ชื่อแหล่งข่าว 1 เป็น Extreme IT", "เปลี่ยนลิงก์แหล่ง 2 เป็น https://..."
- list_meetings = ดู "รายการประชุม/นัด" ในปฏิทิน (วันนี้/พรุ่งนี้/สัปดาห์นี้/เดือนนี้)
- my_availability = ดู "เวลาว่างของตัวเอง" ในปฏิทิน (ช่วงไหนว่าง/ตารางว่าง)
- list_tasks = ดูงานที่ต้องติดตาม (ไม่ใช่ประชุม)
- summarize_meetings = สรุป "ประชุมที่จบไปแล้ว" จาก transcript
- summarize_file = อ่านหรือสรุปเนื้อหาในไฟล์ที่ค้นพบ หรือไฟล์ที่ผู้ใช้อ้างถึง (เช่น "อ่านและสรุป", "สรุปไฟล์นี้", "อ่านอันแรก", "สรุปให้ฟัง")
- search_files = ค้นหาไฟล์ใน OneDrive

สำคัญ: หากบริบทก่อนหน้าเพิ่งมีการค้นหาไฟล์ (search_files หรือ file_results) แล้วผู้ใช้พิมพ์ว่า "อ่านและสรุป", "สรุปให้ฟัง", "อ่านไฟล์" ให้เลือก intent เป็น "summarize_file" เสมอ (ห้ามเลือก get_brief)!

ความต่อเนื่องของบทสนทนา (สำคัญมาก — ห้ามเริ่มคิดใหม่เอง):
ระบบจะแนบ [ประวัติการสนทนาก่อนหน้า] และ [บริบทล่าสุด] (มี last_person / last_meeting / summary) มาให้ ให้ถือว่าบทสนทนาต่อเนื่องกันเสมอ:
- จำบริบทได้ประมาณ 30 นาทีหลังข้อความล่าสุด — ถ้าไม่มีประวัติแนบมา ให้ถือว่าเป็นเรื่องใหม่
- ถ้ามี “สรุปเรื่องก่อนหน้า” ให้ใช้เป็นบริบทยาว แต่รายละเอียดล่าสุดในประวัติสำคัญกว่า
- ถ้าเพิ่งหาเวลาว่างตรงกันหลายคน (last_meeting มี attendees) แล้วผู้ใช้พิมพ์เจาะจงช่วงเวลาโดยไม่เอ่ยชื่อใหม่ เช่น "ตอนเย็นว่างไหม", "แล้วบ่ายล่ะ", "เช้าว่างไหม" → ใช้ intent "find_meeting_time" และใส่ after/before ตามช่วง (เช้า≈09:00-12:00, บ่าย≈12:00-16:00, เย็น≈16:00-20:00) โดย attendees ปล่อยว่างได้ (ระบบจะใช้ last_meeting)
- ถ้าผู้ใช้พิมพ์ต่อเนื่องโดย "ไม่ได้เอ่ยชื่อคนใหม่" (เช่น เจาะจงวัน/เวลาเพิ่ม เช่น "วันที่ 30 ตอน 9 โมง", "แล้วบ่ายล่ะ", "ช่วงเช้าว่างไหม") ให้เข้าใจว่ายังพูดถึงคน/เรื่องเดิมใน last_person — ต้องปล่อย params.person ให้ "ว่าง" ไว้ (ระบบจะเติม last_person ให้เอง)
- ห้ามตีความคำบอกวัน/เวลา เช่น "ตอน", "โมง", "เช้า", "บ่าย", "เย็น", "ครึ่ง", "ทุ่ม" เป็นชื่อคนเด็ดขาด
- ใส่ params.person เฉพาะเมื่อผู้ใช้เอ่ย "ชื่อคนใหม่จริง ๆ" เท่านั้น

การอ้างอิงวัน/เวลา (สำคัญมาก — คำนวณเองจาก [เวลาปัจจุบัน] ที่แนบมา):
ระบบจะแนบ [เวลาปัจจุบัน] (รู้ว่าวันนี้วันอะไร วันที่เท่าไร) มาให้ทุกครั้ง ให้ใช้คำนวณคำพูดสัมพัทธ์เกี่ยวกับวันเป็น "วันที่จริง" แล้วใส่ params.date รูปแบบ YYYY-MM-DD เสมอ:
- ชื่อวัน (จันทร์/อังคาร/พุธ/พฤหัส/ศุกร์/เสาร์/อาทิตย์), "เสาร์นี้", "จันทร์หน้า", "มะรืน", "อีก 3 วัน", "สิ้นเดือน", "วันที่ 5" ฯลฯ → คำนวณเป็นวันที่จริง (วันถัดไปที่ตรง ถ้าไม่ได้พูดถึงอดีต)
- ใช้ period เฉพาะช่วงกว้างที่ไม่ใช่วันเดียว: today/tomorrow/week/month/upcoming
- เวลา (โมง/นาฬิกา/ตอน..โมง) → ใส่ at/after/before ตามเดิม
อย่าเดาวันที่ถ้าผู้ใช้ไม่ได้พูดถึงวัน — ปล่อยว่างไว้

รายละเอียด params:
- list_meetings: { "period": "today|tomorrow|week|month|upcoming", "date": "วันที่เจาะจง เช่น 31 หรือ 2026-07-31 (ถ้าผู้ใช้ระบุวัน)", "weekday": "ชื่อวันในสัปดาห์เป็น mon|tue|wed|thu|fri|sat|sun (ถ้าผู้ใช้พูดชื่อวัน เช่น วันจันทร์/เสาร์นี้/อาทิตย์หน้า)", "after": "HH:MM (ถ้าบอก เช่น หลัง 9 โมงครึ่ง)", "before": "HH:MM (ถ้าบอก เช่น ก่อนเที่ยง)", "at": "HH:MM (ถ้าถามเจาะจงเวลา 'จุดเดียว' เช่น '10 โมงติดอะไร', 'ตอนบ่ายสองว่างไหม', 'ตอน 9 โมงติดไหม')", "person": "ชื่อ/อีเมลคนอื่น ถ้าถามว่าคนนั้น 'ติด/ไม่ว่าง/มีนัด' ช่วงไหน (ถ้าไม่ระบุ = ตัวเอง)" }
- summarize_file: { "file_index": 0 }
- my_availability: { "period": "today|tomorrow|week", "weekday": "mon|tue|wed|thu|fri|sat|sun (ถ้าพูดชื่อวัน เช่น เสาร์นี้ว่างไหม)", "person": "ชื่อ/อีเมลคนที่อยากดูตาราง (ถ้าไม่ระบุ = ตัวเอง)" }
- ถ้าประวัติ/บริบทรอบก่อนพูดถึงวันใดวันหนึ่ง (เช่น พรุ่งนี้ / last_period) แล้วผู้ใช้ถามต่อแบบไม่ระบุวัน เช่น "ขอตารางว่าง", "ว่างกี่โมง", "แล้วว่างไหม" → คง period/วันเดิมจากบริบท (ห้ามดีฟอลต์เป็นวันนี้)
- add_task: { "title": "...", "responsible": "...", "due": "YYYY-MM-DD HH:MM หรือ null" }
- complete_task: { "task_id": <number> }
- find_meeting_time: { "attendees": ["email หรือชื่อ"], "duration_min": 30, "weekday": "mon|tue|… (ถ้าพูดชื่อวัน เช่น วันจันทร์นี้)", "date": "YYYY-MM-DD หรือ 31 (ถ้าเจาะจงวันที่)", "period": "today|tomorrow|week (ถ้าไม่ได้เจาะจงวัน)", "after": "HH:MM (เช้า/บ่าย/เย็น หรือหลัง…)", "before": "HH:MM", "note": "..." }
- get_brief / get_news / list_tasks / summarize_meetings / list_feeds: {}
- prep_meeting: { "meeting_index": 1 }  หรือ { "subject": "ชื่อนัดถ้าพิมพ์ชื่อ" }
- add_feed: { "url": "ลิงก์เพจหรือ RSS", "kind": "rss|facebook (ถ้าชัดเจน)", "label": "ชื่อย่อ (ถ้ามี)" }
- remove_feed: { "feed_index": 1, "feed_id": null }  (ถ้ายังไม่ระบุหมายเลข ปล่อยว่าง — ระบบจะให้เลือก)
- edit_feed: { "feed_index": 1, "label": "ชื่อใหม่", "url": "ลิงก์ใหม่ถ้าเปลี่ยน" }

ตัวอย่าง:
"สรุปตารางเช้า" -> {"intent":"get_brief","params":{}}
"ตารางวันนี้มีอะไรบ้าง" -> {"intent":"get_brief","params":{}}
"เตรียมนัด 1" -> {"intent":"prep_meeting","params":{"meeting_index":1}}
"แนะนำประชุม 2" -> {"intent":"prep_meeting","params":{"meeting_index":2}}
"ช่วยเตรียมตัวนัด Weekly Sync" -> {"intent":"prep_meeting","params":{"subject":"Weekly Sync"}}
"ดูแหล่งข่าว" -> {"intent":"list_feeds","params":{}}
"รายการฟีดที่ติดตาม" -> {"intent":"list_feeds","params":{}}
"ตอนนี้ติดตามข่าวอะไรบ้าง" -> {"intent":"list_feeds","params":{}}
"ติดตามอะไรบ้าง" -> {"intent":"list_feeds","params":{}}
"มีข่าวอะไรบ้าง" -> {"intent":"get_news","params":{}}
"เพิ่มแหล่งข่าว https://www.extreme.co.th/feed" -> {"intent":"add_feed","params":{"url":"https://www.extreme.co.th/feed","kind":"rss"}}
"ติดตามเพจ https://www.facebook.com/ExtremeIT ชื่อ Extreme" -> {"intent":"add_feed","params":{"url":"https://www.facebook.com/ExtremeIT","kind":"facebook","label":"Extreme"}}
"เพิ่ม RSS https://example.com/rss.xml ชื่อข่าวไอที" -> {"intent":"add_feed","params":{"url":"https://example.com/rss.xml","kind":"rss","label":"ข่าวไอที"}}
"ลบแหล่งข่าว" -> {"intent":"remove_feed","params":{}}
"ลบฟีด 1" -> {"intent":"remove_feed","params":{"feed_index":1}}
"เลิกติดตามแหล่งข่าวหมายเลข 2" -> {"intent":"remove_feed","params":{"feed_index":2}}
"แก้ชื่อแหล่งข่าว 1 เป็น Extreme IT" -> {"intent":"edit_feed","params":{"feed_index":1,"label":"Extreme IT"}}
"เปลี่ยนลิงก์แหล่ง 2 เป็น https://example.com/feed" -> {"intent":"edit_feed","params":{"feed_index":2,"url":"https://example.com/feed"}}
"เดือนนี้มีประชุมอะไรบ้าง" -> {"intent":"list_meetings","params":{"period":"month"}}
"วันนี้มีนัดอะไร" -> {"intent":"list_meetings","params":{"period":"today"}}
"ประชุมสัปดาห์นี้" -> {"intent":"list_meetings","params":{"period":"week"}}
"มีประชุมอะไรไหม" -> {"intent":"list_meetings","params":{"period":"upcoming"}}
"วันที่ 31 มีอะไร" -> {"intent":"list_meetings","params":{"date":"31"}}
"วันที่ 31 หลัง 09:30 มีอะไร" -> {"intent":"list_meetings","params":{"date":"31","after":"09:30"}}
"พรุ่งนี้ช่วงบ่ายมีประชุมอะไร" -> {"intent":"list_meetings","params":{"period":"tomorrow","after":"12:00"}}
"10 โมงติดอะไร" -> {"intent":"list_meetings","params":{"period":"today","at":"10:00"}}
"ตอนบ่ายสองว่างไหม" -> {"intent":"list_meetings","params":{"period":"today","at":"14:00"}}
"พรุ่งนี้ 9 โมงติดไหม" -> {"intent":"list_meetings","params":{"period":"tomorrow","at":"09:00"}}
"วันจันทร์ 9 โมงติดอะไร" -> {"intent":"list_meetings","params":{"weekday":"mon","at":"09:00"}}
"วันศุกร์มีประชุมอะไร" -> {"intent":"list_meetings","params":{"weekday":"fri"}}
"เสาร์นี้ว่างกี่โมง" -> {"intent":"my_availability","params":{"weekday":"sat"}}
(หมายเหตุ: ชื่อวัน จันทร์/อังคาร/พุธ/พฤหัส/ศุกร์/เสาร์/อาทิตย์ = ใส่ weekday (mon..sun); "วันนี้/พรุ่งนี้" = period; วันที่ตัวเลข = date)
(หมายเหตุ: "ตอน X โมง / X โมงติดไหม" = ถามจุดเวลาเดียว ใช้ at; ส่วน "หลัง X โมง" = after, "ก่อน X โมง" = before)
"นนท์วันที่ 31 หลัง 09:00 ติดอะไร" -> {"intent":"list_meetings","params":{"person":"นนท์","date":"31","after":"09:00"}}
"สมชายพรุ่งนี้ติดประชุมช่วงไหน" -> {"intent":"list_meetings","params":{"person":"สมชาย","period":"tomorrow"}}
(หมายเหตุ: คำถามที่เจาะจง "วันที่/ช่วงเวลา" ว่ามีนัดอะไร ให้ใช้ list_meetings เสมอ ห้ามใช้ get_brief)
(หมายเหตุ: ถ้าถามว่าคนอื่น "ติด/ไม่ว่าง/มีนัด/ติดประชุม" ช่วงไหน ให้ใช้ list_meetings พร้อม person; แต่ถ้าถามว่า "ว่างไหม/ตารางว่าง" ให้ใช้ my_availability)
"ดูตารางว่าง" -> {"intent":"my_availability","params":{"period":"week"}}
"วันนี้ว่างกี่โมง" -> {"intent":"my_availability","params":{"period":"today"}}
"พรุ่งนี้ว่างไหม" -> {"intent":"my_availability","params":{"period":"tomorrow"}}
"ขอตารางว่าง" (หลังคุยเรื่องพรุ่งนี้) -> {"intent":"my_availability","params":{"period":"tomorrow"}}
"เบสว่างช่วงไหน" -> {"intent":"my_availability","params":{"person":"เบส","period":"week"}}
"ดูตารางเบสกับพี่นนท์" -> {"intent":"find_meeting_time","params":{"attendees":["เบส","พี่นนท์"]}}
"เบสกับนนท์ว่างตรงกันช่วงไหน" -> {"intent":"find_meeting_time","params":{"attendees":["เบส","นนท์"]}}
"วันจันทร์นี้ พี่นนท์ พี่แบงค์ เบส มีเวลาไหนว่างตรงกัน" -> {"intent":"find_meeting_time","params":{"attendees":["พี่นนท์","พี่แบงค์","เบส"],"weekday":"mon"}}
"หาเวลาที่สมชาย สมหญิง ว่างตรงกันวันศุกร์" -> {"intent":"find_meeting_time","params":{"attendees":["สมชาย","สมหญิง"],"weekday":"fri"}}
"ตอนเย็นว่างไหม" (เมื่อเพิ่งหาเวลาหลายคน) -> {"intent":"find_meeting_time","params":{"after":"16:00"}}
"แล้วบ่ายล่ะ" (เมื่อเพิ่งหาเวลาหลายคน) -> {"intent":"find_meeting_time","params":{"after":"12:00","before":"16:00"}}
"ช่วงเช้าว่างไหม" (เมื่อเพิ่งหาเวลาหลายคน) -> {"intent":"find_meeting_time","params":{"after":"09:00","before":"12:00"}}
"นัดประชุมกับสมชายและสมหญิง 30 นาที" -> {"intent":"find_meeting_time","params":{"attendees":["สมชาย","สมหญิง"],"duration_min":30}}
"นัดเบสวันนี้ 10นาทีตอน 13:50 เรื่อง test meeting" -> {"intent":"find_meeting_time","params":{"attendees":["เบส"],"duration_min":10,"period":"today","after":"13:50","note":"test meeting"}}
"นัดพี่นนท์พรุ่งนี้ 30 นาที เรื่อง sync" -> {"intent":"find_meeting_time","params":{"attendees":["พี่นนท์"],"duration_min":30,"period":"tomorrow","note":"sync"}}
(หมายเหตุสำคัญ: ประโยคขึ้นต้นด้วย นัด/จอง + ชื่อคน = find_meeting_time เสมอ — "เรื่อง ..." คือหัวข้อประชุม ห้ามใช้ add_task)
(หมายเหตุสำคัญมาก: ถ้าถามดูตาราง/เวลาว่างของ "คนตั้งแต่ 2 คนขึ้นไปพร้อมกัน" (มีคำเชื่อม กับ/และ/, คั่นชื่อ) ให้ใช้ find_meeting_time เพื่อหาเวลาที่ทุกคนว่างตรงกัน — ห้ามใช้ my_availability หรือ list_meetings ที่รองรับทีละคน และห้าม fallback เป็นตารางของผู้ถามเอง)
(หมายเหตุ: ถ้าผู้ใช้ระบุวัน เช่น "วันจันทร์นี้/เสาร์หน้า/วันที่ 5" ต้องใส่ weekday หรือ date ด้วยเสมอ ห้ามปล่อยให้ค้นทั้งสัปดาห์)
(หมายเหตุ: follow-up เรื่องเช้า/บ่าย/เย็น หลัง find_meeting_time ต้องคง intent เป็น find_meeting_time ห้ามสลับไป my_availability ของคนเดียว)
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

function calendarSuggestions(kind: "meetings" | "free", period?: string): { label: string; text: string }[] {
  const day =
    period === "tomorrow" ? "พรุ่งนี้" : period === "today" ? "วันนี้" : period === "week" ? "สัปดาห์นี้" : "";
  const freeText = day ? `ขอตารางว่าง${day}` : "ขอตารางว่าง";
  const meetText = day ? `นัด${day}` : "นัดวันนี้";
  if (kind === "free") {
    return [
      { label: "📅 นัดประชุม", text: "นัดประชุม" },
      { label: "🗓 ดูนัด", text: meetText },
      { label: "👥 หาเวลาตรงกัน", text: "หาเวลาว่างกับ" },
      { label: "💬 ช่วยเรื่องอื่น", text: "ช่วยเรื่องอื่น" },
    ];
  }
  return [
    { label: "⬜ ขอตารางว่าง", text: freeText },
    { label: "📅 นัดประชุม", text: "นัดประชุม" },
    { label: "👥 หาเวลาตรงกัน", text: "หาเวลาว่างกับ" },
    { label: "💬 ช่วยเรื่องอื่น", text: "ช่วยเรื่องอื่น" },
  ];
}

function withAskNext(reply: string): string {
  return reply.trimEnd() + "\n\nต้องการทำอะไรต่อครับ? กดปุ่มด้านล่างได้เลย 👇";
}

function withCalendarNext(res: CommandResult, kind: "meetings" | "free"): CommandResult {
  const suggestions = calendarSuggestions(kind, res.period);
  return { ...res, reply: withAskNext(res.reply), suggestions };
}

function hasDayHint(text: string): boolean {
  return /วันนี้|พรุ่งนี้|มะรืน|สัปดาห์นี้|อาทิตย์นี้|เดือนนี้|วัน(?:จันทร์|อังคาร|พุธ|พฤหัสบดี?|ศุกร์|เสาร์|อาทิตย์)|วันที่\s*\d|\d{1,2}\/\d{1,2}/.test(
    text || ""
  );
}

/** Reuse last calendar day when user asks a follow-up without naming a day. */
function resolvePeriodParam(
  text: string,
  params: Record<string, unknown>,
  context?: CommandContext,
  fallback = "week"
): string {
  if (params.weekday || params.date) return String(params.period || fallback);
  if (hasDayHint(text) && params.period) return String(params.period);
  if (!hasDayHint(text) && context?.last_period) return context.last_period;
  return String(params.period || fallback);
}

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

/** Instant intents for feed management — no LLM (avoids LINE silence / timeouts). */
function quickFeedIntent(text: string): { intent: string; params: Record<string, unknown> } | null {
  const t = text.trim().replace(/\s+/g, " ");
  if (!t) return null;

  // Summarize stories (slow path) — keep explicit
  if (/^(มี)?ข่าวอะไรบ้าง|สรุปข่าว(วันนี้|ล่าสุด)?|มีคลิปใหม่อะไรบ้าง/i.test(t)) {
    return { intent: "get_news", params: {} };
  }

  // Prep a numbered meeting from today's agenda
  const prep = t.match(/^(?:เตรียม|แนะนำ|ช่วยเตรียม)(?:ตัว)?(?:นัด|ประชุม)?\s*(?:หมายเลข|ที่|#)?\s*(\d+)\s*$/i);
  if (prep) return { intent: "prep_meeting", params: { meeting_index: Number(prep[1]) } };

  // Bare free-time ask — period filled later from last_period / LLM defaults
  if (/^(ขอ)?(ดู)?ตารางว่าง(หน่อย)?$|^(ผม|ฉัน|ตัวเอง)?ว่าง(กี่โมง|ช่วงไหน|ไหม|มั้ย)?$/i.test(t)) {
    return { intent: "my_availability", params: {} };
  }

  if (/^ช่วย(เหลือ)?เรื่องอื่น$/i.test(t)) {
    return { intent: "help_menu", params: {} };
  }

  if (/^(ล้าง|ลบ|เคลียร์|clear)(ความจำ|แชท|บริบท|chat)?(ai|เอไอ)?$|^(เริ่มใหม่|เริ่มแชทใหม่|reset chat)$/i.test(t)) {
    return { intent: "clear_memory", params: {} };
  }

  // "ดูตารางพี่นนท์" / "ตารางว่างของเบส" — force person availability (not own meetings)
  if (/^(ดู|ขอดู|เช็ค|เช็ก)?ตาราง/.test(t)) {
    const who = personFromText(t);
    if (who) {
      const period = /พรุ่งนี้/.test(t) ? "tomorrow" : /วันนี้/.test(t) ? "today" : undefined;
      return {
        intent: "my_availability",
        params: period ? { person: who, period } : { person: who },
      };
    }
  }

  if (/^(นัด|ประชุม|ตาราง)(วัน)?พรุ่งนี้$/i.test(t) || /^พรุ่งนี้มี(นัด|ประชุม)/i.test(t)) {
    return { intent: "list_meetings", params: { period: "tomorrow" } };
  }
  if (/^(นัด|ประชุม|ตาราง)(วัน)?วันนี้$/i.test(t) || /^วันนี้มี(นัด|ประชุม)/i.test(t)) {
    return { intent: "list_meetings", params: { period: "today" } };
  }

  if (/สรุปตาราง|ตารางเช้า|ตารางวันนี้|นัดวันนี้มีอะไร/i.test(t) && !/ข่าว/.test(t)) {
    return { intent: "get_brief", params: {} };
  }

  // List followed sources — "ตอนนี้ติดตามข่าวอะไรบ้าง" must NOT go to get_news
  if (
    /ดูแหล่งข่าว|รายการ(ฟีด|แหล่งข่าว)|แหล่งข่าวที่ติดตาม|ฟีดที่ติดตาม|ติดตามอะไรบ้าง|ติดตามข่าวอะไร|ตอนนี้ติดตาม|ติดตามเพจอะไร|แหล่งข่าวมีอะไร|ติดตาม(ข่าว|เพจ|ฟีด).{0,12}อะไร/i.test(
      t
    )
  ) {
    return { intent: "list_feeds", params: {} };
  }

  // Delete
  if (/^(ลบ|เลิกติดตาม)(แหล่งข่าว|ฟีด|เพจ)?$/i.test(t) || /^ลบแหล่งข่าว$/i.test(t)) {
    return { intent: "remove_feed", params: {} };
  }
  const rm = t.match(/^(?:ลบ|เลิกติดตาม)\s*(?:แหล่งข่าว|ฟีด|เพจ)?\s*(?:หมายเลข|ที่|#)?\s*(\d+)\s*$/i);
  if (rm) return { intent: "remove_feed", params: { feed_index: Number(rm[1]) } };

  // Edit label: "แก้ชื่อแหล่งข่าว 1 เป็น Extreme"
  const ed = t.match(
    /^(?:แก้|แก้ไข|เปลี่ยน)\s*(?:ชื่อ)?\s*(?:แหล่งข่าว|ฟีด|เพจ)?\s*(?:หมายเลข|ที่|#)?\s*(\d+)\s*(?:เป็น|=)\s*(.+)$/i
  );
  if (ed) return { intent: "edit_feed", params: { feed_index: Number(ed[1]), label: ed[2].trim() } };

  // Add: URL in message
  const urlMatch = t.match(/https?:\/\/[^\s]+/i);
  if (urlMatch && /(เพิ่ม|ติดตาม|สมัครติดตาม)/i.test(t)) {
    const url = urlMatch[0].replace(/[)\].,]+$/, "");
    const kind = /เพจ|facebook|fb\.com/i.test(t) ? "facebook" : undefined;
    const labelM = t.match(/(?:ชื่อ|ชื่อย่อ)\s*([^\s].{0,40})$/i) || t.match(/\sชื่อ\s+(.+)$/i);
    return {
      intent: "add_feed",
      params: { url, ...(kind ? { kind } : {}), ...(labelM ? { label: labelM[1].trim() } : {}) },
    };
  }

  // "นัดเบสวันนี้ 10นาทีตอน 13:50 เรื่อง X" → book/find meeting (not add_task)
  const book = quickBookIntent(t);
  if (book) return book;

  return null;
}

/** Deterministic parse for “นัด/จอง + ชื่อคน (+ วัน/เวลา/เรื่อง)” — avoids LLM mistaking เรื่อง… as add_task. */
function quickBookIntent(text: string): { intent: string; params: Record<string, unknown> } | null {
  const t = text.trim().replace(/\s+/g, " ");
  if (!t) return null;

  // Bare day lists already handled above; don't steal them
  if (/^(นัด|ประชุม|ตาราง)(วัน)?(วันนี้|พรุ่งนี้|สัปดาห์นี้|อาทิตย์นี้)$/i.test(t)) return null;
  if (/^(วันนี้|พรุ่งนี้)มี(นัด|ประชุม)/i.test(t)) return null;

  if (
    !/^(?:นัด|จอง)(?:ประชุม)?(?:กับ)?/.test(t) &&
    !/^หาเวลา(?:ว่าง)?(?:ตรงกัน)?(?:กับ)?/.test(t) &&
    !/^ขอ(?:นัด|จอง)(?:ประชุม)?(?:กับ)?/.test(t)
  ) {
    return null;
  }

  let body = t;
  let note: string | undefined;
  const subjM = body.match(/\sเรื่อง\s+(.+)$/i);
  if (subjM) {
    note = subjM[1].trim();
    body = body.slice(0, subjM.index).trim();
  }

  let duration_min = 30;
  const durHr = body.match(/(\d+)\s*(?:ชม\.?|ชั่วโมง|hr|hour)/i);
  const durMin = body.match(/(\d+)\s*(?:นาที|min)/i);
  if (durHr) {
    duration_min = Math.max(15, Number(durHr[1]) * 60);
    body = body.replace(durHr[0], " ").replace(/\s+/g, " ").trim();
  } else if (durMin) {
    duration_min = Math.max(5, Number(durMin[1]));
    body = body.replace(durMin[0], " ").replace(/\s+/g, " ").trim();
  }

  let after: string | undefined;
  let before: string | undefined;
  const timeM =
    body.match(/(?:ตอน|เวลา|ที่)\s*(\d{1,2}:\d{2})/i) || body.match(/\b(\d{1,2}:\d{2})\b/);
  if (timeM) {
    after = timeM[1].padStart(5, "0");
    if (after.length === 4) after = `0${after}`; // 9:30 → already 5 with pad? "9:30".padStart(5,"0") = "09:30" ✓
    const [hh, mm] = after.split(":").map(Number);
    const end = hh * 60 + mm + duration_min;
    before = `${String(Math.floor(end / 60) % 24).padStart(2, "0")}:${String(end % 60).padStart(2, "0")}`;
    body = body.replace(timeM[0], " ").replace(/\s+/g, " ").trim();
  }

  let period: string | undefined;
  if (/วันนี้/.test(body)) {
    period = "today";
    body = body.replace(/วันนี้/g, " ");
  } else if (/พรุ่งนี้/.test(body)) {
    period = "tomorrow";
    body = body.replace(/พรุ่งนี้/g, " ");
  } else if (/มะรืน(นี้)?/.test(body)) {
    period = "week";
    body = body.replace(/มะรืน(นี้)?/g, " ");
  }
  body = body.replace(/\s+/g, " ").trim();

  body = body
    .replace(/^(?:นัด|จอง)(?:ประชุม)?(?:กับ)?/i, "")
    .replace(/^หาเวลา(?:ว่าง)?(?:ตรงกัน)?(?:กับ)?/i, "")
    .replace(/^ขอ(?:นัด|จอง)(?:ประชุม)?(?:กับ)?/i, "")
    .replace(/\s+/g, " ")
    .trim();

  const attendees = body
    .split(/\s*(?:กับ|และ|,)\s*/)
    .map((s) => stripHonorificPublic(s).replace(/^[ .,/-]+|[ .,/-]+$/g, "").trim())
    .filter((s) => s && !SELF_WORDS.has(s) && !/^(ประชุม|นัด|จอง)$/i.test(s));

  if (!attendees.length) return null;

  const params: Record<string, unknown> = { attendees, duration_min };
  if (period) params.period = period;
  if (after) params.after = after;
  if (before) params.before = before;
  if (note) params.note = note;
  return { intent: "find_meeting_time", params };
}

function historyLines(context?: CommandContext): string[] {
  const lines: string[] = [];
  if (context?.summary?.trim()) {
    lines.push(`(สรุปเรื่องก่อนหน้าในรอบนี้: ${context.summary.trim().slice(0, 500)})`);
  }
  for (const turn of context?.history || []) {
    const role = turn.role === "me" || turn.role === "user" ? "ผู้ใช้" : "ผู้ช่วย";
    const t = (turn.text || "").trim().replace(/\n/g, " ");
    if (t) lines.push(`${role}: ${t.slice(0, 200)}`);
  }
  return lines.slice(-12);
}

async function parseIntent(text: string, context?: CommandContext): Promise<{ intent: string; params: Record<string, unknown> }> {
  const textClean = text.trim();
  const textLower = textClean.toLowerCase();

  // Fast deterministic shortcuts — skip LLM so LINE replies before the reply-token expires.
  const quick = quickFeedIntent(textClean);
  if (quick) return quick;

  // Fast deterministic rule after a file search
  if (context?.last_intent === "file_results") {
    if (["อ่านและสรุป", "สรุปให้ฟัง", "อ่านสรุป", "สรุปไฟล์", "อ่านไฟล์", "อ่านอันแรก", "สรุปอันแรก"].some((kw) => textLower.includes(kw))) {
      return { intent: "summarize_file", params: { file_index: 0 } };
    }
  }

  // Always tell the model the current date/time so it can resolve relative day
  // expressions itself (วันจันทร์ / เสาร์นี้ / มะรืน / อีก 3 วัน / สิ้นเดือน …)
  // into a concrete date — instead of us hand-coding each pattern.
  const now = nowWall();
  const THAI_DOW = ["อาทิตย์", "จันทร์", "อังคาร", "พุธ", "พฤหัสบดี", "ศุกร์", "เสาร์"];
  const ymd = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-${String(now.getUTCDate()).padStart(2, "0")}`;
  const timeCtx = `[เวลาปัจจุบัน: วัน${THAI_DOW[now.getUTCDay()]} ที่ ${ymd} เวลา ${fmtHHMM(minutesOfDay(now))} น. (เขตเวลาไทย)]`;

  const parts: string[] = [timeCtx];
  if (context) {
    const hist = historyLines(context);
    if (hist.length) parts.push("[ประวัติการสนทนาก่อนหน้า]\n" + hist.join("\n"));
    const compact: Record<string, unknown> = {};
    if (context.last_intent) compact.last_intent = context.last_intent;
    if (context.last_person) compact.last_person = context.last_person;
    if (context.last_period) compact.last_period = context.last_period;
    if (context.summary) compact.has_summary = true;
    if (context.last_meeting?.attendees?.length) {
      compact.last_meeting = {
        attendees: context.last_meeting.attendees,
        duration: context.last_meeting.duration,
        window: context.last_meeting.window?.label,
      };
    }
    if (context.files?.length) compact.files = context.files.slice(0, 3).map((f) => f.name).filter(Boolean);
    if (Object.keys(compact).length) parts.push(`[บริบทล่าสุด: ${JSON.stringify(compact)}]`);
  }
  parts.push(`คำสั่งผู้ใช้ล่าสุด: ${textClean}`);
  const prompt = parts.join("\n");

  const raw = await chat(INTENT_SYSTEM, prompt, { temperature: 0, json: true, fast: true });
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
  range: { start: Date; end: Date; label: string },
  includeLunch = false
): Promise<CommandResult> {
  const denied = needCalendarConsent();
  if (denied) return denied;
  const { start, end, label } = range;
  const ranges = await freeRanges(email, start, end, requesterUpn, includeLunch);
  const slots = ranges.map((r) => ({
    start: wallIso(r.start),
    end: wallIso(r.end),
    label: `${fmtDateTime(r.start)}-${fmtTime(r.end)}`,
  }));
  const reply = slots.length
    ? `🗓️ เวลาว่างของ ${displayName} (${label}) 👇\nเลือกหมายเลขช่วงเพื่อจอง หรือกด “กำหนดเอง” เพื่อพิมพ์เวลาเองครับ`
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
  at: number | null,
  preInfo?: UserInfo | null
): Promise<CommandResult> {
  const denied = needCalendarConsent();
  if (denied) return denied;
  let info = preInfo;
  if (!info?.mail) info = await resolveUserInfo(person);
  if (!info?.mail) {
    return { intent: "list_meetings", reply: `หาคนชื่อ “${person}” ในองค์กรไม่เจอครับ ลองระบุอีเมลได้ไหม` };
  }
  const who = info.displayName || person;
  const range = day || periodRange(period);
  const label = at !== null ? `${range.label} ตอน ${fmtHHMM(at)}` : windowLabel(range.label, after, before);

  // Point-in-time ("ตอน 10 โมง") → keep events overlapping that minute; otherwise
  // keep events whose start falls in the after/before window.
  const keep = (sd: Date, ed: Date): boolean => {
    if (at !== null) return minutesOfDay(sd) <= at && at < minutesOfDay(ed);
    const m = minutesOfDay(sd);
    return (after === null || m >= after) && (before === null || m < before);
  };

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
      const sd = ev.start?.dateTime ? parseWall(ev.start.dateTime) : null;
      const ed = ev.end?.dateTime ? parseWall(ev.end.dateTime) : null;
      if (!sd || !ed) continue;
      if (!keep(sd, ed)) continue;
      const priv = ["private", "personal", "confidential"].includes((ev.sensitivity || "").toLowerCase());
      rows.push({ sd, ed, subj: priv ? "(นัดส่วนตัว)" : ev.subject || "(ไม่มีหัวข้อ)" });
    }
    if (!rows.length) {
      const none = at !== null ? `ไม่มีนัดตอน ${fmtHHMM(at)}` : "ไม่มีนัดในช่วงนี้";
      return {
        intent: "list_meetings",
        reply: `✅ ${who} ว่างครับ (${label}) — ${none}`,
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
  ranges = at !== null
    ? ranges.filter((r) => minutesOfDay(r.start) <= at && at < minutesOfDay(r.end))
    : ranges.filter(
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
  const raw = await chat(BOOK_CTX_SYSTEM, text, { temperature: 0, json: true, fast: true });
  let p: { is_booking?: boolean; duration_min?: number; subject?: string; extra_people?: string[] };
  try {
    p = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!p.is_booking) return null;
  const denied = needCalendarConsent();
  if (denied) return denied;

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
    const ev = await createEvent(userUpn, subject, wallIso(start), wallIso(end), attendees);
    const ping = await notifyMeetingInviteOnLine({
      organizerUpn: userUpn,
      subject,
      startIso: wallIso(start),
      endIso: wallIso(end),
      attendees,
      eventId: ev?.id,
    }).catch(() => ({ notified: 0, names: [] as string[] }));
    const who = person.displayName || attendees[0] || "";
    const extra = attendees.length > 1 ? ` +${attendees.length - 1} คน` : "";
    const lineNote =
      ping.notified > 0
        ? `\n\n📲 ส่ง LINE ขอให้ยืนยันนัดแล้ว ${ping.notified} คน`
        : attendees.length
          ? "\n\n📲 ยังไม่มีผู้เข้าร่วมที่ผูก LINE — ส่งคำเชิญ Outlook แล้วครับ"
          : "";
    return {
      intent: "booked",
      reply: `✅ จองประชุมแล้ว!\n📌 ${subject}\n👤 ${who}${extra}\n🕐 ${fmtDateTime(start)} (${duration} นาที)${lineNote}`,
    };
  } catch (e) {
    return {
      intent: "error",
      reply: `⚠️ จองไม่สำเร็จ: ${String(e).slice(0, 150)}\n(อาจต้องเพิ่มสิทธิ์ Calendars.ReadWrite)`,
    };
  }
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
// ---------------------------------------------------------------------------
// find-a-common-time with per-name disambiguation (works statelessly over LINE:
// the pending attendee list is encoded into the quick-reply postback)
// ---------------------------------------------------------------------------
type MtAttendee = { name?: string; mail?: string };
type MtWindow = { start: Date; end: Date; label: string };

/** Extract a day hint from free text even if the LLM missed weekday/date params. */
function dayHintFromText(text: string): MtWindow | null {
  const m = text.match(/วัน?(จันทร์|อังคาร|พุธ|พฤหัสบดี?|ศุกร์|เสาร์|อาทิตย์)\s*(นี้|หน้า)?/);
  if (m) return resolveWeekday(m[1] + (m[2] || ""));
  const dm = text.match(/วันที่\s*(\d{1,2}(?:\/\d{1,2}(?:\/\d{2,4})?)?|\d{4}-\d{2}-\d{2})/);
  if (dm) return resolveDay(dm[1]);
  return null;
}

function resolveFindWindow(params: Record<string, unknown>, text: string): MtWindow | null {
  if (params.weekday) return resolveWeekday(String(params.weekday));
  if (params.date) return resolveDay(String(params.date));
  if (params.period && ["today", "tomorrow"].includes(String(params.period))) {
    return periodRange(String(params.period));
  }
  return dayHintFromText(text);
}

function timeBandFromText(text: string): { after: number | null; before: number | null; label: string } | null {
  const t = text.trim();
  if (/(ตอน)?เช้า|ช่วงเช้า/.test(t)) return { after: 9 * 60, before: 12 * 60, label: "ช่วงเช้า" };
  if (/(ตอน)?สาย|ช่วงสาย/.test(t)) return { after: 9 * 60, before: 12 * 60, label: "ช่วงสาย" };
  if (/(ตอน)?บ่าย|ช่วงบ่าย/.test(t)) return { after: 12 * 60, before: 16 * 60, label: "ช่วงบ่าย" };
  if (/(ตอน)?เย็น|ช่วงเย็น|ค่ำ/.test(t)) return { after: 16 * 60, before: 20 * 60, label: "ช่วงเย็น" };
  const afterM = t.match(/(?:หลัง|ตั้งแต่)\s*(\d{1,2})(?::(\d{2}))?\s*(โมง|ทุ่ม)?/);
  const beforeM = t.match(/(?:ก่อน|ถึง)\s*(\d{1,2})(?::(\d{2}))?\s*(โมง|ทุ่ม)?/);
  let after: number | null = null;
  let before: number | null = null;
  if (afterM) {
    let h = Number(afterM[1]);
    const mi = afterM[2] ? Number(afterM[2]) : 0;
    if (afterM[3] === "ทุ่ม") h = h === 1 ? 13 : h + 12;
    else if (afterM[3] === "โมง" && h < 7) h += 12; // "บ่าย 2 โมง" often written without บ่าย
    after = h * 60 + mi;
  }
  if (beforeM) {
    let h = Number(beforeM[1]);
    const mi = beforeM[2] ? Number(beforeM[2]) : 0;
    if (beforeM[3] === "ทุ่ม") h = h === 1 ? 13 : h + 12;
    before = h * 60 + mi;
  }
  if (after === null && before === null) return null;
  return { after, before, label: "ช่วงที่ระบุ" };
}

function isTimeFollowUp(text: string): boolean {
  const t = text.trim();
  if (personFromText(t)) return false;
  if (dayHintFromText(t)) return false; // new day → not just a band follow-up
  return !!(
    timeBandFromText(t) ||
    /^(?:แล้ว)?(?:ช่วง|ตอน)?(?:เช้า|สาย|บ่าย|เย็น|ค่ำ)/.test(t) ||
    /ว่าง(?:ไหม|มั้ย|รึเปล่า|หรือเปล่า|บ้าง)?$/.test(t)
  );
}

function windowFromStored(m?: CommandContext["last_meeting"]): MtWindow | null {
  if (!m?.window?.start || !m.window.end) return null;
  const start = parseWall(m.window.start);
  const end = parseWall(m.window.end);
  if (!start || !end) return null;
  return { start, end, label: m.window.label || fmtDate(start) };
}

function encodeMtData(
  attendees: MtAttendee[],
  duration: number,
  window?: MtWindow | null,
  band?: { after: number | null; before: number | null } | null,
  includeLunch = false
): string {
  const at = attendees.map((a) => (a.mail ? `m:${a.mail}` : `n:${a.name || ""}`)).join("|");
  const q = new URLSearchParams({ a: "findmt", d: String(duration), at });
  if (window) {
    q.set("ws", wallIso(window.start));
    q.set("we", wallIso(window.end));
    q.set("wl", window.label);
  }
  if (band?.after != null) q.set("af", String(band.after));
  if (band?.before != null) q.set("bf", String(band.before));
  if (includeLunch) q.set("ln", "1");
  return q.toString();
}

export function decodeMtAttendees(data: URLSearchParams): {
  attendees: MtAttendee[];
  duration: number;
  window: MtWindow | null;
  after: number | null;
  before: number | null;
  includeLunch: boolean;
} {
  const attendees = (data.get("at") || "")
    .split("|")
    .filter(Boolean)
    .map((tok) => (tok.startsWith("m:") ? { mail: tok.slice(2) } : tok.startsWith("n:") ? { name: tok.slice(2) } : { name: tok }));
  const ws = parseWall(data.get("ws") || "");
  const we = parseWall(data.get("we") || "");
  const window = ws && we ? { start: ws, end: we, label: data.get("wl") || fmtDate(ws) } : null;
  const af = data.get("af");
  const bf = data.get("bf");
  return {
    attendees,
    duration: Number(data.get("d") || 30),
    window,
    after: af != null && af !== "" ? Number(af) : null,
    before: bf != null && bf !== "" ? Number(bf) : null,
    includeLunch: data.get("ln") === "1",
  };
}

export async function runFindMeeting(
  userUpn: string,
  attendees: MtAttendee[],
  duration: number,
  window?: MtWindow | null,
  band?: { after: number | null; before: number | null; label?: string } | null,
  includeLunch = false,
  subject = "ประชุม"
): Promise<CommandResult> {
  const denied = needCalendarConsent();
  if (denied) return denied;
  // Resolve each name; stop and ask when a name matches more than one person.
  for (let i = 0; i < attendees.length; i++) {
    const a = attendees[i];
    if (a.mail || !a.name) continue;
    const cands = await searchUsers(a.name);
    if (cands.length === 1) {
      a.mail = cands[0].mail;
      a.name = cands[0].displayName || a.name;
    } else if (cands.length > 1) {
      const choices = cands.slice(0, 10).map((c) => {
        const next = attendees.map((x, j) => (j === i ? { mail: c.mail, name: c.displayName } : x));
        return { mail: c.mail, displayName: c.displayName || c.mail, data: encodeMtData(next, duration, window, band, includeLunch) };
      });
      const dayNote = window ? ` (ช่วง ${window.label})` : "";
      return { intent: "choose_mt_person", reply: `เจอหลายคนที่ตรงกับ “${a.name}” เลือกคนที่ต้องการดูตารางครับ${dayNote} 👇`, choices };
    }
  }

  const resolved = attendees.filter((a) => a.mail).map((a) => a.mail as string);
  const unresolved = attendees.filter((a) => !a.mail && a.name).map((a) => a.name as string);
  if (!resolved.length) {
    return { intent: "find_meeting_time", reply: "หาคนที่จะดูตารางไม่เจอครับ ลองระบุชื่อ/อีเมลที่ชัดเจนอีกครั้งได้ไหม" };
  }

  const allStarts = !!(window || band?.after != null || band?.before != null);
  const workEndHour =
    band?.before != null ? Math.max(WORK_END_HOUR, Math.ceil(band.before / 60)) :
    band?.after != null && band.after >= 16 * 60 ? Math.max(WORK_END_HOUR, 20) :
    undefined;
  const result = await findCommonSlots(
    userUpn,
    resolved,
    duration,
    allStarts ? 48 : 5,
    window ? { start: window.start, end: window.end } : undefined,
    { afterMin: band?.after ?? null, beforeMin: band?.before ?? null, allStarts, workEndHour, includeLunch }
  );
  const note = unresolved.length ? `\n(หาอีเมลไม่เจอ: ${unresolved.join(", ")})` : "";
  const who = resolved.join(", ");
  const dayNote = window ? ` วันที่ ${window.label}` : "";
  const bandNote = band?.label ? ` ${band.label}` : "";
  if (!result.slots.length) {
    return {
      intent: "find_meeting_time",
      reply: formatBusy(result.busy) + note + `\n(ค้นของ: ${who}${dayNote}${bandNote})`,
      meeting: {
        attendees: resolved,
        duration,
        subject,
        window: window
          ? { start: wallIso(window.start), end: wallIso(window.end), label: window.label }
          : undefined,
      },
    };
  }

  if (AUTO_BOOK) {
    const s = result.slots[0];
    const ev = await createEvent(userUpn, subject, s.start, s.end, resolved);
    const ping = await notifyMeetingInviteOnLine({
      organizerUpn: userUpn,
      subject,
      startIso: s.start,
      endIso: s.end,
      attendees: resolved,
      eventId: ev?.id,
    }).catch(() => ({ notified: 0, names: [] as string[] }));
    const lineNote = ping.notified > 0 ? `\n📲 ส่ง LINE ขอให้ยืนยันแล้ว ${ping.notified} คน` : "";
    return { intent: "find_meeting_time", reply: `จองให้เลยตามที่ตั้งค่าไว้ ✅\n${subject} — ${s.label}${lineNote}` };
  }

  const reply =
    `เจอเวลาที่ทุกคนว่างตรงกัน${dayNote}${bandNote}ครับ\n` +
    `👤 ${who}\n` +
    (subject && subject !== "ประชุม" ? `📌 ${subject}\n` : "") +
    `เลือกเวลาเริ่มประชุม (${duration} นาที) จากรายการด้านล่างได้เลย 👇` +
    note;

  return {
    intent: "choose_slot",
    reply,
    slots: result.slots,
    ranges: result.ranges,
    meeting: {
      attendees: resolved,
      duration,
      subject,
      window: window
        ? { start: wallIso(window.start), end: wallIso(window.end), label: window.label }
        : undefined,
    },
  };
}

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

// Handle a tap on a LINE quick-reply/postback button. `data` is the postback
// payload (URLSearchParams). Each action is self-contained (stateless) so it
// completes in one step without stored conversation context.
export async function handleSelection(userUpn: string, data: URLSearchParams): Promise<CommandResult> {
  const a = data.get("a") || "";
  try {
    if (a === "avail" || a === "book" || a === "cancel" || a === "findmt") {
      const denied = needCalendarConsent();
      if (denied) return denied;
    }
    if (a === "avail") {
      const mail = data.get("m") || "";
      const name = data.get("n") || mail;
      if (!mail) return { intent: "error", reply: "ข้อมูลไม่ครบ ลองใหม่อีกครั้งครับ" };
      const d = data.get("d");
      const range = d ? resolveDay(d) || periodRange("week") : periodRange(data.get("p") || "week");
      return await availabilityResponse(userUpn, mail, name, range, data.get("ln") === "1");
    }
    if (a === "book") {
      const start = parseWall(data.get("s") || "");
      const end = parseWall(data.get("e") || "");
      const subject = data.get("subj") || "ประชุม";
      const attendees = (data.get("at") || "").split(",").map((s) => s.trim()).filter(Boolean);
      if (!start || !end) return { intent: "error", reply: "ช่วงเวลาไม่ถูกต้อง ลองเลือกใหม่ครับ" };
      const ev = await createEvent(userUpn, subject, wallIso(start), wallIso(end), attendees);
      const ping = await notifyMeetingInviteOnLine({
        organizerUpn: userUpn,
        subject,
        startIso: wallIso(start),
        endIso: wallIso(end),
        attendees,
        eventId: ev?.id,
      }).catch(() => ({ notified: 0, names: [] as string[] }));
      const lineNote =
        ping.notified > 0
          ? `\n\n📲 ส่ง LINE ขอให้ยืนยันนัดแล้ว ${ping.notified} คน`
          : attendees.length
            ? "\n\n📲 ยังไม่มีผู้เข้าร่วมที่ผูก LINE — ส่งคำเชิญ Outlook แล้วครับ"
            : "";
      return {
        intent: "booked",
        reply: `✅ จองประชุมแล้ว!\n📌 ${subject}\n🕐 ${fmtDateTime(start)}-${fmtTime(end)}${attendees.length ? `\n👤 ${attendees.join(", ")}` : ""}${lineNote}`,
      };
    }
    if (a === "cancel") {
      const id = data.get("id") || "";
      if (!id) return { intent: "error", reply: "ไม่พบนัดที่จะยกเลิกครับ" };
      await deleteEvent(userUpn, id);
      return { intent: "cancelled", reply: "✅ ยกเลิกนัดแล้วครับ" };
    }
    if (a === "findmt") {
      const { attendees, duration, window, after, before, includeLunch } = decodeMtAttendees(data);
      const band =
        after != null || before != null
          ? { after, before, label: after != null && after >= 16 * 60 ? "ช่วงเย็น" : undefined }
          : null;
      return await runFindMeeting(userUpn, attendees, duration, window, band, includeLunch);
    }
    if (a === "rmfeed") {
      const id = Number(data.get("id") || "");
      if (!id) return { intent: "error", reply: "ไม่พบแหล่งข่าวที่จะลบครับ" };
      const row = await getFeed(userUpn, id);
      if (!row) return { intent: "error", reply: "ไม่พบแหล่งข่าวนั้นครับ" };
      await deleteFeed(userUpn, id);
      const name = (row.label || "").trim() || row.ref;
      return { intent: "feed_removed", reply: `✅ ลบแหล่งข่าวแล้ว: ${name}` };
    }
    if (a === "prep") {
      const idx = Number(data.get("i") || "");
      const eventId = data.get("id") || (idx ? await resolveAgendaEventId(userUpn, idx) : null);
      if (!eventId) return { intent: "error", reply: "ไม่พบนัดที่เลือก — พิมพ์ “สรุปตารางเช้า” เพื่อดูรายการใหม่ครับ" };
      const reply = await buildMeetingPrep(userUpn, eventId);
      return { intent: "meeting_prep", reply };
    }
  } catch (e) {
    return { intent: "error", reply: `⚠️ ทำรายการไม่สำเร็จ: ${String(e).slice(0, 150)}` };
  }
  return { intent: "unknown", reply: "ไม่รู้จักคำสั่งนี้ครับ" };
}

async function handle(userUpn: string, text: string, context?: CommandContext, lite = false): Promise<CommandResult> {
  // if the user has a selected time slot, try to act on it first
  if (context?.selected) {
    const booked = await bookFromContext(userUpn, text, context.selected);
    if (booked) return booked;
  }

  // Follow-up on a multi-person search: "ตอนเย็นว่างไหม" keeps the same attendees + day.
  if (context?.last_meeting?.attendees?.length && isTimeFollowUp(text)) {
    const band = timeBandFromText(text);
    const window = windowFromStored(context.last_meeting) || dayHintFromText(text);
    return runFindMeeting(
      userUpn,
      context.last_meeting.attendees.map((mail) => ({ mail })),
      context.last_meeting.duration || 30,
      window,
      band,
      wantsLunchIncluded(text)
    );
  }

  const { intent, params } = await parseIntent(text, context);

  if (intent === "clear_memory") {
    return {
      intent: "clear_memory",
      reply: "ล้างความจำการสนทนาแล้วครับ — เริ่มเรื่องใหม่ได้เลย 🧹\n(พิมพ์ / เพื่อดูคำสั่งอื่น)",
      suggestions: [
        { label: "/ตารางวันนี้", text: "/ตารางวันนี้" },
        { label: "/นัดพรุ่งนี้", text: "/นัดพรุ่งนี้" },
        { label: "/ช่วยเหลือ", text: "/ช่วยเหลือ" },
      ],
    };
  }

  if (intent === "help_menu") {
    return {
      intent: "help_menu",
      reply:
        "ได้เลยครับ พิมพ์ / เพื่อเลือกคำสั่ง หรือพิมพ์เอง เช่น\n\n" +
        "• /ตารางวันนี้ · /นัดพรุ่งนี้\n" +
        "• /ตั้งค่าข่าว · /ล้างความจำ\n" +
        "• ขอตารางว่าง / ดูตารางพี่…",
      suggestions: [
        { label: "/ตารางวันนี้", text: "/ตารางวันนี้" },
        { label: "/นัดพรุ่งนี้", text: "/นัดพรุ่งนี้" },
        { label: "/ตั้งค่าข่าว", text: "/ตั้งค่าข่าว" },
        { label: "/ล้างความจำ", text: "/ล้างความจำ" },
        { label: "/ช่วยเหลือ", text: "/ช่วยเหลือ" },
      ],
    };
  }

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
    const denied = needCalendarConsent();
    if (denied) return denied;
    const agenda = await buildMorningAgenda(userUpn);
    if (!agenda.choices.length) return { intent, reply: agenda.text };
    return {
      intent: "choose_prep",
      reply: agenda.text,
      choices: agenda.choices.map((c) => ({
        index: c.index,
        event_id: c.event_id,
        label: c.label,
      })),
    };
  }

  if (intent === "prep_meeting") {
    const denied = needCalendarConsent();
    if (denied) return denied;
    const idx = Number(params.meeting_index ?? params.index ?? 0);
    let eventId = idx ? await resolveAgendaEventId(userUpn, idx) : null;
    if (!eventId && params.subject) {
      const agenda = await buildMorningAgenda(userUpn);
      const q = String(params.subject).toLowerCase();
      const hit = agenda.events.find((e) => (e.subject || "").toLowerCase().includes(q));
      eventId = hit?.id || null;
    }
    if (!eventId) {
      const agenda = await buildMorningAgenda(userUpn);
      return {
        intent: "choose_prep",
        reply: "บอกหมายเลขนัดด้วยครับ เช่น “เตรียมนัด 1”\n\n" + agenda.text,
        choices: agenda.choices.map((c) => ({ index: c.index, event_id: c.event_id, label: c.label })),
      };
    }
    const reply = await buildMeetingPrep(userUpn, eventId);
    return { intent: "meeting_prep", reply };
  }

  if (intent === "get_news") {
    const { stories, skipped, note } = await buildDigest(userUpn);
    if (!stories.length) {
      const extra = skipped.length ? `\n(ข้าม: ${skipped.join(", ")})` : "";
      return {
        intent,
        reply:
          (note || "ยังไม่มีข่าวให้สรุปครับ") +
          "\n\nเพิ่มแหล่งได้ในแชท เช่น “เพิ่มแหล่งข่าว https://...” หรือ “ดูแหล่งข่าว” แล้วลองพิมพ์ “มีข่าวอะไรบ้าง” อีกครั้งครับ" +
          extra,
      };
    }
    const extra = skipped.length ? `\n\n(ข้ามบางแหล่ง: ${skipped.join(", ")})` : "";
    return { intent, reply: formatStoriesText(stories) + extra, data: stories };
  }

  if (intent === "list_feeds") {
    const feeds = await listManagedFeeds(userUpn);
    if (!feeds.length) {
      return {
        intent,
        reply:
          "ยังไม่มีแหล่งข่าวที่ติดตามครับ\n\n" +
          "เพิ่มได้เลย เช่น:\n" +
          "• เพิ่มแหล่งข่าว https://example.com/rss.xml\n" +
          "• ติดตามเพจ https://www.facebook.com/...\n" +
          "• ดูแหล่งข่าว / ลบแหล่งข่าว / แก้ชื่อแหล่งข่าว 1 เป็น ...",
      };
    }
    return {
      intent,
      reply:
        `แหล่งข่าวที่ติดตาม (${feeds.length}):\n\n` +
        formatFeedList(feeds) +
        "\n\nพิมพ์ “ลบแหล่งข่าว” หรือ “แก้ชื่อแหล่งข่าว 1 เป็น …” ได้ครับ",
      data: feeds,
    };
  }

  if (intent === "add_feed") {
    const url = String(params.url || params.ref || "").trim();
    if (!url) {
      return {
        intent,
        reply:
          "ส่งลิงก์มาด้วยครับ เช่น\n" +
          "• เพิ่มแหล่งข่าว https://example.com/feed\n" +
          "• ติดตามเพจ https://www.facebook.com/PageName ชื่อ เพจของฉัน",
      };
    }
    const kindHint = String(params.kind || "").toLowerCase();
    const label = String(params.label || params.name || "").trim();
    const preview = await previewFeed(url, kindHint);
    if (!preview.ok) return { intent, reply: `❌ เพิ่มไม่ได้: ${preview.error}` };
    const kind = preview.kind || detectFeedKind(url, kindHint);
    const saved = await upsertFeed(userUpn, kind, url, label || preview.source || "");
    const samples = preview.items
      .slice(0, 3)
      .map((it, i) => `${i + 1}) ${String(it.title || "").slice(0, 100)}`)
      .join("\n");
    return {
      intent,
      reply:
        `✅ เริ่มติดตามแล้ว\n` +
        `แหล่ง: ${saved.label || preview.source}\n` +
        `ประเภท: ${kind === "facebook" ? "Facebook" : "RSS"}\n` +
        `ลิงก์: ${saved.ref}` +
        (samples ? `\n\nตัวอย่างรายการล่าสุด:\n${samples}` : "") +
        `\n\nถาม “มีข่าวอะไรบ้าง” หรือ “ดูแหล่งข่าว” ได้ครับ`,
      data: saved,
    };
  }

  if (intent === "remove_feed") {
    const feeds = await listManagedFeeds(userUpn);
    if (!feeds.length) return { intent, reply: "ยังไม่มีแหล่งข่าวให้ลบครับ" };
    const target = resolveFeedByIndexOrId(feeds, params);
    if (target) {
      await deleteFeed(userUpn, target.id);
      const name = (target.label || "").trim() || target.ref;
      return { intent, reply: `✅ ลบแหล่งข่าวแล้ว: ${name}` };
    }
    const choices = feeds.map((f) => ({
      feed_id: String(f.id),
      label: `[${f.kind === "facebook" ? "FB" : "RSS"}] ${(f.label || "").trim() || f.ref}`,
    }));
    return {
      intent: "choose_remove_feed",
      reply: "เลือกแหล่งข่าวที่ต้องการลบครับ 👇",
      choices,
    };
  }

  if (intent === "edit_feed") {
    const feeds = await listManagedFeeds(userUpn);
    if (!feeds.length) return { intent, reply: "ยังไม่มีแหล่งข่าวให้แก้ไขครับ" };
    const target = resolveFeedByIndexOrId(feeds, params);
    const newLabel = String(params.label || params.name || "").trim();
    const newUrl = String(params.url || params.ref || "").trim();
    if (!target) {
      return {
        intent,
        reply:
          "บอกหมายเลขแหล่งข่าวด้วยครับ เช่น\n" +
          "• แก้ชื่อแหล่งข่าว 1 เป็น Extreme IT\n" +
          "• เปลี่ยนลิงก์แหล่ง 2 เป็น https://...\n\n" +
          formatFeedList(feeds),
        data: feeds,
      };
    }
    if (!newLabel && !newUrl) {
      return {
        intent,
        reply:
          `แหล่งที่ ${feeds.indexOf(target) + 1}: ${(target.label || "").trim() || target.ref}\n` +
          "บอกชื่อใหม่หรือลิงก์ใหม่ เช่น “แก้ชื่อแหล่งข่าว " +
          `${feeds.indexOf(target) + 1} เป็น ชื่อใหม่”`,
      };
    }
    if (newUrl) {
      const kind = detectFeedKind(newUrl, target.kind);
      const preview = await previewFeed(newUrl, kind);
      if (!preview.ok) return { intent, reply: `❌ ลิงก์ใหม่ใช้ไม่ได้: ${preview.error}` };
      // Changing URL may conflict with unique (owner, kind, ref) — delete+readd if needed
      if (newUrl !== target.ref || kind !== target.kind) {
        await deleteFeed(userUpn, target.id);
        const saved = await upsertFeed(userUpn, kind, newUrl, newLabel || target.label || preview.source || "");
        return {
          intent,
          reply: `✅ อัปเดตแหล่งข่าวแล้ว\nชื่อ: ${saved.label || "(ไม่มีชื่อ)"}\nลิงก์: ${saved.ref}`,
          data: saved,
        };
      }
    }
    const updated = await updateFeed(userUpn, target.id, {
      label: newLabel || undefined,
      ref: newUrl || undefined,
    });
    if (!updated) return { intent, reply: "อัปเดตไม่สำเร็จครับ" };
    return {
      intent,
      reply: `✅ แก้ไขแล้ว\nชื่อ: ${updated.label || "(ไม่มีชื่อ)"}\nลิงก์: ${updated.ref}`,
      data: updated,
    };
  }

  if (intent === "list_meetings") {
    const denied = needCalendarConsent();
    if (denied) return denied;
    const period = resolvePeriodParam(text, params, context, "upcoming");
    const day = params.date ? resolveDay(String(params.date)) : params.weekday ? resolveWeekday(String(params.weekday)) : null;
    const after = parseHHMM(params.after);
    const before = parseHHMM(params.before);
    const at = parseHHMM(params.at);

    const { name: person, info: personInfo } = await continuedPerson(text, context);
    if (person) {
      const busy = await personBusyResponse(userUpn, person, day, period, after, before, at, personInfo);
      return withCalendarNext({ ...busy, period: day ? undefined : period }, "meetings");
    }

    let { start, end, label } = day || periodRange(period);
    let events = await getEventsRange(userUpn, wallIso(start), wallIso(end));

    if (!events.length && !day && (period === "today" || period === "tomorrow") && at === null) {
      const up = periodRange("upcoming");
      events = await getEventsRange(userUpn, wallIso(up.start), wallIso(up.end));
      if (events.length) label = `${label}ไม่มีนัด — นัดที่กำลังจะมาถึง (${up.label})`;
      start = up.start;
      end = up.end;
    }

    // Point-in-time ("10 โมงติดอะไร") → is there a meeting overlapping that time?
    if (at !== null) {
      const overlapping = events.filter((ev) => {
        const sd = ev.start?.dateTime ? parseWall(ev.start.dateTime) : null;
        const ed = ev.end?.dateTime ? parseWall(ev.end.dateTime) : null;
        return !!sd && !!ed && minutesOfDay(sd) <= at && at < minutesOfDay(ed);
      });
      const atLabel = `${label} ตอน ${fmtHHMM(at)}`;
      if (!overlapping.length) {
        return withCalendarNext(
          { intent, reply: `✅ ${label} ตอน ${fmtHHMM(at)} ว่างครับ — ไม่มีนัด`, data: [], period },
          "meetings"
        );
      }
      const reply = lite ? formatEventsSimple(overlapping, atLabel) : await buildForEvents(userUpn, overlapping, atLabel);
      return withCalendarNext({ intent, reply, data: overlapping, period }, "meetings");
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
      return withCalendarNext(
        {
          intent,
          reply: `ช่วง${label}ยังไม่มีนัดประชุมในปฏิทินครับ 👍`,
          data: [],
          period,
        },
        "meetings"
      );
    }
    const reply = lite ? formatEventsSimple(events, label) : await buildForEvents(userUpn, events, label);
    return withCalendarNext({ intent, reply, data: events, period }, "meetings");
  }

  if (intent === "my_availability") {
    const denied = needCalendarConsent();
    if (denied) return denied;
    const period = resolvePeriodParam(text, params, context, "week");
    const dayRange = params.weekday ? resolveWeekday(String(params.weekday)) : params.date ? resolveDay(String(params.date)) : null;
    const range = dayRange || periodRange(period);
    // token the disambiguation buttons carry so they reuse the same day/period
    const dayIso = dayRange
      ? `${dayRange.start.getUTCFullYear()}-${String(dayRange.start.getUTCMonth() + 1).padStart(2, "0")}-${String(dayRange.start.getUTCDate()).padStart(2, "0")}`
      : undefined;

    const lunch = wantsLunchIncluded(text);
    const det = mentionsSelf(text)
      ? ""
      : String(params.person || "").trim() || personFromText(text);
    if (det) {
      const cands = await searchUsers(det);
      if (cands.length > 1) {
        return {
          intent: "choose_person",
          reply: `เจอหลายคนที่ตรงกับ “${det}” เลือกคนที่ต้องการดูตารางครับ 👇`,
          choices: cands.map((c) => ({ mail: c.mail, displayName: c.displayName, period, date: dayIso, lunch })),
          period,
        };
      }
      if (cands.length === 1) {
        const res = await availabilityResponse(userUpn, cands[0].mail, cands[0].displayName || det, range, lunch);
        return withCalendarNext({ ...res, period }, "free");
      }
      return withCalendarNext(
        {
          intent,
          reply:
            `ยังหา “${det}” ไม่เจอในไดเรกทอรี/รายชื่อที่เคยคุยด้วยครับ\n` +
            "ลองพิมพ์ชื่อเต็ม หรืออีเมล เช่น “ดูตารางชื่อ@ktisgroup.com” นะครับ",
          period,
        },
        "free"
      );
    }
    if (!mentionsSelf(text) && !/^(ขอ)?(ดู)?ตารางว่าง/.test(text.trim())) {
      const lastMail = context?.last_person_mail;
      const lastName = context?.last_person;
      if (lastMail) {
        const res = await availabilityResponse(userUpn, lastMail, lastName || lastMail, range, lunch);
        return withCalendarNext({ ...res, period }, "free");
      }
      if (lastName) {
        const cands = await searchUsers(lastName);
        if (cands.length === 1) {
          const res = await availabilityResponse(userUpn, cands[0].mail, cands[0].displayName || lastName, range, lunch);
          return withCalendarNext({ ...res, period }, "free");
        }
      }
    }
    const ranges = await freeRanges(userUpn, range.start, range.end, userUpn, lunch);
    return withCalendarNext({ intent, reply: formatFree(ranges, range.label), period }, "free");
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
    const denied = needCalendarConsent();
    if (denied) return denied;
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
    const denied = needCalendarConsent();
    if (denied) return denied;
    const attendeesRaw = (params.attendees as string[]) || [];
    const duration = Number(params.duration_min || context?.last_meeting?.duration || 30);
    let window = resolveFindWindow(params, text) || windowFromStored(context?.last_meeting);
    const bandFromParams = {
      after: parseHHMM(params.after),
      before: parseHHMM(params.before),
      label: undefined as string | undefined,
    };
    const band = (bandFromParams.after != null || bandFromParams.before != null)
      ? bandFromParams
      : timeBandFromText(text);

    const attendees: MtAttendee[] = attendeesRaw.length
      ? attendeesRaw.map((name) => ({ name: String(name) }))
      : (context?.last_meeting?.attendees || []).map((mail) => ({ mail }));

    if (!attendees.length) {
      return { intent: "find_meeting_time", reply: "ยังไม่ทราบว่าจะนัดกับใครครับ ลองระบุชื่อคนที่ต้องการดูตารางด้วยนะครับ" };
    }
    const subject = String(params.note || params.subject || "ประชุม").trim() || "ประชุม";
    return runFindMeeting(userUpn, attendees, duration, window, band, wantsLunchIncluded(text), subject);
  }

  return {
    intent: "unknown",
    reply:
      "ยังไม่เข้าใจคำสั่งนี้ ลองพิมพ์ใหม่อีกครั้งได้ไหมครับ\n\n" +
      "เกี่ยวกับตาราง/ข่าว:\n" +
      "• สรุปตารางเช้า\n" +
      "• เตรียมนัด 1\n" +
      "• ดูแหล่งข่าว / มีข่าวอะไรบ้าง",
  };
}
