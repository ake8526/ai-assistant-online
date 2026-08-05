// Natural-language command handling — ported from morning_brief/commands.py.
// The web / LINE sends free text; the LLM classifies it into an intent + params
// and we execute. Booking asks for confirmation first (choose_slot) per requirement.
import { buildForEvents, buildMorningAgenda, buildMeetingPrep, resolveAgendaEntry, resolveAgendaEventId, saveAgendaIds } from "@/lib/brief";
import {
  handleLinkMeetingFile,
  handleLinkMeetingUrl,
  handleListMeetingMaterials,
  handleUnlinkMeetingMaterial,
  quickLinkMeetingIntent,
} from "@/lib/meetingLink";
import { buildDigest, formatStoriesText, rememberDeliveredStories, type DigestResult } from "@/lib/digest";
import { trace } from "@/lib/trace";
import { normalizeDue, resolveResponsible } from "@/lib/followup";
import { createHash } from "crypto";
import {
  GraphEvent,
  UserInfo,
  createEvent,
  deleteEvent,
  downloadDriveText,
  findDuplicateNicknames,
  getEventsRange,
  nowLocal,
  resolveUser,
  resolveUserInfo,
  searchFiles,
  searchUsers,
  stripHonorificPublic,
} from "@/lib/graph";
import { getUserGraphToken } from "@/lib/graphAuth";
import { chat, llmUserErrorMessage } from "@/lib/llm";
import { listRecentOnline } from "@/lib/meetings";
import { calendarConsentNeededMessage } from "@/lib/msGraphOAuth";
import { bookMeetingWithLineHold } from "@/lib/meetingInvite";
import { busyRanges, findCommonSlots, formatBusy, formatFree, freeRanges, wantsLunchIncluded } from "@/lib/scheduling";
import {
  addPlace,
  addTask,
  deletePlace,
  getPrimaryPlace,
  getSetting,
  incrementVisit,
  listPlaces,
  listTasks,
  allSettings,
  setSetting,
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
  addDays,
  addMinutes,
  fmtDate,
  fmtDateTime,
  fmtHHMM,
  fmtTime,
  minutesOfDay,
  nowWall,
  parseHHMM,
  parseThaiClockToHHMM,
  parseClockToMinutes,
  parseWall,
  periodRange,
  resolveDay,
  resolveWeekday,
  startOfDay,
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
  /** Next index when paging duplicate-nickname groups (“มีอีกไหม”). */
  nick_dup_offset?: number;
  /** Last meeting index used when linking files (for bare SharePoint URL follow-up). */
  last_link_meeting_index?: number;
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
  /** Persist paging cursor for duplicate nicknames. */
  nick_dup_offset?: number;
  last_link_meeting_index?: number;
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
  "intent": "<หนึ่งใน: get_brief | prep_meeting | get_news | list_feeds | add_feed | remove_feed | edit_feed | list_meetings | my_availability | list_tasks | add_task | complete_task | summarize_meetings | find_meeting_time | cancel_meeting | open_map | open_map_home | plan_commute | set_work_location | set_home_location | show_work_location | clear_work_location | search_files | summarize_file | find_duplicate_nicknames | link_meeting_file | link_meeting_url | list_meeting_materials | unlink_meeting_material | unknown>",
  "params": { ... }
}

ความหมายของแต่ละ intent:
- get_brief = ดูรายการตาราง/นัดวันนี้ (แสดงทั้งหมดแล้วถามว่าอยากให้แนะนำเตรียมตัวนัดไหน) — เช่น "สรุปตารางเช้า", "ตารางวันนี้", "มีนัดอะไรบ้างเช้านี้"
- prep_meeting = แนะนำเตรียมตัวนัดที่เลือก (อ่านหัวข้อ/รายละเอียดอีเมล/ไฟล์แนบ/ลิงก์) — เช่น "เตรียมนัด 1", "แนะนำประชุม 2", "ช่วยเตรียมตัวนัด Weekly Sync"
- get_news = สรุปเนื้อหาข่าว/โพสต์จากแหล่งที่ติดตามแล้ว — เช่น "มีข่าวอะไรบ้าง", "สรุปข่าววันนี้", "ข่าววันนี้", "มีคลิปใหม่อะไรบ้าง" (ห้ามใช้เมื่อผู้ใช้ถามแค่ว่าติดตามแหล่งไหน)
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
- find_duplicate_nicknames = หาว่าในองค์กรมีคนชื่อเล่นซ้ำกันกี่คน/ใครบ้าง (จากชื่อที่แสดงในไดเรกทอรี) — เช่น "ชื่อเล่นซ้ำกี่คน", "ในองค์กรมีคนชื่อเล่นซ้ำกันไหม", "ใครชื่อเล่นซ้ำบ้าง"
- link_meeting_file = ผูกไฟล์ OneDrive กับนัดที่มีอยู่แล้ว (ยังไม่ได้อยู่ในปฏิทินแนบ) — เช่น "ผูกไฟล์นัด 1", "แนบอัน 2 กับนัด 1", "อันแรกผูกกับ งบ Q3.xlsx", "ผูกไฟล์นี้กับนัด Weekly"
- link_meeting_url = ผูกลิงก์กับนัด — เช่น "แนบลิงก์นัด 2 https://..."
- list_meeting_materials = ดูไฟล์/ลิงก์ที่ผูกกับนัด — เช่น "เอกสารนัด 1"
- unlink_meeting_material = เลิกผูกไฟล์/ลิงก์ออกจากนัด — เช่น "เลิกแนบนัด 1 ไฟล์ 2"

สำคัญ: หากบริบทก่อนหน้าเพิ่งมีการค้นหาไฟล์ (search_files หรือ file_results) แล้วผู้ใช้พิมพ์ว่า "อ่านและสรุป", "สรุปให้ฟัง", "อ่านไฟล์", "สรุปอัน 1" ให้เลือก intent เป็น "summarize_file" เสมอ (ห้ามเลือก get_brief)! ถ้ายังไม่ระบุเลขไฟล์ ให้ params ว่าง (อย่าเดา file_index) — ระบบจะถามให้เลือกเอง
ถ้าเพิ่งค้นไฟล์แล้วผู้ใช้พูดว่า "ผูกกับนัด 1" / "แนบให้นัด 2" ให้ใช้ link_meeting_file
ถ้าผู้ใช้บอกชื่อไฟล์มาเลยพร้อมหมายเลขนัด (เช่น "อันแรกผูกกับ รายงาน.pdf") ให้ใช้ link_meeting_file พร้อม meeting_index และ file_query=ชื่อไฟล์ — ห้ามตอบให้ไปค้นเองก่อน

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
- cancel_meeting: { "person": "ชื่อ/อีเมลคนในนัด ถ้าผู้ใช้ระบุ เช่น ยกเลิกนัดกับเบส (ถ้าไม่ระบุ = โชว์รายการทั้งหมด)" }
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
"ในองค์กรมีคนชื่อเล่นซ้ำกันกี่คน ใครบ้าง" -> {"intent":"find_duplicate_nicknames","params":{}}
"ผูกไฟล์นัด 1" -> {"intent":"link_meeting_file","params":{"meeting_index":1}}
"แนบอัน 2 กับนัด 1" -> {"intent":"link_meeting_file","params":{"file_index":2,"meeting_index":1}}
"อันแรกผูกกับ ฟังก์ชันทั้งระบบ-AI-Assistant.html" -> {"intent":"link_meeting_file","params":{"meeting_index":1,"file_query":"ฟังก์ชันทั้งระบบ-AI-Assistant.html"}}
"แนบลิงก์นัด 2 https://example.com/deck" -> {"intent":"link_meeting_url","params":{"meeting_index":2,"url":"https://example.com/deck"}}
"เอกสารนัด 1" -> {"intent":"list_meeting_materials","params":{"meeting_index":1}}
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
"ส่งนัดหา ake@gmail.com" -> {"intent":"find_meeting_time","params":{"attendees":["ake@gmail.com"]}}
(หมายเหตุ: “ส่งนัดหา/นัดหา/เชิญ” + อีเมล = นัดกับอีเมลนั้นเท่านั้น ห้ามดึงคนจาก last_meeting มาผสม)
"นัดประชุมกับสมชายและสมหญิง 30 นาที" -> {"intent":"find_meeting_time","params":{"attendees":["สมชาย","สมหญิง"],"duration_min":30}}
"นัดเบสวันนี้ 10นาทีตอน 13:50 เรื่อง test meeting" -> {"intent":"find_meeting_time","params":{"attendees":["เบส"],"duration_min":10,"period":"today","at":"13:50","note":"test meeting"}}
"นัดพี่นนท์พรุ่งนี้ 30 นาที เรื่อง sync" -> {"intent":"find_meeting_time","params":{"attendees":["พี่นนท์"],"duration_min":30,"period":"tomorrow","note":"sync"}}
(หมายเหตุสำคัญ: ประโยคขึ้นต้นด้วย นัด/จอง + ชื่อคน = find_meeting_time เสมอ — "เรื่อง ..." คือหัวข้อประชุม ห้ามใช้ add_task; ถ้ามี "ตอน HH:MM" ให้ใส่ params.at)
(หมายเหตุสำคัญมาก: ถ้าถามดูตาราง/เวลาว่างของ "คนตั้งแต่ 2 คนขึ้นไปพร้อมกัน" (มีคำเชื่อม กับ/และ/, คั่นชื่อ) ให้ใช้ find_meeting_time เพื่อหาเวลาที่ทุกคนว่างตรงกัน — ห้ามใช้ my_availability หรือ list_meetings ที่รองรับทีละคน และห้าม fallback เป็นตารางของผู้ถามเอง)
(หมายเหตุ: ถ้าผู้ใช้ระบุวัน เช่น "วันจันทร์นี้/เสาร์หน้า/วันที่ 5" ต้องใส่ weekday หรือ date ด้วยเสมอ ห้ามปล่อยให้ค้นทั้งสัปดาห์)
(หมายเหตุ: follow-up เรื่องเช้า/บ่าย/เย็น หลัง find_meeting_time ต้องคง intent เป็น find_meeting_time ห้ามสลับไป my_availability ของคนเดียว)
"ยกเลิกนัด" -> {"intent":"cancel_meeting","params":{}}
"ยกเลิกนัดกับเบส" -> {"intent":"cancel_meeting","params":{"person":"เบส"}}
"ยกเลิกประชุมพี่นนท์" -> {"intent":"cancel_meeting","params":{"person":"พี่นนท์"}}
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
  return /วันนี้|พรุ่งนี้|มะรืน|เช้านี้|บ่ายนี้|เย็นนี้|ค่ำนี้|สัปดาห์นี้|อาทิตย์นี้|เดือนนี้|วัน(?:จันทร์|อังคาร|พุธ|พฤหัสบดี?|ศุกร์|เสาร์|อาทิตย์)|วันที่\s*\d|\d{1,2}\/\d{1,2}/.test(
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
  // Explicit period from quick-intent / LLM always wins (e.g. เช้านี้ → today).
  // Do NOT let last_period="week" override it just because the text lacks "วันนี้".
  if (params.period) return String(params.period);
  if (!hasDayHint(text) && context?.last_period) return context.last_period;
  if (/พรุ่งนี้/.test(text || "")) return "tomorrow";
  if (/เช้านี้|บ่ายนี้|เย็นนี้|ค่ำนี้|วันนี้|ดูประชุมเช้า|นัดเช้า/.test(text || "")) return "today";
  return fallback;
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

/** Split “เบสกับพี่แบง” / “พี่เอม พี่แบง พี่นน เบส” into separate people. */
function peopleFromText(text: string): string[] {
  let body = (text || "").trim().replace(/\s+/g, " ");
  let changed = true;
  while (changed && body) {
    changed = false;
    for (const p of NAME_PREFIX) {
      if (body.startsWith(p)) {
        body = body.slice(p.length).trim();
        changed = true;
        break;
      }
    }
    if (changed) continue;
    for (const suf of NAME_SUFFIX) {
      if (body.endsWith(suf)) {
        body = body.slice(0, -suf.length).trim();
        changed = true;
        break;
      }
    }
  }
  body = body.replace(/\s+/g, " ").trim();
  if (!body) return [];

  const splitChunk = (chunk: string): string[] => {
    // "พี่เอม พี่แบง พี่นน" — honorifics mark each person
    const byHonor = chunk
      .split(/\s+(?=พี่|คุณ|น้อง)/)
      .map((s) => s.trim())
      .filter(Boolean);
    const pieces = byHonor.length >= 2 ? byHonor : [chunk];
    const out: string[] = [];
    for (const piece of pieces) {
      const stripped = (stripHonorificPublic(piece) || piece).replace(/^[ .,/-]+|[ .,/-]+$/g, "").trim();
      if (!stripped) continue;
      const toks = stripped.split(/\s+/).filter(Boolean);
      // "เอม แบง นน เบส" or leftover "นน เบส" after honorific split
      if (
        toks.length >= 2 &&
        toks.every(
          (t) =>
            t.length <= 12 &&
            !/[.@]/.test(t) &&
            !/^(วันนี้|พรุ่งนี้|ตาราง|ว่าง|ประชุม|นัด|จอง|ตรงกัน)$/i.test(t)
        )
      ) {
        out.push(...toks);
      } else {
        out.push(stripped);
      }
    }
    return out;
  };

  let parts = body
    .split(/\s*(?:กับ|และ|,|\/|&)\s*/)
    .map((s) => s.replace(/^[ .,/-]+|[ .,/-]+$/g, "").trim())
    .filter((s) => s && !SELF_WORDS.has(s) && !/^(ประชุม|นัด|จอง|ตาราง|ว่าง|ตรงกัน)$/i.test(s));

  parts = parts.flatMap((p) => splitChunk(p));
  parts = parts
    .map((s) => (stripHonorificPublic(s) || s).replace(/^[ .,/-]+|[ .,/-]+$/g, "").trim())
    .filter((s) => s && !SELF_WORDS.has(s) && !/^(ประชุม|นัด|จอง|ตาราง|ว่าง|ตรงกัน)$/i.test(s));

  // Dedupe while preserving order
  const seen = new Set<string>();
  parts = parts.filter((p) => {
    const k = p.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  if (parts.length >= 2) return parts;
  if (parts.length === 1) return [parts[0]!];
  const one = personFromText(text);
  return one ? [one] : [];
}

// ---------------------------------------------------------------------------
// Intent parsing
// ---------------------------------------------------------------------------

function hasMorningMeetingsHint(text: string): boolean {
  // Explicit \u escapes so bundlers / encoding cannot corrupt Thai literals.
  // เช้านี้ / ดูประชุมเช้า / นัดเช้า / ประชุมเช้า / ตารางเช้า
  return (
    text.includes("\u0E40\u0E0A\u0E49\u0E32\u0E19\u0E35\u0E49") ||
    text.includes("\u0E14\u0E39\u0E1B\u0E23\u0E30\u0E0A\u0E38\u0E21\u0E40\u0E0A\u0E49\u0E32") ||
    text.includes("\u0E19\u0E31\u0E14\u0E40\u0E0A\u0E49\u0E32") ||
    text.includes("\u0E1B\u0E23\u0E30\u0E0A\u0E38\u0E21\u0E40\u0E0A\u0E49\u0E32") ||
    text.includes("\u0E15\u0E32\u0E23\u0E32\u0E07\u0E40\u0E0A\u0E49\u0E32")
  );
}

function hasTomorrowHint(text: string): boolean {
  // พรุ่งนี้
  return text.includes("\u0E1E\u0E23\u0E38\u0E48\u0E07\u0E19\u0E35\u0E49");
}

function hasMorningWord(text: string): boolean {
  // เช้า
  return text.includes("\u0E40\u0E0A\u0E49\u0E32");
}

/** Instant intents for feed management — no LLM (avoids LINE silence / timeouts). */
function quickFeedIntent(text: string): { intent: string; params: Record<string, unknown> } | null {
  const t = text.trim().replace(/\s+/g, " ");
  if (!t) return null;

  // Multi-person first (before single-person “ดูตาราง…”) — “ดูตารางเบสกับพี่แบง”
  {
    const people = peopleFromText(t);
    if (
      people.length >= 2 &&
      /(ตาราง|ว่าง|นัด|หาเวลา|ตรงกัน)/.test(t)
    ) {
      const period = /พรุ่งนี้/.test(t) ? "tomorrow" : /วันนี้/.test(t) ? "today" : undefined;
      return {
        intent: "find_meeting_time",
        params: period ? { attendees: people, period } : { attendees: people },
      };
    }
  }

  // Summarize stories (slow path) — keep explicit so we skip LLM before LINE token expires
  if (
    /^(มี)?ข่าว(อะไรบ้าง|วันนี้|ล่าสุด)?[!?.…]*$|สรุปข่าว(วันนี้|ล่าสุด)?|มีคลิปใหม่อะไรบ้าง|ขอ(สรุป)?ข่าว(วันนี้|ล่าสุด)?/i.test(
      t
    )
  ) {
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

  // Duplicate nicknames in org directory
  if (
    /ชื่อเล่น\s*ซ้ำ|ซ้ำ\s*กัน.*ชื่อเล่น|ชื่อเล่น.*(?:กี่คน|ใครบ้าง|มีไหม|มีมั้ย)|คนชื่อเล่นซ้ำ|ในองก.?ร์.*ชื่อเล่น|ในองค์กร.*ชื่อเล่น/i.test(
      t
    )
  ) {
    return { intent: "find_duplicate_nicknames", params: {} };
  }

  const linkQ = quickLinkMeetingIntent(t);
  if (linkQ) return linkQ;

  if (/^(ล้าง|ลบ|เคลียร์|clear)(ความจำ|แชท|บริบท|chat)?(ai|เอไอ)?$|^(เริ่มใหม่|เริ่มแชทใหม่|reset chat)$/i.test(t)) {
    return { intent: "clear_memory", params: {} };
  }

  // "ดูตารางพี่นนท์" → one person (multi-person already handled above)
  if (/^(ดู|ขอดู|เช็ค|เช็ก)?ตาราง/.test(t)) {
    const people = peopleFromText(t);
    const who = people[0] || personFromText(t);
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
  if (
    /^(นัด|ประชุม|ตาราง)(วัน)?วันนี้$/i.test(t) ||
    /^วันนี้มี(นัด|ประชุม)/i.test(t) ||
    hasMorningMeetingsHint(t)
  ) {
    // “ดูประชุมเช้านี้” → list morning meetings without LLM (avoids Groq 429 on intent)
    if (hasMorningWord(t) && !hasTomorrowHint(t)) {
      return {
        intent: "list_meetings",
        params: { period: "today", after: "00:00", before: "12:00", _morning: true },
      };
    }
    if (hasMorningWord(t) && hasTomorrowHint(t)) {
      return {
        intent: "list_meetings",
        params: { period: "tomorrow", after: "00:00", before: "12:00", _morning: true },
      };
    }
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

  // "ยกเลิกนัด" / "ยกเลิกนัดกับเบส"
  const cancel = quickCancelIntent(t);
  if (cancel) return cancel;

  // "ขอดูเพิ่มเติม" / "แสดงเพิ่ม" after a slot list — continue same attendees
  if (
    /^ขอดูเพิ่มเติม$/i.test(t) ||
    /^แสดงเพิ่ม(เติม)?(ได้)?(ไหม)?$/i.test(t) ||
    /^ดู(เวลา|ช่วง)?เพิ่ม/i.test(t)
  ) {
    return { intent: "find_meeting_time", params: { show_more: true } };
  }

  // "นัดเบสวันนี้ 10นาทีตอน 13:50 เรื่อง X" → book/find meeting (not add_task)
  const book = quickBookIntent(t);
  if (book) return book;

  return null;
}

/** Deterministic cancel — keeps person filter when user says “ยกเลิกนัดกับเบส”. */
function quickCancelIntent(text: string): { intent: string; params: Record<string, unknown> } | null {
  const t = text.trim().replace(/\s+/g, " ");
  if (!t) return null;
  if (!/^(?:ยกเลิก|ลบ|เลิก)(?:นัด|ประชุม)/i.test(t)) return null;
  const m = t.match(/^(?:ยกเลิก|ลบ|เลิก)(?:นัด|ประชุม)?(?:กับ|ของ)?\s*(.*)$/i);
  const rest = (m?.[1] || "").trim().replace(/\s*(หน่อย|ครับ|ค่ะ|คะ|นะ)$/u, "").trim();
  if (!rest || /^(วันนี้|พรุ่งนี้|ทั้งหมด|นี้)$/i.test(rest)) {
    return { intent: "cancel_meeting", params: {} };
  }
  return { intent: "cancel_meeting", params: { person: rest } };
}

/** Deterministic parse for “นัด/จอง + ชื่อคน (+ วัน/เวลา/เรื่อง)” — avoids LLM mistaking เรื่อง… as add_task. */
function quickBookIntent(text: string): { intent: string; params: Record<string, unknown> } | null {
  const t = text.trim().replace(/\s+/g, " ");
  if (!t) return null;

  // Bare day lists already handled above; don't steal them
  if (/^(นัด|ประชุม|ตาราง)(วัน)?(วันนี้|พรุ่งนี้|สัปดาห์นี้|อาทิตย์นี้)$/i.test(t)) return null;
  if (/^(วันนี้|พรุ่งนี้)มี(นัด|ประชุม)/i.test(t)) return null;

  if (
    !/^(?:ส่งนัดหา|ส่งนัด|นัดหา|เชิญ|invite\b|นัด|จอง)(?:ประชุม)?(?:กับ|หา)?/i.test(t) &&
    !/^หาเวลา(?:ว่าง)?(?:ตรงกัน)?(?:กับ)?/.test(t) &&
    !/^ขอ(?:นัด|จอง)(?:ประชุม)?(?:กับ)?/.test(t)
  ) {
    return null;
  }

  let body = t;
  let note: string | undefined;

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
  let at: string | undefined;
  // Range first: "17:30-18:00" / "17.30–18.00" → exact start + duration
  const rangeM = body.match(/(\d{1,2})[:.](\d{2})\s*(?:[-–—]|ถึง)\s*(\d{1,2})[:.](\d{2})/);
  if (rangeM) {
    const sh = Number(rangeM[1]);
    const sm = Number(rangeM[2]);
    const eh = Number(rangeM[3]);
    const em = Number(rangeM[4]);
    at = `${String(sh).padStart(2, "0")}:${String(sm).padStart(2, "0")}`;
    const mins = eh * 60 + em - (sh * 60 + sm);
    if (mins >= 5 && mins <= 8 * 60) duration_min = mins;
    after = at;
    body = body.replace(rangeM[0], " ").replace(/\s+/g, " ").trim();
  } else {
    const timeM =
      body.match(/(?:ตอน|เวลา|ที่)\s*(\d{1,2}:\d{2})/i) || body.match(/\b(\d{1,2}:\d{2})\b/);
    if (timeM) {
      at = timeM[1].length === 4 ? `0${timeM[1]}` : timeM[1].padStart(5, "0");
      after = at;
      body = body.replace(timeM[0], " ").replace(/\s+/g, " ").trim();
    } else {
      // "ตอน 11 โมง" / "บ่ายสองโมง" / "11 โมงครึ่ง" / "ตอนเที่ยง"
      const thaiClock = parseThaiClockToHHMM(body);
      if (thaiClock) {
        at = thaiClock;
        after = thaiClock;
        body = body
          .replace(/บ่าน/g, "บ่าย")
          .replace(/(?:ตอน|เวลา|ที่)?\s*\d{1,2}\s*โมง(?:\s*เย็น)?(?:\s*(?:ครึ่ง|\d{1,2}\s*นาที))?/g, " ")
          .replace(/บ่าย\s*โมง(?:\s*เย็น)?(?:\s*ครึ่ง)?/g, " ")
          .replace(/บ่าย\s*(?:\d{1,2}|หนึ่ง|สอง|สาม|สี่|ห้า|หก)(?:\s*โมง)?(?:\s*เย็น)?(?:\s*ครึ่ง)?/g, " ")
          .replace(/(?:\d{1,2}|หนึ่ง|สอง|สาม|สี่|ห้า)\s*ทุ่ม(?:\s*ครึ่ง)?/g, " ")
          .replace(/ทุ่ม\s*(?:\d{1,2}|หนึ่ง|สอง|สาม|สี่|ห้า)?(?:\s*ครึ่ง)?/g, " ")
          .replace(/(?:ตอน|เวลา|ที่)?\s*ตี\s*(?:\d{1,2}|หนึ่ง|สอง|สาม|สี่|ห้า|หก)(?:\s*ครึ่ง)?/g, " ")
          .replace(/(?:ตอน|เวลา|ที่)?\s*เที่ยงคืน/g, " ")
          .replace(/(?:ตอน|เวลา|ที่)\s*เที่ยง(?:วัน|ตรง)?(?:\s*ครึ่ง)?/g, " ")
          .replace(/(?:^|\s)เที่ยง(?:วัน|ตรง)?(?:\s*ครึ่ง)?(?=\s|$)/g, " ")
          .replace(/\s+/g, " ")
          .trim();
      }
    }
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

  // Subject after peeling day/time so “เรื่อง test วันนี้ 17:30-18:00” → note=test
  const subjM = body.match(/\sเรื่อง\s+(.+)$/i);
  if (subjM) {
    note = subjM[1].trim().replace(/[.,]+$/g, "").trim();
    body = body.slice(0, subjM.index).trim();
  }

  body = body
    .replace(/^(?:ส่งนัดหา|ส่งนัด|นัดหา|เชิญ|invite)\s*/i, "")
    .replace(/^(?:นัด|จอง)(?:ประชุม)?(?:กับ|หา)?/i, "")
    .replace(/^หาเวลา(?:ว่าง)?(?:ตรงกัน)?(?:กับ)?/i, "")
    .replace(/^ขอ(?:นัด|จอง)(?:ประชุม)?(?:กับ)?/i, "")
    .replace(/\s+/g, " ")
    .trim();

  // Emails + nicknames in the same line: "ake@gmail.com กับเบส"
  const emails = extractEmails(body);
  const names = body
    .replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, " ")
    .split(/\s*(?:กับ|และ|,)\s*/)
    .map((s) => stripHonorificPublic(s).replace(/^[ .,/-]+|[ .,/-]+$/g, "").trim())
    .filter((s) => s && !SELF_WORDS.has(s) && !/^(ประชุม|นัด|จอง|หา|ส่ง)$/i.test(s));
  const attendees = sanitizeAttendeeTokens([...emails, ...names]);

  if (!attendees.length) return null;

  const params: Record<string, unknown> = { attendees, duration_min };
  if (period) params.period = period;
  if (at) params.at = at;
  else if (after) params.after = after;
  if (note) params.note = note;
  return { intent: "find_meeting_time", params };
}

function extractEmails(text: string): string[] {
  const found = text.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) || [];
  return Array.from(new Set(found.map((e) => e.toLowerCase())));
}

/**
 * Normalize book-line tokens: pull clean emails out of "นัด ake@x.com",
 * drop command words, dedupe mail/name.
 */
function sanitizeAttendeeTokens(tokens: string[]): string[] {
  const out: string[] = [];
  const seenMail = new Set<string>();
  const seenName = new Set<string>();
  // Leftover schedule phrases must never become "people"
  const noise =
    /วันนี้|พรุ่งนี้|มะรืน|นาที|โมง|ทุ่ม|ตี\s*\d|เรื่อง|ตอน|บ่าย|เช้า|เย็น|เที่ยง|ชั่วโมง|\bmin\b|\bhour\b|\d{1,2}\s*[:.]\s*\d{2}|\d{2,}/i;

  const pushMail = (e: string) => {
    const m = e.trim().toLowerCase();
    if (!m.includes("@") || seenMail.has(m)) return;
    seenMail.add(m);
    out.push(m);
  };
  const pushName = (raw: string) => {
    let n = stripHonorificPublic(raw).replace(/^[ .,/-]+|[ .,/-]+$/g, "").trim();
    n = n.replace(/^(?:นัด|จอง|เชิญ|invite|กับ|และ|หา)\s+/i, "").trim();
    if (!n || n.includes("@")) return;
    if (noise.test(n)) return;
    if (n.split(/\s+/).length > 2) return;
    if (n.length > 32) return;
    if (SELF_WORDS.has(n) || /^(ประชุม|นัด|จอง|หา|ส่ง|ตอน|เวลา|ช่วง|ว่าง|ตรงกัน)$/i.test(n)) return;
    const key = n.toLowerCase();
    if (seenName.has(key) || seenMail.has(key)) return;
    seenName.add(key);
    out.push(n);
  };

  for (const raw of tokens) {
    const s = String(raw || "").trim();
    if (!s) continue;
    const emails = extractEmails(s);
    if (emails.length) {
      for (const e of emails) pushMail(e);
      const rest = s
        .replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, " ")
        .replace(/^(?:นัด|จอง|เชิญ|invite|กับ|และ|หา)\s+/i, " ")
        .replace(/\s+/g, " ")
        .trim();
      if (rest && !noise.test(rest)) {
        for (const part of rest.split(/\s*(?:กับ|และ|,)\s*/)) pushName(part);
      }
      continue;
    }
    pushName(s);
  }
  return out;
}

/** Nicknames beside emails: only explicit กับ/และ/, connectors — not leftover time text. */
function nameTokensBesideEmails(text: string): string[] {
  const raw: string[] = [];
  // "…@gmail.com กับเบส วันนี้…" → capture เบส only
  for (const m of text.matchAll(
    /(?:กับ|และ|,)\s*([ก-๙A-Za-z][ก-๙A-Za-z.]{0,24})(?=\s*(?:กับ|และ|,|วันนี้|พรุ่งนี้|มะรืน|เรื่อง|ตอน|นาที|\d|$))/gu
  )) {
    raw.push(m[1]);
  }
  return sanitizeAttendeeTokens(raw);
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

async function parseIntent(
  text: string,
  context?: CommandContext
): Promise<{ intent: string; params: Record<string, unknown>; source: "quick" | "llm" }> {
  // LINE often wraps long SharePoint URLs across lines — collapse before matching.
  let textClean = text.trim();
  const collapsedUrl = textClean.replace(/\s+/g, "");
  if (/^https?:\/\/\S*(sharepoint\.com|onedrive\.live\.com|1drv\.ms)\S*$/i.test(collapsedUrl)) {
    textClean = collapsedUrl;
  }
  const textLower = textClean.toLowerCase();

  // Fast deterministic shortcuts — skip LLM so LINE replies before the reply-token expires.
  const quick = quickFeedIntent(textClean);
  if (quick) return { ...quick, source: "quick" };

  // Bare OneDrive/SharePoint URL after a link attempt → attach to last/first meeting
  if (/^https?:\/\/\S*(sharepoint\.com|onedrive\.live\.com|1drv\.ms)\S*$/i.test(textClean)) {
    const mi = Number(context?.last_link_meeting_index) || 1;
    return {
      intent: "link_meeting_file",
      params: { meeting_index: mi, file_query: textClean },
      source: "quick",
    };
  }

  // “มีอีกไหม” after nickname duplicate list — next page / confirm complete (no re-dump)
  const moreNick =
    /^(มีอีก|มีเพิ่ม|ดูต่อ|ต่อไป|หน้าต่อไป|หน้าถัดไป)(ไหม|มั้ย)?$|^มีอีกไหม$|^อีกไหม$|^อีกมั้ย$|^ครบยัง$|^มีหมดแล้วไหม$/i.test(
      textClean.replace(/\s+/g, " ").trim()
    );
  if (context?.last_intent === "find_duplicate_nicknames" && moreNick) {
    return { intent: "find_duplicate_nicknames", params: { more: true }, source: "quick" };
  }

  // Fast deterministic rule after a file search
  if (context?.last_intent === "file_results" || (context?.files?.length && /อ่าน|สรุป/.test(textClean))) {
    const idxHit =
      textClean.match(/(?:อัน|ข้อ|ไฟล์)\s*(?:ที่\s*)?(\d{1,2})\b/) ||
      textClean.match(/^(\d{1,2})$/);
    if (idxHit) {
      return { intent: "summarize_file", params: { file_index: Number(idxHit[1]) }, source: "quick" };
    }
    if (/อ่านอันแรก|สรุปอันแรก|ไฟล์แรก/.test(textClean)) {
      return { intent: "summarize_file", params: { file_index: 1 }, source: "quick" };
    }
    if (["อ่านและสรุป", "สรุปให้ฟัง", "อ่านสรุป", "สรุปไฟล์", "อ่านไฟล์"].some((kw) => textLower.includes(kw))) {
      // No number yet — ask which file; do not auto-pick.
      return { intent: "summarize_file", params: {}, source: "quick" };
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
    return { intent: parsed.intent || "unknown", params: parsed.params || {}, source: "llm" };
  } catch {
    return { intent: "unknown", params: {}, source: "llm" };
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
    const held = await bookMeetingWithLineHold({
      organizerUpn: userUpn,
      subject,
      startIso: wallIso(start),
      endIso: wallIso(end),
      attendees,
      create: () => createEvent(userUpn, subject, wallIso(start), wallIso(end), attendees),
    });
    const who = person.displayName || attendees[0] || "";
    const extra = attendees.length > 1 ? ` +${attendees.length - 1} คน` : "";
    const headline =
      held.mode === "proposed"
        ? `⏳ ส่งคำขอนัดแล้ว — รออีกฝั่งยืนยัน\n📌 ${subject}\n👤 ${who}${extra}\n🕐 ${fmtDateTime(start)} (${duration} นาที)`
        : `✅ จองประชุมแล้ว!\n📌 ${subject}\n👤 ${who}${extra}\n🕐 ${fmtDateTime(start)} (${duration} นาที)`;
    return {
      intent: held.mode === "proposed" ? "proposed" : "booked",
      reply: headline + held.note,
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

/** Map free-text person token → attendee. Full email, or UPN-like local part (buratsakon.si) + org domain. */
function attendeeFromToken(raw: string, userUpn: string): MtAttendee {
  const s = String(raw || "").trim();
  if (!s) return { name: s };
  const emails = extractEmails(s);
  if (emails.length) return { mail: emails[0] }; // strip leading “นัด ” etc.
  if (s.includes("@")) {
    // Malformed "นัด ake@x.com" already handled; leftover junk with @ → name only
    const cleaned = s.replace(/^(?:นัด|จอง|เชิญ|กับ|และ)\s+/i, "").trim();
    return { name: cleaned.replace(/@/g, " ").trim() || cleaned };
  }
  // Corporate UPN local part: first.last / first.middle.last (from quick-reply “นัดburatsakon.si”)
  if (/^[a-z0-9][a-z0-9._-]{1,80}$/i.test(s) && s.includes(".")) {
    const domain = userUpn.includes("@") ? userUpn.split("@")[1]!.toLowerCase() : "";
    if (domain) return { mail: `${s.toLowerCase()}@${domain}` };
  }
  return { name: s.replace(/^(?:นัด|จอง|เชิญ|กับ|และ)\s+/i, "").trim() || s };
}

async function resolveCancelPersonMails(hint: string, userUpn: string): Promise<string[]> {
  const a = attendeeFromToken(hint, userUpn);
  if (a.mail) return [a.mail.toLowerCase()];
  try {
    const cands = await searchUsers(hint);
    return cands.map((c) => (c.mail || "").toLowerCase()).filter(Boolean);
  } catch {
    return [];
  }
}

function eventTouchesPerson(ev: GraphEvent, hint: string, mails: string[]): boolean {
  const h = hint.trim().toLowerCase();
  const parts: string[] = [ev.subject || ""];
  for (const a of ev.attendees || []) {
    parts.push(a.emailAddress?.name || "", a.emailAddress?.address || "");
  }
  const org = ev.organizer;
  if (org?.emailAddress) {
    parts.push(org.emailAddress.name || "", org.emailAddress.address || "");
  }
  const blob = parts.join(" ").toLowerCase();
  if (h && blob.includes(h)) return true;
  for (const m of mails) {
    if (!m) continue;
    if (blob.includes(m)) return true;
    const local = m.split("@")[0];
    if (local && blob.includes(local)) return true;
  }
  return false;
}

function cancelEventLabel(ev: GraphEvent, now: Date = nowWall()): string {
  const sd = ev.start?.dateTime ? parseWall(ev.start.dateTime) : null;
  const ed = ev.end?.dateTime ? parseWall(ev.end.dateTime) : null;
  const when = sd ? fmtDateTime(sd) : "?";
  const subj = ev.subject || "(ไม่มีหัวข้อ)";
  const others = (ev.attendees || [])
    .map((a) => a.emailAddress?.name || a.emailAddress?.address || "")
    .filter(Boolean)
    .map((s) => (s.includes("@") ? s.split("@")[0]! : s))
    .filter((s, i, arr) => arr.findIndex((x) => x.toLowerCase() === s.toLowerCase()) === i)
    .slice(0, 3);
  const who = others.length ? ` · ${others.join(", ")}` : "";
  const live = sd && ed && now >= sd && now < ed ? "🔴 กำลังประชุม — " : "";
  return `${live}${when} — ${subj}${who}`;
}

function sortCancelEvents(events: GraphEvent[], now: Date = nowWall()): GraphEvent[] {
  const rank = (ev: GraphEvent) => {
    const s = ev.start?.dateTime ? parseWall(ev.start.dateTime)?.getTime() : 0;
    const e = ev.end?.dateTime ? parseWall(ev.end.dateTime)?.getTime() : 0;
    const t = now.getTime();
    if (s && e && t >= s && t < e) return 0;
    if (s && s >= t) return 1;
    return 2;
  };
  return [...events].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
    const sa = a.start?.dateTime ? parseWall(a.start.dateTime)?.getTime() || 0 : 0;
    const sb = b.start?.dateTime ? parseWall(b.start.dateTime)?.getTime() || 0 : 0;
    return sa - sb;
  });
}

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
  // Typos: ช่าวง→ช่วง, เข้า(เมื่อคู่กับช่วง)→เช้า
  const t = text
    .trim()
    .replace(/\s+/g, " ")
    .replace(/ช่าวง/g, "ช่วง")
    .replace(/ช่วง\s*เข้า/g, "ช่วงเช้า");

  // Exact clock in the message → leave to parseThaiClock* (unless ก่อน/หลัง…)
  const hasRelative =
    /ก่อนเที่ยง|หลังเที่ยง|ก่อนบ่าย|หลังบ่าย|ก่อนเย็น|หลังเย็น|หลังเลิกงาน|(?:หลัง|ก่อน|ตั้งแต่|ถึง)\s*\d/.test(
      t
    );
  if (!hasRelative) {
    if (/(?:บ่าย|บ่าน)\s*(?:\d|โมง|หนึ่ง|สอง|สาม|สี่|ห้า|หก)/.test(t)) return null;
    if (/\d{1,2}\s*โมง/.test(t) || /\d{1,2}\s*[:.]\d{2}/.test(t)) return null;
    if (/\d\s*ทุ่ม|(?:^|[\s,])ทุ่ม(?:\s|$)|ทุ่ม\s*\d/.test(t)) return null;
    if (/(?:ตอน|เวลา)?\s*ตี\s*\d/.test(t)) return null;
    if (/เที่ยงคืน|(?:ตอน|เวลา|ที่)\s*เที่ยง(?:วัน|ตรง)?/.test(t)) return null;
  }

  // Relative to noon / afternoon / evening — most specific first
  if (/ก่อนเที่ยง/.test(t)) return { after: null, before: 12 * 60, label: "ก่อนเที่ยง" };
  if (/หลังเที่ยง/.test(t)) return { after: 12 * 60, before: null, label: "หลังเที่ยง" };
  if (/ก่อนบ่าย/.test(t)) return { after: null, before: 13 * 60, label: "ก่อนบ่าย" };
  if (/หลังบ่าย/.test(t)) return { after: 16 * 60, before: null, label: "หลังบ่าย" };
  if (/ก่อนเย็น/.test(t)) return { after: null, before: 16 * 60, label: "ก่อนเย็น" };
  if (/หลังเย็น|หลังเลิกงาน/.test(t)) return { after: 17 * 60, before: null, label: "หลังเลิกงาน" };
  if (/พักเที่ยง|ช่วงเที่ยง|มื้อเที่ยง/.test(t)) return { after: 12 * 60, before: 13 * 60, label: "ช่วงเที่ยง" };

  // Named parts of day (ตอน/ช่วง)
  if (/(?:ตอน|ช่วง)?เช้า|ตอนเช้า|ช่วงเช้า/.test(t) && !/เย็น/.test(t)) {
    return { after: 9 * 60, before: 12 * 60, label: "ช่วงเช้า" };
  }
  if (/(?:ตอน|ช่วง)?สาย|ช่วงสาย/.test(t)) return { after: 9 * 60, before: 12 * 60, label: "ช่วงสาย" };
  if (/(?:ตอน|ช่วง)?บ่าย|ช่วงบ่าย/.test(t) && !/เย็น/.test(t)) {
    return { after: 12 * 60, before: 16 * 60, label: "ช่วงบ่าย" };
  }
  if (/(?:ตอน|ช่วง)?เย็น|ช่วงเย็น|ค่ำ|หัวค่ำ/.test(t)) {
    return { after: 16 * 60, before: 20 * 60, label: "ช่วงเย็น" };
  }

  const afterM = t.match(/(?:หลัง|ตั้งแต่)\s*(\d{1,2})(?::(\d{2}))?\s*(โมง|ทุ่ม)?/);
  const beforeM = t.match(/(?:ก่อน|ถึง)\s*(\d{1,2})(?::(\d{2}))?\s*(โมง|ทุ่ม)?/);
  let after: number | null = null;
  let before: number | null = null;
  if (afterM) {
    let h = Number(afterM[1]);
    const mi = afterM[2] ? Number(afterM[2]) : 0;
    if (afterM[3] === "ทุ่ม") h = h === 1 ? 19 : h + 18;
    else if (afterM[3] === "โมง") {
      if (h >= 1 && h <= 5) h += 12;
      // หลัง 6 โมง → after 06:00
    }
    after = h * 60 + mi;
  }
  if (beforeM) {
    let h = Number(beforeM[1]);
    const mi = beforeM[2] ? Number(beforeM[2]) : 0;
    if (beforeM[3] === "ทุ่ม") h = h === 1 ? 19 : h + 18;
    else if (beforeM[3] === "โมง" && h >= 1 && h <= 5) h += 12;
    before = h * 60 + mi;
  }
  if (after === null && before === null) return null;
  return { after, before, label: "ช่วงที่ระบุ" };
}

function isTimeFollowUp(text: string): boolean {
  const t = text.trim().replace(/\s+/g, " ");
  if (!t) return false;
  if (personFromText(t)) return false;
  if (dayHintFromText(t)) return false;
  // “ดูประชุมเช้านี้ / นัดเช้า / ตารางวันนี้” = list meetings, NOT a band follow-up
  if (/^(ดู|ขอดู|เช็ค|เช็ก)?(ประชุม|นัด|ตาราง)/.test(t)) return false;
  if (/มี(นัด|ประชุม)|รายการ(นัด|ประชุม)/.test(t)) return false;
  // Only short follow-ups after multi-person search: “แล้วบ่ายล่ะ”, “เช้าว่างไหม”
  return (
    /^(?:แล้ว)?(?:ช่วง|ตอน)?(?:เช้า|สาย|บ่าย|เย็น|ค่ำ)(?:\s*ว่าง)?(?:ไหม|มั้ย|ล่ะ|ละ|รึเปล่า|หรือเปล่า)?[!?.…]*$/i.test(
      t
    ) ||
    /^(?:แล้ว)?(?:ก่อน|หลัง)(?:เที่ยง|บ่าย|เย็น)(?:\s*ว่าง)?(?:ไหม|มั้ย|ล่ะ|ละ)?[!?.…]*$/i.test(t) ||
    /^(?:แล้ว)?ว่าง(?:ไหม|มั้ย|รึเปล่า|หรือเปล่า|บ้าง)?[!?.…]*$/i.test(t)
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
  includeLunch = false,
  atMin?: number | null,
  subject?: string,
  dnRef?: string
): string {
  // Mails only — Thai display names URL-encode past LINE's 300-char postback limit
  const at = attendees.map((a) => (a.mail ? `m:${a.mail}` : `n:${a.name || ""}`)).join("|");
  const q = new URLSearchParams({ a: "findmt", d: String(duration), at });
  if (dnRef) q.set("dn", dnRef);
  if (window) {
    q.set("ws", wallIso(window.start));
    q.set("we", wallIso(window.end));
    q.set("wl", window.label);
  }
  if (band?.after != null) q.set("af", String(band.after));
  if (band?.before != null) q.set("bf", String(band.before));
  if (atMin != null) q.set("tm", String(atMin));
  if (subject && subject !== "ประชุม") q.set("subj", subject.slice(0, 80));
  if (includeLunch) q.set("ln", "1");
  return q.toString();
}

/** Persist mail→displayName so LINE postback stays under 300 chars. */
async function stashMtDisplayNames(ownerUpn: string, attendees: MtAttendee[]): Promise<string | undefined> {
  const map: Record<string, string> = {};
  for (const a of attendees) {
    const mail = (a.mail || "").toLowerCase();
    const dn = (a.name || "").trim();
    if (!mail || !dn || dn.includes("@") || dn.toLowerCase() === mail) continue;
    map[mail] = dn;
  }
  if (!Object.keys(map).length) return undefined;
  const id = createHash("sha1")
    .update(`${ownerUpn}|${Date.now()}|${JSON.stringify(map)}`)
    .digest("hex")
    .slice(0, 10);
  await setSetting(ownerUpn, `mt_dn_${id}`, JSON.stringify(map));
  return id;
}

async function loadMtDisplayNames(ownerUpn: string, dnRef: string): Promise<Record<string, string>> {
  if (!dnRef) return {};
  try {
    const raw = await getSetting(ownerUpn, `mt_dn_${dnRef}`);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, string>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function decodeMtAttendees(data: URLSearchParams): {
  attendees: MtAttendee[];
  duration: number;
  window: MtWindow | null;
  after: number | null;
  before: number | null;
  atMin: number | null;
  subject: string;
  includeLunch: boolean;
  dnRef: string;
} {
  const attendees = (data.get("at") || "")
    .split("|")
    .filter(Boolean)
    .map((tok) => {
      if (tok.startsWith("m:")) {
        const rest = tok.slice(2);
        const sep = rest.indexOf("~");
        if (sep >= 0) {
          return { mail: rest.slice(0, sep), name: rest.slice(sep + 1).trim() };
        }
        return { mail: rest };
      }
      if (tok.startsWith("n:")) return { name: tok.slice(2) };
      return { name: tok };
    });
  const ws = parseWall(data.get("ws") || "");
  const we = parseWall(data.get("we") || "");
  const window = ws && we ? { start: ws, end: we, label: data.get("wl") || fmtDate(ws) } : null;
  const af = data.get("af");
  const bf = data.get("bf");
  const tm = data.get("tm");
  return {
    attendees,
    duration: Number(data.get("d") || 30),
    window,
    after: af != null && af !== "" ? Number(af) : null,
    before: bf != null && bf !== "" ? Number(bf) : null,
    atMin: tm != null && tm !== "" ? Number(tm) : null,
    subject: data.get("subj") || "ประชุม",
    includeLunch: data.get("ln") === "1",
    dnRef: data.get("dn") || "",
  };
}

export async function runFindMeeting(
  userUpn: string,
  attendees: MtAttendee[],
  duration: number,
  window?: MtWindow | null,
  band?: { after: number | null; before: number | null; label?: string } | null,
  includeLunch = false,
  subject = "ประชุม",
  atMin: number | null = null,
  opts?: { showMore?: boolean }
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
      const choices = [];
      for (const c of cands.slice(0, 10)) {
        const next = attendees.map((x, j) => (j === i ? { mail: c.mail, name: c.displayName } : x));
        const dnRef = await stashMtDisplayNames(userUpn, next);
        choices.push({
          mail: c.mail,
          displayName: c.displayName || c.mail,
          data: encodeMtData(next, duration, window, band, includeLunch, atMin, subject, dnRef),
        });
      }
      const dayNote = window ? ` (${window.label})` : "";
      return { intent: "choose_mt_person", reply: `เจอหลายคนที่ตรงกับ “${a.name}” เลือกคนที่ต้องการดูตารางครับ${dayNote} 👇`, choices };
    }
  }

  // Fill missing display names for attendees that already have mail (e.g. after LINE postback)
  for (const a of attendees) {
    if (!a.mail) continue;
    const n = (a.name || "").trim();
    if (n && !n.includes("@") && n.toLowerCase() !== a.mail.toLowerCase()) continue;
    try {
      const info = await resolveUserInfo(a.mail);
      if (info?.displayName && !info.displayName.includes("@") && info.displayName.toLowerCase() !== a.mail.toLowerCase()) {
        a.name = info.displayName;
      }
    } catch {
      /* keep mail-only */
    }
  }

  const resolved = Array.from(
    new Set(attendees.filter((a) => a.mail).map((a) => (a.mail as string).toLowerCase()))
  );
  const unresolved = attendees.filter((a) => !a.mail && a.name).map((a) => a.name as string);
  if (!resolved.length) {
    return { intent: "find_meeting_time", reply: "หาคนที่จะดูตารางไม่เจอครับ ลองระบุชื่อ/อีเมลที่ชัดเจนอีกครั้งได้ไหม" };
  }
  if (unresolved.length) {
    return {
      intent: "find_meeting_time",
      reply:
        `หา “${unresolved.join(", ")}” ใน Microsoft 365 ไม่เจอครับ\n` +
        `ลองพิมพ์อีเมลของคนนี้มาด้วย เช่น “นัด ake@gmail.com กับ base@ktisgroup.com …”\n` +
        `(คนที่เจอแล้ว: ${resolved.join(", ")})`,
    };
  }

  let resolvedAt = atMin;
  if (
    resolvedAt == null &&
    band?.after != null &&
    band?.before != null &&
    band.before - band.after <= duration + 1
  ) {
    resolvedAt = band.after;
  }

  const searchBand =
    resolvedAt != null
      ? { after: resolvedAt, before: null as number | null, label: band?.label }
      : band;

  const allStarts = !!(window || searchBand?.after != null || searchBand?.before != null || resolvedAt != null);
  // After lunch / late day — still suggest rest of today (not only jump to tomorrow 09:00)
  const nowMin = minutesOfDay(nowWall());
  const workEndHour =
    searchBand?.before != null
      ? Math.max(WORK_END_HOUR, Math.ceil(searchBand.before / 60))
      : searchBand?.after != null && searchBand.after >= 16 * 60
        ? Math.max(WORK_END_HOUR, 20)
        : resolvedAt != null
          ? Math.max(WORK_END_HOUR, 20)
          : nowMin >= 12 * 60
            ? Math.max(WORK_END_HOUR, 20)
            : undefined;
  // Open search (no fixed day): walk the grid so we don't skip today's evening when filling top-5
  const scanAll = allStarts || (!window && !searchBand?.after && !searchBand?.before && resolvedAt == null);
  const result = await findCommonSlots(
    userUpn,
    resolved,
    duration,
    scanAll ? 48 : 5,
    window ? { start: window.start, end: window.end } : undefined,
    {
      afterMin: searchBand?.after ?? null,
      beforeMin: searchBand?.before ?? null,
      atMin: resolvedAt,
      allStarts: scanAll,
      workEndHour,
      includeLunch,
    }
  );

  const SHOW_CAP = 8;
  const offset = opts?.showMore ? SHOW_CAP : 0;
  // Strip any legacy "· หลังเลิกงาน" on labels — explain once in the reply instead
  const cleaned = result.slots.map((s) => ({
    ...s,
    label: (s.label || "").replace(/\s*·\s*หลังเลิกงาน/g, ""),
  }));
  const todayKey = fmtDate(nowWall());
  const todayFirst = [
    ...cleaned.filter((s) => (s.label || "").startsWith(todayKey)),
    ...cleaned.filter((s) => !(s.label || "").startsWith(todayKey)),
  ];
  const totalFound = todayFirst.length;
  const page = todayFirst.slice(offset, offset + SHOW_CAP);
  result.slots = page;
  const hidden = todayFirst.slice(offset + SHOW_CAP);
  const hiddenCount = hidden.length;
  const tomorrowKey = fmtDate(addDays(startOfDay(nowWall()), 1));
  const moreTomorrow = hidden.some((s) => (s.label || "").startsWith(tomorrowKey));
  const pageHasAfterHours = page.some((s) => {
    const start = parseWall(s.start);
    if (!start) return false;
    return start.getUTCHours() * 60 + start.getUTCMinutes() >= WORK_END_HOUR * 60;
  });

  const note = unresolved.length ? `\n(หาอีเมลไม่เจอ: ${unresolved.join(", ")})` : "";
  const who = await formatAttendeeLines(attendees.filter((a) => a.mail));
  const dayNote = window ? ` (${window.label})` : "";
  const bandNote =
    resolvedAt != null ? ` ตอน ${fmtHHMM(resolvedAt)}` : band?.label ? ` ${band.label}` : "";
  if (!result.slots.length) {
    if (opts?.showMore && totalFound > 0 && offset >= totalFound) {
      return {
        intent: "find_meeting_time",
        reply: "แสดงครบทุกช่วงว่างที่ค้นเจอแล้วครับ — เลือกจากรายการก่อนหน้า หรือพิมพ์วัน/เวลาเองได้ครับ",
      };
    }
    const hint =
      resolvedAt != null
        ? `\n\nช่วง ${fmtHHMM(resolvedAt)} อาจผ่านไปแล้วหรือติด — ลองดูตารางว่าง หรือระบุเวลาใหม่ได้ครับ`
        : "";
    return {
      intent: "find_meeting_time",
      reply: formatBusy(result.busy) + note + hint + `\n(ค้นของ:\n👤 ${who}${dayNote}${bandNote})`,
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

  if (AUTO_BOOK && !opts?.showMore) {
    const s = result.slots[0];
    const held = await bookMeetingWithLineHold({
      organizerUpn: userUpn,
      subject,
      startIso: s.start,
      endIso: s.end,
      attendees: resolved,
      create: () => createEvent(userUpn, subject, s.start, s.end, resolved),
    });
    const head =
      held.mode === "proposed"
        ? `ส่งคำขอนัดแล้ว — รออีกฝั่งยืนยัน ⏳\n${subject} — ${s.label}`
        : `จองให้เลยตามที่ตั้งค่าไว้ ✅\n${subject} — ${s.label}`;
    return { intent: "find_meeting_time", reply: head + held.note };
  }

  // User already named an exact clock time (e.g. 17:30-18:00) →
  // keep THAT calendar day (วันนี้/พรุ่งนี้) — never silently roll to the next day.
  // Show organizer confirm card first (do NOT send yet).
  if (resolvedAt != null && !opts?.showMore) {
    const dayAnchor = window?.start || nowWall();
    const slotStart = new Date(startOfDay(dayAnchor));
    slotStart.setUTCHours(Math.floor(resolvedAt / 60), resolvedAt % 60, 0, 0);
    const slotEnd = addMinutes(slotStart, duration);
    const dayKey = fmtDate(slotStart);
    const exactFromResult = result.slots.find((s) => {
      const start = parseWall(s.start);
      if (!start) return false;
      return (
        fmtDate(start) === dayKey &&
        start.getUTCHours() * 60 + start.getUTCMinutes() === resolvedAt
      );
    });
    const exact =
      exactFromResult ||
      ({
        start: wallIso(slotStart),
        end: wallIso(slotEnd),
        label: `${fmtDateTime(slotStart)}-${fmtTime(slotEnd)}`,
      } as (typeof result.slots)[number]);
    const now = nowWall();
    const pastNote =
      slotEnd.getTime() <= now.getTime()
        ? "\n⚠️ ช่วงเวลานี้ผ่านไปแล้ว — กด “🕐 เวลา” เพื่อแก้ หรือยืนยันถ้าต้องการสร้างตามที่ระบุ"
        : slotStart.getTime() < now.getTime() - 2 * 60_000
          ? "\n⚠️ เวลาเริ่มผ่านไปแล้วเล็กน้อย — กด “🕐 เวลา” ถ้าต้องการเลื่อน"
          : "";
    return {
      intent: "confirm_meeting",
      reply:
        `สรุปนัดก่อนส่งครับ — กดยืนยันถ้าถูกต้อง\n` +
        `👤 ${who}\n` +
        `📌 ${subject}\n` +
        `🕐 ${exact.label}` +
        pastNote +
        note,
      slots: [exact],
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

  const afterHoursNote = pageHasAfterHours
    ? `\n💡 ${String(WORK_END_HOUR).padStart(2, "0")}:00–20:00 น. = หลังเลิกงาน`
    : "";

  const reply =
    (opts?.showMore ? `ช่วงว่างเพิ่มเติมครับ\n` : `เจอเวลาที่ทุกคนว่างตรงกัน${dayNote}${bandNote}ครับ\n`) +
    `👤 ${who}\n` +
    (subject && subject !== "ประชุม" ? `📌 ${subject}\n` : "") +
    `เลือกเวลาเริ่มประชุม (${duration} นาที) จากรายการด้านล่างได้เลย 👇` +
    afterHoursNote +
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
    // Shown after slot #8 in the list + as a quick-reply button
    suggestions:
      hiddenCount > 0 || moreTomorrow
        ? [{ label: "ขอดูเพิ่มเติม", text: "ขอดูเพิ่มเติม" }]
        : undefined,
  };
}

async function formatAttendeeLines(attendees: MtAttendee[]): Promise<string> {
  const lines: string[] = [];
  for (const a of attendees) {
    const mail = (a.mail || "").trim().toLowerCase();
    if (!mail) continue;
    let name = (a.name || "").trim();
    const nameIsMail = !name || name.toLowerCase() === mail || name.includes("@");
    if (nameIsMail) {
      try {
        const info = await resolveUserInfo(mail);
        const dn = (info?.displayName || "").trim();
        if (dn && dn.toLowerCase() !== mail && !dn.includes("@")) name = dn;
        else name = "";
      } catch {
        name = "";
      }
    }
    // Never render "email · email"
    if (!name || name.toLowerCase() === mail || name.includes("@")) {
      lines.push(mail);
    } else {
      lines.push(`${name} · ${mail}`);
    }
  }
  return lines.join("\n👤 ") || "(ไม่ระบุ)";
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
    console.error("[handleCommand]", String(e).slice(0, 300));
    return { intent: "error", reply: `⚠️ ${llmUserErrorMessage(e)}` };
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
      const held = await bookMeetingWithLineHold({
        organizerUpn: userUpn,
        subject,
        startIso: wallIso(start),
        endIso: wallIso(end),
        attendees,
        create: () => createEvent(userUpn, subject, wallIso(start), wallIso(end), attendees),
      });
      const headline =
        held.mode === "proposed"
          ? `⏳ ส่งคำขอนัดแล้ว — รออีกฝั่งยืนยัน\n📌 ${subject}\n🕐 ${fmtDateTime(start)}-${fmtTime(end)}`
          : `✅ จองประชุมแล้ว!\n📌 ${subject}\n🕐 ${fmtDateTime(start)}-${fmtTime(end)}`;
      return {
        intent: held.mode === "proposed" ? "proposed" : "booked",
        reply: headline + (attendees.length ? `\n👤 ${attendees.join(", ")}` : "") + held.note,
      };
    }
    if (a === "cancel") {
      const id = data.get("id") || "";
      if (!id) return { intent: "error", reply: "ไม่พบนัดที่จะยกเลิกครับ" };
      await deleteEvent(userUpn, id);
      return { intent: "cancelled", reply: "✅ ยกเลิกนัดแล้วครับ" };
    }
    if (a === "findmt") {
      const { attendees, duration, window, after, before, atMin, subject, includeLunch, dnRef } = decodeMtAttendees(data);
      if (dnRef) {
        const map = await loadMtDisplayNames(userUpn, dnRef);
        for (const att of attendees) {
          const m = (att.mail || "").toLowerCase();
          if (m && map[m]) att.name = map[m];
        }
      }
      const band =
        after != null || before != null
          ? { after, before, label: after != null && after >= 16 * 60 ? "ช่วงเย็น" : undefined }
          : null;
      return await runFindMeeting(userUpn, attendees, duration, window, band, includeLunch, subject, atMin);
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
      let eventId = data.get("id") || "";
      let fallback: import("@/lib/graph").GraphEvent | undefined;
      const entry = idx ? await resolveAgendaEntry(userUpn, idx) : null;
      if (entry) {
        if (!eventId) eventId = entry.eventId;
        fallback = entry.event;
      }
      if (!eventId && idx) {
        const agenda = await buildMorningAgenda(userUpn);
        const choice = agenda.choices.find((c) => c.index === idx);
        eventId = choice?.event_id || "";
        fallback = agenda.events.find((e) => e.id === eventId);
      }
      if (!eventId) {
        return {
          intent: "error",
          reply: "ไม่พบนัดที่เลือก — พิมพ์ “สรุปตารางเช้า” เพื่อดูรายการใหม่ แล้วกดเลขเพื่อให้แนะนำประชุมครับ",
        };
      }
      const reply = await buildMeetingPrep(userUpn, eventId, fallback);
      return { intent: "meeting_prep", reply };
    }
  } catch (e) {
    return { intent: "error", reply: `⚠️ ทำรายการไม่สำเร็จ: ${String(e).slice(0, 150)}` };
  }
  return { intent: "unknown", reply: "ไม่รู้จักคำสั่งนี้ครับ" };
}

async function handle(userUpn: string, text: string, context?: CommandContext, lite = false): Promise<CommandResult> {
  text = (text || "").normalize("NFC").replace(/\s+/g, " ").trim();

  // Instant calendar list shortcuts BEFORE follow-up heuristics / LLM
  // (prevents “ดูประชุมเช้านี้” being eaten by last_meeting time-band follow-up)
  {
    const quick = quickFeedIntent(text);
    if (quick?.intent === "list_meetings" || quick?.intent === "get_brief") {
      trace("parse", `★ AI:NONE · intent=${quick.intent} (กฎตายตัว ไม่เรียก API)`);
      return await handleParsed(userUpn, text, context, lite, quick.intent, quick.params);
    }
  }

  // if the user has a selected time slot, try to act on it first
  if (context?.selected) {
    const booked = await bookFromContext(userUpn, text, context.selected);
    if (booked) return booked;
  }

  // Follow-up on a multi-person search: "ตอนเย็นว่างไหม" keeps the same attendees + day.
  if (context?.last_meeting?.attendees?.length && isTimeFollowUp(text)) {
    const band = timeBandFromText(text);
    const window = windowFromStored(context.last_meeting) || dayHintFromText(text);
    trace("parse", `★ AI:NONE · intent=find_meeting_time (ติดตามเวลา ไม่เรียก API)`);
    return runFindMeeting(
      userUpn,
      context.last_meeting.attendees.map((mail) => ({ mail })),
      context.last_meeting.duration || 30,
      window,
      band,
      wantsLunchIncluded(text)
    );
  }

  trace("parse", "แยกเจตนา (intent)", "start");
  const { intent, params, source } = await parseIntent(text, context);
  if (source === "quick") {
    trace("parse", `★ AI:NONE · intent=${intent} (กฎตายตัว ไม่เรียก API)`);
  } else {
    trace("parse", `★ AI:ใช้แล้ว · intent=${intent}`);
  }
  return await handleParsed(userUpn, text, context, lite, intent, params);
}

async function handleParsed(
  userUpn: string,
  text: string,
  context: CommandContext | undefined,
  lite: boolean,
  intent: string,
  params: Record<string, unknown>
): Promise<CommandResult> {
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

  if (intent === "find_duplicate_nicknames") {
    trace("fetch", "สแกนชื่อเล่นซ้ำในไดเรกทอรี", "start");
    const res = await findDuplicateNicknames({ maxUsers: 500 });
    if (res.error) {
      return { intent: "find_duplicate_nicknames", reply: `⚠️ ${res.error}` };
    }
    if (!res.groups.length) {
      return {
        intent: "find_duplicate_nicknames",
        nick_dup_offset: 0,
        reply: `สแกนผู้ใช้ในไดเรกทอรี ${res.scanned} คนแล้ว ไม่พบชื่อเล่นไทยที่ซ้ำกันครับ`,
      };
    }

    const PAGE = 8;
    const wantMore = !!params.more;

    if (wantMore) {
      const stored = context?.nick_dup_offset;
      // No cursor = previous reply already listed everything (or stale ctx) → don't re-dump
      if (typeof stored !== "number" || stored <= 0 || stored >= res.groups.length) {
        return {
          intent: "find_duplicate_nicknames",
          nick_dup_offset: res.groups.length,
          reply:
            `ครบแล้วครับ ตามเกณฑ์ตอนนี้มีทั้งหมด ${res.groups.length} กลุ่ม ` +
            `จากบัญชีที่สแกน ${res.scanned} คน — ไม่มีเพิ่มแล้ว`,
        };
      }
    }

    const offset = wantMore ? Math.max(0, Number(context?.nick_dup_offset) || 0) : 0;
    const page = res.groups.slice(offset, offset + PAGE);
    const from = offset + 1;
    const to = offset + page.length;
    const nextOffset = offset + page.length;
    const hasMore = nextOffset < res.groups.length;

    const lines: string[] = [];
    if (!wantMore) {
      lines.push(`พบชื่อเล่นไทยซ้ำ ${res.groups.length} กลุ่ม จากผู้ใช้ที่สแกน ${res.scanned} คนครับ`);
    } else {
      lines.push(`ต่อ — กลุ่มที่ ${from}–${to} จากทั้งหมด ${res.groups.length} กลุ่มครับ`);
    }
    if (res.groups.length > PAGE) {
      lines.push(`(แสดง ${from}–${to}${hasMore ? " · พิมพ์ “มีอีกไหม” เพื่อดูต่อ" : " · ครบแล้ว"})`);
    }
    lines.push("");
    page.forEach((g, i) => {
      lines.push(`${offset + i + 1}) “${g.nick}” — ${g.people.length} คน`);
      g.people.forEach((p) => {
        lines.push(`   • ${(p.displayName || g.nick).trim()}`);
      });
    });
    if (!hasMore && wantMore) {
      lines.push("", `ครบ ${res.groups.length} กลุ่มแล้วครับ`);
    }

    trace("compose", "สรุปรายชื่อเล่นซ้ำ (ไทยทั้งหมด)");
    return {
      intent: "find_duplicate_nicknames",
      nick_dup_offset: nextOffset,
      reply: lines.join("\n"),
      suggestions: hasMore ? [{ label: "มีอีกไหม", text: "มีอีกไหม" }] : undefined,
    };
  }

  if (intent === "link_meeting_file") {
    const denied = needCalendarConsent();
    if (denied) return denied;
    const res = await handleLinkMeetingFile(userUpn, params, context);
    const mi = Number(params.meeting_index || 0) || undefined;
    return mi ? { ...res, last_link_meeting_index: mi } : res;
  }
  if (intent === "link_meeting_url") {
    const denied = needCalendarConsent();
    if (denied) return denied;
    return handleLinkMeetingUrl(userUpn, params);
  }
  if (intent === "list_meeting_materials") {
    const denied = needCalendarConsent();
    if (denied) return denied;
    return handleListMeetingMaterials(userUpn, params);
  }
  if (intent === "unlink_meeting_material") {
    const denied = needCalendarConsent();
    if (denied) return denied;
    return handleUnlinkMeetingMaterial(userUpn, params);
  }

  if (intent === "summarize_file") {
    const files = context?.files || [];
    let target: (typeof files)[number] | null = null;
    const rawIdx = Number(params.file_index ?? 0);
    const idxFromText =
      text.match(/(?:อัน|ข้อ|ไฟล์)\s*(?:ที่\s*)?(\d{1,2})\b/) ||
      (/อ่านอันแรก|สรุปอันแรก|ไฟล์แรก/.test(text) ? ["", "1"] : null);
    const fileIndex = rawIdx > 0 ? rawIdx : idxFromText ? Number(idxFromText[1]) : 0;

    if (files.length && fileIndex > 0) {
      target = files[fileIndex - 1] || null;
      if (!target) {
        return {
          intent,
          reply: `ไม่มีไฟล์ข้อ ${fileIndex} ในรายการครับ (มี ${files.length} ไฟล์) — ลองพิมพ์ “สรุปอัน 1” ถึง “สรุปอัน ${files.length}”`,
          suggestions: [
            { label: "สรุปอัน 1", text: "สรุปอัน 1" },
            { label: "สรุปอัน 2", text: "สรุปอัน 2" },
            { label: "สรุปอัน 3", text: "สรุปอัน 3" },
          ],
        };
      }
    } else if (files.length) {
      // Match an explicit file name in the message (not short generic phrases).
      const textLower = text.toLowerCase();
      const sorted = [...files].sort((a, b) => (b.name || "").length - (a.name || "").length);
      target =
        sorted.find((f) => {
          const name = (f.name || "").toLowerCase();
          return name.length >= 5 && textLower.includes(name);
        }) || null;
      if (!target) {
        target =
          sorted.find((f) => {
            const noExt = (f.name || "").toLowerCase().replace(/\.[^.]+$/, "");
            return noExt.length >= 5 && textLower.includes(noExt);
          }) || null;
      }
      if (!target) {
        return {
          intent,
          reply:
            `ยังไม่ได้เลือกไฟล์ครับ พิมพ์เลขจากรายการ เช่น “สรุปอัน 1” หรือ “อ่านอัน 3” ได้เลย\n` +
            `(อ่านได้: Word / Excel / PowerPoint / ข้อความ — รูปภาพและไฟล์ .ai อ่านเป็นข้อความไม่ได้)`,
          suggestions: [
            { label: "สรุปอัน 1", text: "สรุปอัน 1" },
            { label: "สรุปอัน 2", text: "สรุปอัน 2" },
            { label: "สรุปอัน 3", text: "สรุปอัน 3" },
          ],
        };
      }
    }
    if (!target) {
      return { intent, reply: "ไม่พบไฟล์ที่ต้องการให้อ่านและสรุปครับ ลองพิมพ์ค้นหาไฟล์ก่อน เช่น “หาไฟล์ ...”" };
    }

    const fileName = target.name || "เอกสาร";
    const fileUrl = target.url || "";
    const linkLine = fileUrl ? `\n🔗 ${fileUrl}` : "";
    const low = fileName.toLowerCase();

    if (target.is_folder) {
      return {
        intent,
        reply: `📁 **โฟลเดอร์:** ${fileName}${linkLine}\n\nเป็นโฟลเดอร์จัดเก็บเอกสาร — เปิดดูไฟล์ด้านในบน OneDrive ได้จากลิงก์ครับ`,
      };
    }
    if (/\.(jpg|jpeg|png|gif|webp|bmp|tiff?|svg)$/i.test(low)) {
      return {
        intent,
        reply: `🖼️ **ไฟล์รูปภาพ:** ${fileName}${linkLine}\n\nเป็นรูปภาพ อ่านเป็นข้อความสรุปไม่ได้ครับ — เปิดดูรูปบน OneDrive ได้จากลิงก์`,
      };
    }
    if (/\.(ai|psd|eps|indd)$/i.test(low)) {
      return {
        intent,
        reply: `🎨 **ไฟล์ออกแบบ:** ${fileName}${linkLine}\n\nไฟล์ประเภทนี้ (เช่น Illustrator .ai) อ่านเป็นข้อความไม่ได้ครับ — เปิดดูบน OneDrive ได้จากลิงก์`,
      };
    }
    if (/\.pdf$/i.test(low)) {
      return {
        intent,
        reply: `📄 **ไฟล์ PDF:** ${fileName}${linkLine}\n\nยังสรุปเนื้อหา PDF อัตโนมัติไม่ได้ในตอนนี้ครับ — เปิดอ่านบน OneDrive ได้จากลิงก์`,
      };
    }

    if (!target.id) {
      return {
        intent,
        reply: `📄 **ไฟล์:** ${fileName}${linkLine}\n\nหาเนื้อหาไฟล์ไม่เจอครับ — ลองเปิดจากลิงก์ OneDrive`,
      };
    }

    trace("compose", `อ่านไฟล์ ${fileName}`);
    let body = "";
    try {
      body = await downloadDriveText(userUpn, target.id, 12000);
    } catch {
      body = "";
    }
    if (!body.trim()) {
      return {
        intent,
        reply:
          `📄 **ไฟล์:** ${fileName}${linkLine}\n\n` +
          `ดึงข้อความจากไฟล์นี้ไม่สำเร็จครับ (อาจเป็นไฟล์ไบนารี/ล็อกสิทธิ์)\n` +
          `รองรับสรุปอัตโนมัติ: .docx .xlsx .pptx .txt .md .csv .html`,
      };
    }

    try {
      const summary = await chat(
        "คุณเป็นผู้ช่วยสรุปเอกสารสั้นๆ เป็นภาษาไทย อ่านเนื้อหาที่ให้แล้วสรุปประเด็นสำคัญ 3–8 ข้อ กระชับ ชัดเจน ห้ามแต่งข้อมูลที่ไม่มีในไฟล์",
        `ชื่อไฟล์: ${fileName}\n\nเนื้อหา:\n${body.slice(0, 10000)}`,
        { temperature: 0.2, timeoutMs: 25000 }
      );
      return {
        intent,
        reply: `📄 **สรุป: ${fileName}**${linkLine}\n\n${summary.trim()}`,
      };
    } catch (e) {
      return {
        intent,
        reply:
          `📄 **ไฟล์:** ${fileName}${linkLine}\n\n` +
          `อ่านไฟล์ได้บางส่วน แต่สรุปด้วย AI ไม่สำเร็จ: ${llmUserErrorMessage(e)}\n\n` +
          `ข้อความต้นทาง (ตัดสั้น):\n${body.slice(0, 1200)}`,
      };
    }
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
    let eventId = "";
    let fallback: import("@/lib/graph").GraphEvent | undefined;
    const entry = idx ? await resolveAgendaEntry(userUpn, idx) : null;
    if (entry) {
      eventId = entry.eventId;
      fallback = entry.event;
    }
    if (!eventId && params.subject) {
      const agenda = await buildMorningAgenda(userUpn);
      const q = String(params.subject).toLowerCase();
      const hit = agenda.events.find((e) => (e.subject || "").toLowerCase().includes(q));
      eventId = hit?.id || "";
      fallback = hit;
    }
    if (!eventId) {
      const agenda = await buildMorningAgenda(userUpn);
      return {
        intent: "choose_prep",
        reply: "บอกหมายเลขนัดด้วยครับ เช่น “เตรียมนัด 1”\n\n" + agenda.text,
        choices: agenda.choices.map((c) => ({ index: c.index, event_id: c.event_id, label: c.label })),
      };
    }
    const reply = await buildMeetingPrep(userUpn, eventId, fallback);
    return { intent: "meeting_prep", reply };
  }

  if (intent === "get_news") {
    trace("fetch", "ดึงข่าวจากแหล่งที่ติดตาม", "start");
    const DIGEST_BUDGET_MS = 40_000;
    const timedOut: DigestResult = {
      stories: [],
      skipped: ["หมดเวลารอสรุปข่าว"],
      note: "สรุปข่าวใช้เวลานานเกินไปครับ — ลองพิมพ์ “ข่าววันนี้” อีกครั้ง หรือ “ดูแหล่งข่าว” เพื่อตรวจแหล่งก่อนได้ครับ",
    };
    let digest: DigestResult;
    try {
      digest = await Promise.race([
        buildDigest(userUpn),
        new Promise<DigestResult>((resolve) => setTimeout(() => resolve(timedOut), DIGEST_BUDGET_MS)),
      ]);
    } catch (e) {
      digest = {
        stories: [],
        skipped: [String(e).slice(0, 80)],
        note: "ดึงข่าวไม่สำเร็จครับ ลองใหม่อีกครั้งได้เลย",
      };
    }
    trace("fetch", digest.stories.length ? `ได้ข่าว ${digest.stories.length} เรื่อง` : "ไม่มีข่าวใหม่");
    const { stories, skipped, note } = digest;
    if (!stories.length) {
      const extra = skipped.length ? `\n(ข้าม: ${skipped.join(", ")})` : "";
      trace("compose", "แจ้งผลสรุปข่าว");
      return {
        intent,
        reply:
          (note || "ยังไม่มีข่าวให้สรุปครับ") +
          "\n\nเพิ่มแหล่งได้ในแชท เช่น “เพิ่มแหล่งข่าว https://...” หรือ “ดูแหล่งข่าว” แล้วลองพิมพ์ “มีข่าวอะไรบ้าง” อีกครั้งครับ" +
          extra,
      };
    }
    const extra = skipped.length ? `\n\n(ข้ามบางแหล่ง: ${skipped.join(", ")})` : "";
    await rememberDeliveredStories(userUpn, stories);
    trace("compose", "สรุปข่าวภาษาไทย");
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

    const tNorm = (text || "").normalize("NFC").replace(/\s+/g, " ").trim();

    // Dedicated path: morning list — TODAY only.
    // Prefer ASCII flag `_morning` from quick intent (survives any Thai-regex bundling issues).
    const flaggedMorning = params._morning === true || params._morning === "true";
    const wantMorningToday =
      (flaggedMorning && !hasTomorrowHint(tNorm)) ||
      (!hasTomorrowHint(tNorm) &&
        (hasMorningMeetingsHint(tNorm) ||
          (String(params.period || "") === "today" &&
            hasMorningWord(tNorm) &&
            (params.before != null || params.after != null))));

    if (wantMorningToday) {
      const todayYmd = nowLocal().date; // Asia/Bangkok YYYY-MM-DD — no wall-clock Date math
      const after = parseHHMM(params.after) ?? 0;
      const before = parseHHMM(params.before) ?? 12 * 60;
      let events = await getEventsRange(userUpn, `${todayYmd}T00:00:00`, `${todayYmd}T23:59:59`);
      events = events.filter((ev) => {
        const raw = (ev.start?.dateTime || "").replace(" ", "T");
        const ymd = raw.slice(0, 10);
        if (ymd !== todayYmd) return false;
        const m = eventStartMinutes(ev);
        if (m === null) return false;
        return m >= after && m < before;
      });
      const label = windowLabel("วันนี้", after, before);
      const period = "today";
      trace("fetch", `morning-today ${todayYmd} n=${events.length}`);
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
      await saveAgendaIds(userUpn, events);
      const reply = lite ? formatEventsSimple(events, label) : await buildForEvents(userUpn, events, label);
      return withCalendarNext({ intent, reply, data: events, period }, "meetings");
    }

    // Hard override: band-of-day queries must never inherit last_period=week
    let period = resolvePeriodParam(tNorm, params, context, "upcoming");
    const bandHint = /บ่ายนี้|เย็นนี้|ค่ำนี้/.test(tNorm);
    if (bandHint) {
      period = /พรุ่งนี้/.test(tNorm) ? "tomorrow" : "today";
    }
    const day = params.date ? resolveDay(String(params.date)) : params.weekday ? resolveWeekday(String(params.weekday)) : null;
    const after = parseHHMM(params.after);
    const before = parseHHMM(params.before);
    const at = parseHHMM(params.at);

    // Self agenda — never continue last_person as the subject
    const selfAgenda =
      /^(ดู)?(ประชุม|นัด)|ตารางวันนี้|มีนัดอะไร|มีประชุมอะไร|เช้านี้|บ่ายนี้/.test(tNorm) &&
      !params.person &&
      !/(?:ของ|กับ)\s*\S/.test(tNorm);

    if (!selfAgenda) {
      const { name: person, info: personInfo } = await continuedPerson(tNorm, context);
      if (person) {
        const busy = await personBusyResponse(userUpn, person, day, period, after, before, at, personInfo);
        return withCalendarNext({ ...busy, period: day ? undefined : period }, "meetings");
      }
    }

    let { start, end, label } = day || periodRange(period);
    let events = await getEventsRange(userUpn, wallIso(start), wallIso(end));

    // Don't widen to "upcoming" when user asked a specific day/window
    const pinnedWindow = after !== null || before !== null || /เช้า|บ่าย|เย็น|วันนี้|พรุ่งนี้/.test(tNorm);
    if (
      !events.length &&
      !day &&
      (period === "today" || period === "tomorrow") &&
      at === null &&
      !pinnedWindow
    ) {
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

    // When period is today/tomorrow, drop any events that fell outside that calendar day
    if (!day && (period === "today" || period === "tomorrow")) {
      const dayR = periodRange(period);
      const dayKey = fmtDate(dayR.start);
      events = events.filter((ev) => {
        const sd = ev.start?.dateTime ? parseWall(ev.start.dateTime) : null;
        return !!sd && fmtDate(sd) === dayKey;
      });
      if (/7 วัน|สัปดาห์|2 สัปดาห์/.test(label)) {
        label = windowLabel(dayR.label, after, before);
      }
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
    await saveAgendaIds(userUpn, events);
    const reply = lite ? formatEventsSimple(events, label) : await buildForEvents(userUpn, events, label);
    return withCalendarNext({ intent, reply, data: events, period }, "meetings");
  }

  if (intent === "my_availability") {
    const denied = needCalendarConsent();
    if (denied) return denied;

    // Safety net: LLM/quick path still glued “เบสกับพี่แบง” into one person
    {
      const glued = String(params.person || "").trim();
      const multi =
        peopleFromText(text).length >= 2
          ? peopleFromText(text)
          : glued && /(?:กับ|และ|,|\s+พี่|\s+คุณ|\s+น้อง)/.test(glued)
            ? peopleFromText(`ตาราง ${glued}`).length >= 2
              ? peopleFromText(`ตาราง ${glued}`)
              : glued
                  .split(/\s*(?:กับ|และ|,)\s*/)
                  .map((s) => stripHonorificPublic(s).trim())
                  .filter(Boolean)
            : [];
      if (multi.length >= 2) {
        return runFindMeeting(
          userUpn,
          multi.map((name) => ({ name })),
          Number(params.duration_min || 30),
          resolveFindWindow(params, text),
          timeBandFromText(text),
          wantsLunchIncluded(text),
          "ประชุม",
          null
        );
      }
    }

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
      reply:
        `เจอ ${files.length} ไฟล์ที่ตรงกับ “${label}” ครับ 👇\n\n` +
        `จะผูกกับนัดวันนี้ พิมพ์ เช่น “ผูกไฟล์นัด 1” หรือ “แนบอัน 2 กับนัด 1”\n` +
        `ผูกลิงก์: “แนบลิงก์นัด 1 https://…”`,
      files: files.map((f) => ({
        id: f.id,
        name: f.name,
        url: f.webUrl,
        is_folder: !!(f as { folder?: unknown }).folder,
        modified: f.lastModifiedDateTime,
      })),
      suggestions: [
        { label: "สรุปอัน 1", text: "สรุปอัน 1" },
        { label: "สรุปอัน 2", text: "สรุปอัน 2" },
        { label: "ผูกไฟล์นัด 1", text: "ผูกไฟล์นัด 1" },
      ],
    };
  }

  if (intent === "cancel_meeting") {
    const denied = needCalendarConsent();
    if (denied) return denied;
    const { start, end } = periodRange("upcoming");
    let events = await getEventsRange(userUpn, wallIso(start), wallIso(end));
    // Still cancellable until end time (in-progress included)
    const now = nowWall();
    events = events.filter((ev) => {
      const ed = ev.end?.dateTime ? parseWall(ev.end.dateTime) : null;
      return !ed || ed > now;
    });
    if (!events.length) return { intent, reply: "ไม่มีนัดที่จะยกเลิกในช่วง 2 สัปดาห์ข้างหน้าครับ" };

    const personHint = String(params.person || "").trim();
    if (personHint) {
      const mails = await resolveCancelPersonMails(personHint, userUpn);
      const filtered = events.filter((ev) => eventTouchesPerson(ev, personHint, mails));
      if (!filtered.length) {
        const choices = sortCancelEvents(events, now).map((ev) => ({
          event_id: ev.id!,
          label: cancelEventLabel(ev, now),
        }));
        return {
          intent: "choose_cancel",
          reply: `ไม่พบนัดที่เกี่ยวกับ “${personHint}” ครับ — เลือกรายการทั้งหมดได้ด้านล่าง 👇`,
          choices,
        };
      }
      events = filtered;
    }

    events = sortCancelEvents(events, now);
    const choices = events.map((ev) => ({ event_id: ev.id!, label: cancelEventLabel(ev, now) }));
    const liveCount = choices.filter((c) => c.label.startsWith("🔴")).length;
    let reply = personHint
      ? `เจอนัดที่เกี่ยวกับ “${personHint}” ${choices.length} รายการ — เลือกที่ยกเลิกครับ 👇`
      : "เลือกนัดที่ต้องการยกเลิกครับ 👇";
    if (liveCount) {
      reply =
        `นัดที่ยังไม่หมดเวลา/กำลังประชุม ยกเลิกได้ครับ\n` +
        (personHint ? `กรอง “${personHint}” แล้ว ` : "") +
        `เลือกด้านล่าง 👇`;
    }
    return { intent: "choose_cancel", reply, choices };
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
    // Don't reuse last booking's 10 นาที for a fresh “ดูตาราง…” ask
    const duration = Number(
      params.duration_min ||
        (!attendeesRaw.length ? context?.last_meeting?.duration : undefined) ||
        30
    );
    let window = resolveFindWindow(params, text);
    // Only reuse last meeting day for short time follow-ups (“แล้วบ่ายล่ะ”) — not for a new “ดูตาราง A กับ B”
    if (!window && isTimeFollowUp(text)) {
      window = windowFromStored(context?.last_meeting);
    }
    const bandFromParams = {
      after: parseHHMM(params.after),
      before: parseHHMM(params.before),
      label: undefined as string | undefined,
    };
    const band = (bandFromParams.after != null || bandFromParams.before != null)
      ? bandFromParams
      : timeBandFromText(text);

    // Fresh invite with email(s) → don't pull last_meeting crowd, but KEEP nicknames
    // in the same message (e.g. "นัด ake@gmail.com กับเบส").
    const emailsInText = extractEmails(text);
    const freshInvite =
      emailsInText.length > 0 && /ส่งนัด|นัดหา|เชิญ|invite\b|นัด\s|จอง\s/i.test(text);
    let attendeeTokens: string[] = sanitizeAttendeeTokens(attendeesRaw.map(String));
    if (freshInvite) {
      attendeeTokens = sanitizeAttendeeTokens([
        ...attendeeTokens,
        ...emailsInText,
        ...nameTokensBesideEmails(text),
      ]);
      if (!attendeeTokens.length) attendeeTokens = [...emailsInText];
    } else if (!attendeeTokens.length) {
      attendeeTokens = (context?.last_meeting?.attendees || []).map(String);
    }
    const attendees: MtAttendee[] = attendeeTokens.map((token) =>
      attendeeFromToken(String(token), userUpn)
    );

    if (!attendees.length) {
      return { intent: "find_meeting_time", reply: "ยังไม่ทราบว่าจะนัดกับใครครับ ลองระบุชื่อคนที่ต้องการดูตารางด้วยนะครับ" };
    }
    let subject = String(params.note || params.subject || "ประชุม").trim() || "ประชุม";
    let atMin = parseHHMM(params.at);
    let meetDuration = duration;

    // Recover duration / subject from the raw line when the parser/LLM dropped them
    const durHit = text.match(/(\d+)\s*(?:นาที|min)/i);
    if (durHit) meetDuration = Math.max(5, Number(durHit[1]));
    const noteHit = text.match(/\sเรื่อง\s+(.+)$/i);
    if (noteHit) {
      const recovered = noteHit[1].trim().replace(/[.,]+$/g, "").trim();
      if (recovered) subject = recovered.slice(0, 200);
    }
    const rangeHit = text.match(/(\d{1,2})[:.](\d{2})\s*(?:[-–—]|ถึง)\s*(\d{1,2})[:.](\d{2})/);
    if (rangeHit) {
      const startMin = Number(rangeHit[1]) * 60 + Number(rangeHit[2]);
      const endMin = Number(rangeHit[3]) * 60 + Number(rangeHit[4]);
      if (atMin == null) atMin = startMin;
      const span = endMin - startMin;
      if (span >= 5 && span <= 8 * 60) meetDuration = span;
      subject = subject
        .replace(rangeHit[0], " ")
        .replace(/\bวันนี้\b|\bพรุ่งนี้\b/g, " ")
        .replace(/\s+/g, " ")
        .trim() || "ประชุม";
    } else if (atMin == null) {
      const single = text.match(/(?:ตอน|เวลา|ที่)\s*(\d{1,2}:\d{2})/i) || text.match(/\b(\d{1,2}:\d{2})\b/);
      if (single) atMin = parseHHMM(single[1]);
      else atMin = parseClockToMinutes(text);
    }

    return runFindMeeting(
      userUpn,
      attendees,
      meetDuration,
      window,
      band,
      wantsLunchIncluded(text),
      subject,
      atMin,
      { showMore: !!params.show_more }
    );
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
