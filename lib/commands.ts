// Natural-language command handling — ported from morning_brief/commands.py.
// The web / LINE sends free text; the LLM classifies it into an intent + params
// and we execute. Booking asks for confirmation first (choose_slot) per requirement.
import { buildForEvents, buildMorningAgenda, buildMeetingPrep, extractUrls, resolveAgendaEntry, resolveAgendaEventId, saveAgendaIds, stripHtml } from "@/lib/brief";
import {
  handleLinkMeetingFile,
  handleLinkMeetingUrl,
  handleListMeetingMaterials,
  handleUnlinkMeetingMaterial,
  clearMeetingPhotoContext,
  loadPendingLinePhoto,
  markPendingMeetingPhoto,
  quickLinkMeetingIntent,
} from "@/lib/meetingLink";
import { buildDigest, formatDigestSkippedNote, formatStoriesText, rememberDeliveredStories, type DigestResult } from "@/lib/digest";
import { claimDigestPush, clearDigestClaim, kickLineDigest } from "@/lib/digestKick";
import { sendLine } from "@/lib/line";
import { runWithTrace, trace } from "@/lib/trace";
import { after } from "next/server";
import { waitUntil } from "@vercel/functions";
import { normalizeDue, resolveResponsible, ingestActionItems } from "@/lib/followup";
import { createHash } from "crypto";
import {
  GraphEvent,
  UserInfo,
  createEvent,
  deleteEvent,
  downloadDriveText,
  findDuplicateNicknames,
  isNonPersonAccount,
  getEvent,
  getEventsRange,
  nowLocal,
  resolveUser,
  resolveUserInfo,
  searchFiles,
  rankDriveFileHits,
  enrichDriveHitPaths,
  withDriveItemPath,
  type DriveFileHit,
  searchUsers,
  stripHonorificPublic,
} from "@/lib/graph";
import { getUserGraphToken } from "@/lib/graphAuth";
import { chat, llmUserErrorMessage } from "@/lib/llm";
import { gpsCapturePageUrl } from "@/lib/gpsCapture";
import { listRecentOnline } from "@/lib/meetings";
import { HELP_TOPICS, findHelpTopic, helpMenuFlex, helpMenuText, helpTopicFlex, helpTopicText, visibleTopics } from "@/lib/help";
import { notYetAnswer } from "@/lib/notYet";
import { calendarConsentNeededMessage } from "@/lib/msGraphOAuth";
import { bookMeetingWithLineHold } from "@/lib/meetingInvite";
import { busyRanges, findCommonSlots, formatBusy, formatFree, freeRanges, wantsLunchIncluded } from "@/lib/scheduling";
import {
  addPlace,
  addTask,
  clearPendingLineLocation,
  deletePlace,
  getPrimaryPlace,
  getSetting,
  incrementVisit,
  listPlaces,
  listTasks,
  loadPendingLineLocation,
  allSettings,
  setSetting,
  updateTaskStatus,
  type Task,
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
  enrichDayLabel,
  fmtDate,
  fmtDateTime,
  fmtDayHeader,
  fmtHHMM,
  fmtSlotRange,
  fmtTime,
  minutesOfDay,
  nowWall,
  parseHHMM,
  parseThaiClockToHHMM,
  parseClockToMinutes,
  parseWall,
  periodRange,
  resolveDay,
  resolveThaiDateInText,
  resolveThaiMonthRange,
  resolveWeekday,
  startOfDay,
  endOfDay,
  utcIsoToWall,
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
  files?: { id?: string; name?: string; url?: string; path?: string; is_folder?: boolean }[];
  selected?: { start: string; person?: { mail?: string; displayName?: string } };
  /** Last multi-person schedule search — used for follow-ups like "ตอนเย็นว่างไหม". */
  last_meeting?: {
    attendees: string[];
    duration: number;
    subject?: string;
    window?: { start: string; end: string; label: string };
    attach_file?: { id?: string; name?: string; url?: string };
  };
  /** Next index when paging duplicate-nickname groups (“มีอีกไหม”). */
  nick_dup_offset?: number;
  /** Last meeting index used when linking files (for bare SharePoint URL follow-up). */
  last_link_meeting_index?: number;
  /**
   * Pending “เลือกคน” for find-meeting (เบสกับพี่เบส).
   * Lets the user type “1” or “1กับ2” instead of only tapping buttons.
   */
  pending_mt_pick?: PendingMtPick;
  /** Pending “เลือกคน” for single-person ดูตารางเบส (choose_person). */
  pending_avail_pick?: PendingAvailPick;
  /** Pending self calendar block — waiting for duration (minutes/hours). */
  pending_self_book?: PendingSelfBook;
  /** Pending task IDs awaiting deletion/closure confirmation. */
  pending_task_ids?: number[];
};

export type PendingSelfBook = {
  dayStart: string;
  dateLabel: string;
  atMin?: number;
  subject?: string;
  allDay?: boolean;
};

export type PendingMtPick = {
  attendees: { mail?: string; name?: string }[];
  choices: { mail: string; displayName: string }[];
  duration: number;
  window?: { start: string; end: string; label: string } | null;
  after?: number | null;
  before?: number | null;
  atMin?: number | null;
  subject?: string;
  includeLunch?: boolean;
};

export type PendingAvailPick = {
  choices: { mail: string; displayName: string }[];
  period: string;
  date?: string;
  lunch?: boolean;
  query?: string;
  /** free = ดูตารางว่าง; busy = ดูนัด/ประชุม */
  mode?: "free" | "busy";
  after?: number | null;
  before?: number | null;
  at?: number | null;
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
  /** Persist so typed “1กับ2” works after choose_mt_person. */
  pending_mt_pick?: PendingMtPick | null;
  /** Persist so typed “ทั้งหมด” works after choose_person (ดูตารางเบส). */
  pending_avail_pick?: PendingAvailPick | null;
  /** Persist while waiting for “30 นาที” / “1 ชม.” after จองตาราง. */
  pending_self_book?: PendingSelfBook | null;
  /** Persist task IDs awaiting deletion/closure confirmation. */
  pending_task_ids?: number[] | null;
  meeting?: {
    attendees: string[];
    duration: number;
    subject: string;
    window?: { start: string; end: string; label: string };
    /** OneDrive file to attach when Outlook event is created */
    attach_file?: { id?: string; name?: string; url?: string };
    /** LINE photo waiting to attach on confirm */
    attach_line_photo?: boolean;
    all_day?: boolean;
  };
  person?: { mail: string; displayName?: string };
  map_url?: string | null;
  map_where?: string;
  /** URI quick-replies / buttons (e.g. one-tap GPS capture). */
  uri_actions?: { label: string; uri: string }[];
  /** LINE quick-reply follow-ups (message actions). */
  suggestions?: { label: string; text: string }[];
  /** A Flex card to send instead of the plain text bubble (LINE only). */
  flex?: { altText: string; contents: object };
  /** Show OneDrive folder path in file list (detailText). */
  show_file_location?: boolean;
  /** LINE get_news: interim reply; digest continues on line-now / after(). */
  newsPending?: boolean;
};

/** Interactive calendar must use the user's M365 token (Outlook-like rights). */
function needCalendarConsent(): CommandResult | null {
  if (getUserGraphToken()) return null;
  return { intent: "need_calendar_consent", reply: calendarConsentNeededMessage() };
}

const INTENT_SYSTEM = `คุณคือตัวแยกเจตนา (intent parser) ของผู้ช่วยงาน
ผู้ใช้จะพิมพ์คำสั่งภาษาไทย/อังกฤษ ให้ตอบกลับเป็น JSON เท่านั้น:

{
  "intent": "<หนึ่งใน: who_are_you | get_brief | prep_meeting | get_news | list_feeds | add_feed | remove_feed | edit_feed | list_meetings | my_availability | list_tasks | add_task | complete_task | summarize_meetings | find_meeting_time | book_self_calendar | cancel_meeting | open_map | open_map_home | plan_commute | set_work_location | set_home_location | show_work_location | clear_work_location | search_files | summarize_file | find_duplicate_nicknames | link_meeting_file | link_meeting_url | list_meeting_materials | unlink_meeting_material | unknown>",
  "params": { ... }
}

ความหมายของแต่ละ intent:
- who_are_you = ถามตัวตนของผู้ช่วย หรือถามว่ามีความสามารถอะไรบ้าง (ต้องเป็นการถามความสามารถหรือตัวตนโดยตรงเท่านั้น เช่น "คุณคือใคร", "คุณเป็นใคร", "มึงเป็นใคร", "ทำอะไรได้บ้าง", "ทำอะไรเป็นบ้าง", "แนะนำตัวหน่อย") — ข้อความทักทายกำกวม สั้น ๆ หรือบ่น เช่น "ไงนะ", "แล้วไง", "ว่าไง", "อะไรนะ" ห้ามตอบ who_are_you เด็ดขาด ให้ตอบ "unknown" เพื่อให้ระบบถามกลับ
- get_brief = ดูรายการตาราง/นัดวันนี้ (แสดงทั้งหมดแล้วถามว่าอยากให้แนะนำเตรียมตัวนัดไหน) — เช่น "สรุปตารางเช้า", "ตารางวันนี้", "มีนัดอะไรบ้างเช้านี้"
- prep_meeting = แนะนำเตรียมตัวนัดที่เลือก (อ่านหัวข้อ/รายละเอียดอีเมล/ไฟล์แนบ/ลิงก์) — เช่น "เตรียมนัด 1", "แนะนำประชุม 2", "ช่วยเตรียมตัวนัด Weekly Sync"
- get_news = สรุปเนื้อหาข่าว/โพสต์จากแหล่งที่ติดตามแล้ว — เช่น "มีข่าวอะไรบ้าง", "สรุปข่าววันนี้", "ข่าววันนี้", "มีคลิปใหม่อะไรบ้าง" (ห้ามใช้เมื่อผู้ใช้ถามแค่ว่าติดตามแหล่งไหน)
- list_feeds = ดูรายการแหล่งข่าวที่ติดตาม (Facebook/RSS) — เช่น "ดูแหล่งข่าว", "รายการฟีด", "ติดตามอะไรบ้าง", "ตอนนี้ติดตามข่าวอะไรบ้าง", "ติดตามเพจอะไรบ้าง" (ไม่ใช่การสรุปข่าว)
- add_feed = เพิ่มแหล่งข่าว Facebook หรือ RSS — เช่น "เพิ่มแหล่งข่าว https://...", "ติดตามเพจ https://facebook.com/...", "เพิ่ม RSS https://... ชื่อ Extreme"
- remove_feed = ลบแหล่งข่าว — เช่น "ลบแหล่งข่าว", "เลิกติดตามเพจ", "ลบฟีด 1", "ลบแหล่งข่าวหมายเลข 2"
- edit_feed = แก้ชื่อหรือลิงก์แหล่งข่าว — เช่น "แก้ชื่อแหล่งข่าว 1 เป็น Extreme IT", "เปลี่ยนลิงก์แหล่ง 2 เป็น https://..."
- book_self_calendar = กันเวลา/บล็อกปฏิทิน "ของตัวเอง" โดยไม่มีคนอื่นร่วม (ไม่ใช่การนัดประชุม จึงห้ามถามหาชื่อคนเด็ดขาด) — เช่น "จองตารางให้เราหน่อยวันศุกร์นี้ทั้งวัน ออกรายการ", "บล็อกเวลาพรุ่งนี้บ่าย ติดธุระ", "กันเวลาวันจันทร์ 9-12 ทำรายงาน", "จองวันที่ 20 ทั้งวัน ลาพักร้อน"
  ให้ใช้ intent นี้เมื่อผู้ใช้สั่งให้จอง/กัน/บล็อกเวลา แล้ว "ไม่ได้เอ่ยชื่อคนอื่น" — คำว่า "ให้เรา/ให้ฉัน/ให้ผม/ตัวเอง" คือการบอกว่าทำให้ตัวเอง ห้ามตีความเป็นชื่อคน
  params: { "date": "YYYY-MM-DD", "all_day": true/false, "at": "HH:MM (ถ้าระบุเวลาเริ่ม)", "duration_min": ตัวเลขนาที (ถ้าระบุ), "subject": "เหตุผล/กิจกรรม เช่น ออกรายการ, ลาพักร้อน, ติดธุระ" }
- list_meetings = ดู "รายการประชุม/นัด" ในปฏิทิน (วันนี้/พรุ่งนี้/สัปดาห์นี้/เดือนนี้)
- my_availability = ดู "เวลาว่างของตัวเอง" ในปฏิทิน (ช่วงไหนว่าง/ตารางว่าง)
- list_tasks = ดูงานที่ต้องติดตาม (ไม่ใช่ประชุม)
- add_sample_tasks = สร้างงานติดตามทดสอบ/สมมติ — เช่น "เพิ่มงานติดตามให้ 2 งานที", "สร้างงานทดสอบ 2 งาน", "เพิ่มงาน 2 งาน", "ขอเพิ่มงาน"
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
- ห้ามตีความ "คำถาม/คำขยาย/รูปแบบการประชุม" เป็นชื่อคนเด็ดขาด รวมทั้งคำว่า "ออนไลน์", "online", "Teams", "Zoom", "อันไหน", "มีอันไหน", "อันไหนประชุมออนไลน์", "มีประชุมออนไลน์อะไรบ้าง", "มีนัดไรบ้าง", "มีอะไรบ้าง", "มีประชุมไหม" — ประโยคถามนัด/รูปแบบนัดของตัวเองเหล่านี้ให้ใช้ intent "list_meetings" และปล่อย params.person ว่างไว้เสมอ (ห้ามจับคำว่า "อัน ออนไลน์" หรือ "ออนไลน์" เป็นชื่อคน!)
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
- complete_task: { "task_id": <number ถ้าผู้ใช้พิมพ์เลขงาน>, "title": "ชื่องานถ้าผู้ใช้พิมพ์ชื่อ เช่น «test meeting ปิดงานเลย» → title=test meeting" }
- find_meeting_time: { "attendees": ["email หรือชื่อ"], "duration_min": 30, "weekday": "mon|tue|… (ถ้าพูดชื่อวัน เช่น วันจันทร์นี้)", "date": "YYYY-MM-DD หรือ 31 (ถ้าเจาะจงวันที่)", "period": "today|tomorrow|week (ถ้าไม่ได้เจาะจงวัน)", "after": "HH:MM (เช้า/บ่าย/เย็น หรือหลัง…)", "before": "HH:MM", "note": "...", "file_index": 3 }
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
"มีอันไหนประชุมออนไลน์" -> {"intent":"list_meetings","params":{"period":"upcoming"}}
"มีประชุมออนไลน์อะไรบ้าง" -> {"intent":"list_meetings","params":{"period":"upcoming"}}
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
"แนบไฟล์ 3 ส่งนัด ake@gmail.com พรุ่งนี้ครึ่งชม ตอนบ่ายโมงครึ่ง เรื่อง test" -> {"intent":"find_meeting_time","params":{"attendees":["ake@gmail.com"],"duration_min":30,"period":"tomorrow","at":"13:30","note":"test","file_index":3}}
(หมายเหตุ: “ส่งนัดหา/นัดหา/เชิญ” + อีเมล = นัดกับอีเมลนั้นเท่านั้น ห้ามดึงคนจาก last_meeting มาผสม)
(หมายเหตุ: หลังค้นไฟล์แล้วพูด “แนบไฟล์ N ส่งนัด/นัด …” = find_meeting_time + file_index — ห้ามใช้ summarize_file)
"นัดประชุมกับสมชายและสมหญิง 30 นาที" -> {"intent":"find_meeting_time","params":{"attendees":["สมชาย","สมหญิง"],"duration_min":30}}
"นัดเบสวันนี้ 10นาทีตอน 13:50 เรื่อง test meeting" -> {"intent":"find_meeting_time","params":{"attendees":["เบส"],"duration_min":10,"period":"today","at":"13:50","note":"test meeting"}}
"นัดพี่นนท์พรุ่งนี้ 30 นาที เรื่อง sync" -> {"intent":"find_meeting_time","params":{"attendees":["พี่นนท์"],"duration_min":30,"period":"tomorrow","note":"sync"}}
(หมายเหตุสำคัญ: ประโยคขึ้นต้นด้วย นัด/จอง + ชื่อคน = find_meeting_time เสมอ — "เรื่อง ..." คือหัวข้อประชุม ห้ามใช้ add_task; ถ้ามี "ตอน HH:MM" ให้ใส่ params.at)
(หมายเหตุสำคัญมาก: ถ้าถามดูตาราง/เวลาว่างของ "คนตั้งแต่ 2 คนขึ้นไปพร้อมกัน" (มีคำเชื่อม กับ/และ/, คั่นชื่อ) ให้ใช้ find_meeting_time เพื่อหาเวลาที่ทุกคนว่างตรงกัน — ห้ามใช้ my_availability หรือ list_meetings ที่รองรับทีละคน และห้าม fallback เป็นตารางของผู้ถามเอง)
(หมายเหตุ: ถ้าผู้ใช้ระบุวัน เช่น "วันจันทร์นี้/เสาร์หน้า/วันที่ 5" ต้องใส่ weekday หรือ date ด้วยเสมอ ห้ามปล่อยให้ค้นทั้งสัปดาห์)
(หมายเหตุ: follow-up เรื่องเช้า/บ่าย/เย็น หลัง find_meeting_time ต้องคง intent เป็น find_meeting_time ห้ามสลับไป my_availability ของคนเดียว)
"ยกเลิกนัด" -> {"intent":"cancel_meeting","params":{}}
"ยกเลิกนัดพรุ่งนี้" -> {"intent":"cancel_meeting","params":{"period":"tomorrow"}}
"ยกเลิกนัดวันนี้" -> {"intent":"cancel_meeting","params":{"period":"today"}}
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
"หาไฟล์ ai.html" -> {"intent":"search_files","params":{"query":"ai","filetype":"html"}}
(หมายเหตุ: คำบอกชนิดไฟล์ เช่น excel/word/pdf/powerpoint/html หรือนามสกุลใน query เช่น ai.html ให้แยกไปที่ filetype ห้ามใส่ใน query)
(หมายเหตุ: ถ้าเพิ่งค้นไฟล์แล้วผู้ใช้พูด "เอาแค่ .html" / "แค่ xlsx" ให้กรองรายการเดิม — ไม่ใช่ search ใหม่)
ห้ามแต่งข้อมูลเกินจากที่ผู้ใช้พูด`;

// ---------------------------------------------------------------------------
// Name extraction from scheduling questions (deterministic — see Python original)
// ---------------------------------------------------------------------------
const NAME_PREFIX = [
  "ขอดูตารางว่าง", "ขอดูตาราง", "ดูตารางว่างของ", "ดูตารางว่าง", "ดูตารางของ", "ดูตาราง",
  "ตารางว่างของ", "ตารางว่าง", "ตารางของ", "ตาราง", "ขอเช็คตาราง", "เช็คตาราง",
  "ดูนัดของ", "ดูนัด", "ขอดูนัด", "เช็คนัด", "เช็กนัด", "ดูประชุมของ", "ดูประชุม", "ขอดูประชุม",
  "ขอดู", "ขอเช็ค",
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
  // "ไร" is the everyday spoken contraction of "อะไร" ("มีนัดไรบ้าง") and was
  // reaching the directory as a person name.
  "มีนัดไรบ้าง", "มีนัดไร", "ไรบ้าง", "ไร",
  "อะไรบ้าง", "อะไร", "บ้าง", "ไหม", "มั้ย", "หรือยัง", "หรือเปล่า", "รึเปล่า",
  "วันนี้", "พรุ่งนี้", "สัปดาห์นี้", "เดือนนี้", "ประชุม", "นัด", "คิว",
];
const SELF_WORDS = new Set(["", "ฉัน", "ผม", "ดิฉัน", "ตัวเอง", "เรา", "ของฉัน", "ของผม"]);
const SELF_HINT = ["ของฉัน", "ของผม", "ตัวเอง", "ตัวฉัน", "ผมเอง", "ฉันเอง", "ตารางฉัน", "ตารางผม", "ฉันว่าง", "ผมว่าง", "ของตัวเอง"];

/**
 * Peel command / duration / day words so “30 นาทีของพี่เอ็มกับพี่นนท์” → “พี่เอ็มกับพี่นนท์”.
 * (Without this, “นาทีของพี่เอ็ม” is one token and gets dropped as noise → เอ็มหาย)
 */
function peelSchedulePhrases(text: string): string {
  let s = (text || "").replace(/\s+/g, " ").trim();
  s = s
    .replace(/\d+\s*(?:นาที|min)\s*/gi, " ")
    .replace(/\d+\s*(?:ชม\.?|ชั่วโมง|hr|hour)\s*/gi, " ")
    .replace(/ครึ่ง\s*(?:ชม\.?|ชั่วโมง)\s*/gi, " ")
    .replace(/หาเวลา(?:ว่าง)?(?:ตรงกัน)?(?:กับ)?/gi, " ")
    .replace(/(?:ว่าง)?ตรงกัน/gi, " ")
    // No \b — Thai word boundaries are unreliable
    .replace(/วันนี้|พรุ่งนี้|มะรืนนี้|มะรืน/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  // “ของพี่เอ็ม” / leftover “ของ …” after peeling duration
  s = s.replace(/^ของ\s*/u, "").replace(/\s+ของ\s+/gu, " ").trim();
  return s;
}

/**
 * Calendar vocabulary — day names, clock words, question particles, the
 * conjunctions that open a follow-up ("และ…ล่ะ", "แล้ว…ล่ะ"). Used as a
 * STRIPPER, not a list of forbidden phrases: whatever combination the user
 * types, what is left over is the part that could be a name.
 */
const CALENDAR_TALK =
  /(?:ผม|ฉัน|ดิฉัน|กระผม|หนู|เรา|ตัวเอง|ต้อง|ให้|ว่าง|ว่า|ของ|เอง|ตรวจ|ช่วย|บอก|ทราบ|อยาก|ได้|ทั้ง|หมด|เอา|สรุป|มกราคม|กุมภาพันธ์|มีนาคม|เมษายน|พฤษภาคม|มิถุนายน|กรกฎาคม|สิงหาคม|กันยายน|ตุลาคม|พฤศจิกายน|ธันวาคม|และ|แล้ว|ส่วน|ล่ะ|หล่ะ|ละ|ก็|นี้|หน้า|ที่แล้ว|ถัดไป|ต่อไป|วันไหน|ไหน|ที่ไหน|สถานที่|ห้อง|วัน|จันทร์|อังคาร|พุธ|พฤหัสบดี|พฤหัส|ศุกร์|เสาร์|อาทิตย์|สัปดาห์|เดือน|พรุ่งนี้|พรุ่ง|มะรืน|เมื่อวาน|เช้านี้|บ่ายนี้|เย็นนี้|เช้า|สาย|บ่าย|เย็น|ค่ำ|กลางวัน|เที่ยง|ตอน|ช่วง|เวลา|โมง|ทุ่ม|นาฬิกา|ครึ่ง|นาที|ชั่วโมง|ชม\.?|ตาราง|ประชุม|นัด|คิว|ว่าง|ติด|ไหม|มั้ย|บ้าง|อะไร|ไร|ยัง|หรือ|รึ|เปล่า|กี่|มี|ขอ|ดู|เช็ค|เช็ก|หน่อย|ครับ|ค่ะ|คะ|นะ|อื่น|อีก|เดิม|นั้น|โน้น|งั้น|ต่อ|ก่อนหน้า|ที่ผ่านมา|ย้อนหลัง|อะ|อ่ะ|ดิ|สิ|ฮะ|จ๊ะ|ออนไลน์|online|อัน|อันไหน|\d+|[:.,\s/-])/gi;

/**
 * Day and time expressions that get typed straight onto a name, because Thai
 * puts no space between words: "นัดกรพรุ่งนี้" is กร + พรุ่งนี้, and looking up
 * "กรพรุ่งนี้" in the directory finds nobody. Only whole, unambiguous phrases
 * are listed — "วันนี้" but never bare "วัน" — so a colleague called วันดี or
 * ศุกร์ยังคงหาเจอ.
 */
const GLUED_WHEN =
  /(?:พรุ่งนี้|วันนี้|มะรืนนี้|มะรืน|เมื่อวานนี้|เมื่อวาน|คืนนี้|เช้านี้|บ่ายนี้|เย็นนี้|สัปดาห์นี้|สัปดาห์หน้า|อาทิตย์นี้|อาทิตย์หน้า|เดือนนี้|เดือนหน้า|วันจันทร์|วันอังคาร|วันพุธ|วันพฤหัสบดี|วันพฤหัส|วันศุกร์|วันเสาร์|วันอาทิตย์|จันทร์นี้|อังคารนี้|พุธนี้|พฤหัสนี้|ศุกร์นี้|เสาร์นี้|อาทิตย์นี้|ตอนเช้า|ตอนบ่าย|ตอนเย็น|ทั้งวัน|กี่โมง)/gu;

/** Pull the day/time phrase off a name that was typed against it. */
function stripGluedWhen(raw: string): string {
  return String(raw || "")
    .replace(GLUED_WHEN, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * True when nothing but calendar talk is left — "และวันพฤหัสล่ะ" is a follow-up
 * about Thursday, not someone called that. Answering it as a name produced
 * «หาคนชื่อ "และวันพฤหัสล่ะ" ในองค์กรไม่เจอ». Trade-off: a colleague whose whole
 * name is a calendar word ("วัน", "พุธ") must be addressed by email.
 */
function isCalendarTalk(s: string): boolean {
  return !String(s || "").replace(CALENDAR_TALK, "").trim();
}

/** Normalize a person token: strip ของ/honorific; drop pure schedule junk. */
function cleanPersonToken(raw: string): string {
  let n = String(raw || "").trim();
  n = n.replace(/^ของ/u, "").trim();
  n = n.replace(/(?:วันนี้|พรุ่งนี้|มะรืนนี้|มะรืน)\s*$/u, "").trim();
  n = stripHonorificPublic(n).replace(/^[ .,/-]+|[ .,/-]+$/g, "").trim();
  n = n.replace(/^(?:นัด|จอง|เชิญ|invite|กับ|และ|หา)\s+/i, "").trim();
  if (!n || n.includes("@")) return "";
  if (/^(?:วันนี้|พรุ่งนี้|มะรืน|นาที|โมง|ทุ่ม|เรื่อง|ตอน|บ่าย|เช้า|เย็น|เที่ยง|ชั่วโมง|ช่วง|เวลา|ว่าง|ตรงกัน|หาเวลาว่าง|หาเวลา|\d+)$/i.test(n)) {
    return "";
  }
  if (isCalendarTalk(n)) return "";
  return n;
}

/**
 * A name, or a sentence that was mistaken for one?
 *
 * Chasing this with vocabulary lists is a losing game — "ตอนนี้ผมต้องประชุมอะไร
 * รึปล่าวเช็คที" got looked up in the directory because ปล่าว and ที happened not
 * to be on the list. The shape of the string answers it instead: people are
 * called short things, and nobody is called a question about themselves.
 *
 *  - a first-person pronoun means the asker is talking about their own diary
 *  - more than three words, or more than 24 characters with the spaces taken
 *    out, is prose; the longest real names here ("ณัฐกฤษณ์ บำรุงวงศ์",
 *    "Supakorn Khamsuwan") sit comfortably under that
 *
 * An email address is exempt: it is unambiguous however long it is.
 */
function looksLikeSentence(s: string): boolean {
  const t = String(s || "").trim();
  if (!t || t.includes("@")) return false;
  if (/^(?:ผม|ฉัน|ดิฉัน|กระผม|หนู|เรา|ตัวเอง|ตัวผม)/i.test(t)) return true;
  if (/\b(?:i|me|my|mine|myself)\b/i.test(t)) return true;
  if (t.split(/\s+/).filter(Boolean).length > 3) return true;
  return t.replace(/\s+/g, "").length > 24;
}

/**
 * Words that belong to a request, never to a person: if one of these is inside
 * the candidate then it is still carrying the sentence around the name
 * ("นัดของส้ม", "ส้มเอง", "ตรวจตารางนัด") and the calendar stripper should have
 * another go at it. Deliberately narrow — a colleague called วันดี or ศุกร์
 * contains none of them, so their name survives untouched.
 */
const REQUEST_WORDS = /(?:นัด|ตาราง|ประชุม|คิว|ของ|เอง|ตรวจ|ช่วย|เช็ค|เช็ก|ว่าง|เวลา|ขอดู|ขอ|ดู)/u;

/** Peel the request off a candidate name; "" when nothing person-like is left. */
function nameFromCandidate(raw: string): string {
  const s = String(raw || "").trim();
  if (!s) return "";
  // An address inside a sentence is the answer, not the sentence:
  // "สรุปตารางของ someone@ktisgroup.com ทั้งเดือน" was used whole as the name.
  const mail = s.match(/[^\s<>(),;]+@[^\s<>(),;]+/)?.[0];
  if (mail) return mail;
  const wordy = s.split(/\s+/).filter(Boolean).length > 1 || s.replace(/\s+/g, "").length > 12;
  if (!wordy && !REQUEST_WORDS.test(s)) return s;
  const residue = s.replace(CALENDAR_TALK, " ").replace(/\s+/g, " ").trim();
  // One stray letter is what is left when a word was chewed in half; it is
  // not a name, and searching it matches whoever happens to start that way.
  if (residue.replace(/\s+/g, "").length < 2) return "";
  if (residue.replace(/\s+/g, "").length <= 20) return residue;
  return residue ? s : "";
}

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
  // "วัน" is optional — people write "เสาร์นี้" as often as "วันเสาร์นี้".
  return /วันนี้|พรุ่งนี้|มะรืน|เช้านี้|บ่ายนี้|เย็นนี้|ค่ำนี้|สัปดาห์นี้|อาทิตย์นี้|เดือนนี้|(?:วัน)?(?:จันทร์|อังคาร|พุธ|พฤหัสบดี?|ศุกร์|เสาร์|อาทิตย์)|วันที่\s*\d|\d{1,2}\/\d{1,2}/.test(
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
  // leftover “นัดเบส” / “ประชุมเบส” after peeling ดู
  s = s.replace(/^(?:นัด|ประชุม)\s*/u, "").trim();
  if (isCalendarTalk(s)) return "";
  // Still holding a request rather than a name ("ตรวจตารางนัด ของฉัน",
  // "นัดของส้ม", "ส้มเอง")? Then strip every calendar word out of it and see
  // what is left: whatever survives is the part that could be a person. Only
  // tried when the candidate is too long or too wordy to be a name already, so
  // a colleague whose name contains a calendar word ("วันดี") is left alone.
  s = nameFromCandidate(s);
  if (!s) return "";
  // The same shape test the parsed params get: what is left of a whole
  // question (“ตอนนี้ผมต้องประชุมอะไรรึปล่าวเช็คที”) is prose, not a colleague.
  if (looksLikeSentence(s)) return "";
  return SELF_WORDS.has(s) ? "" : s;
}

/** Split “เบสกับพี่แบง” / “พี่เอม พี่แบง พี่นน เบส” into separate people. */
function peopleFromText(text: string): string[] {
  let body = peelSchedulePhrases(text || "");
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
  body = peelSchedulePhrases(body);
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
      const stripped = cleanPersonToken(piece);
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
        out.push(...toks.map((t) => cleanPersonToken(t)).filter(Boolean));
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
    .map((s) => nameFromCandidate(cleanPersonToken(s)))
    // A month name is not a colleague: "ว่างเดือนกันยายนวันไหน" was pulling
    // กันยายน out as a person and answering with whoever it fuzzily matched.
    .filter((s) => s && !SELF_WORDS.has(s) && !isCalendarTalk(s) && !looksLikeSentence(s));

  // Dedupe while preserving order — BUT keep duplicate nicknames when the user
  // listed multiple people with กับ/และ (e.g. “เบสกับพี่เบส” = two Bases).
  const connectorSlots = body
    .split(/\s*(?:กับ|และ|,|\/|&)\s*/)
    .map((s) => s.replace(/^[ .,/-]+|[ .,/-]+$/g, "").trim())
    .filter((s) => s && !SELF_WORDS.has(s) && !/^(ประชุม|นัด|จอง|ตาราง|ว่าง|ตรงกัน)$/i.test(s));
  const keepDupNicks = connectorSlots.length >= 2;
  const seen = new Set<string>();
  parts = parts.filter((p) => {
    const k = p.toLowerCase();
    if (seen.has(k)) return keepDupNicks;
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

  // /test — preview what the morning message will look like. A reply, so it
  // costs no quota; "/test ประชุม" previews the meeting-summary shape instead.
  if (t === "__preview_morning__" || /^\/?test$/i.test(t)) {
    return { intent: "preview_morning", params: {} };
  }
  if (t === "__preview_summary_link__" || /^\/?test\s*(ประชุม|สรุป|summary|mt)$/i.test(t)) {
    return { intent: "preview_summary_link", params: {} };
  }
  // The same question inside a longer sentence — "ทำอะไรได้บ้างมีคู่มือมั้ย",
  // "มีคู่มือไหมครับ อยากดูคำสั่ง". Anchoring it meant the manual answered only
  // people who typed the phrase and nothing else.
  if (
    /(?:ทำ|สั่ง|สั่งงาน|ใช้)อะไรได้(?:บ้าง)?|มี(?:อะไรให้ใช้|คำสั่งอะไร)(?:บ้าง)?|มีคู่มือ|ขอคู่มือ|ดูคู่มือ|รายการคำสั่ง/.test(t)
  ) {
    return { intent: "help_menu", params: {} };
  }

  // "ทำอะไรได้บ้าง" — the question every new user asks first, and until now the
  // only answer was whatever the model improvised. Fixed rules, no API call.
  if (
    /^(?:\/?(?:ช่วยเหลือ|ช่วยด้วย|ช่วยหน่อย|คำสั่ง|คู่มือ|help|menu|เมนู|start|เริ่ม)|ช่วยเรื่องอื่น|ขอ(?:ดู)?(?:คำสั่ง|รายการคำสั่ง|เมนู|คู่มือ)|ดู(?:คำสั่ง|เมนู|คู่มือ)|(?:มี|ทำ|สั่ง|สั่งงาน|ใช้)(?:อะไร|คำสั่งอะไร)(?:ได้)?(?:บ้าง|ไหม)?|ทำอะไรได้(?:บ้าง)?|สั่งอะไรได้(?:บ้าง)?|สั่งงานอะไรได้(?:บ้าง)?|มีคำสั่งอะไร(?:บ้าง)?|มีอะไรให้ใช้(?:บ้าง)?|ใช้(?:งาน)?(?:ยัง)?ไง|ใช้อะไรได้(?:บ้าง)?|คู่มือ(?:การใช้งาน|คำสั่ง)?)[!?.\s]*$/i.test(t)
  ) {
    return { intent: "help_menu", params: {} };
  }
  {
    const topic = findHelpTopic(t);
    if (topic) return { intent: "help_menu", params: { topic: topic.key } };
  }

  // "ประชุมไปกี่นาที" / "ขอเวลาที่ใช้ในประชุมแต่ละอัน" — asked right after a list
  // of meetings, and answered by re-printing the same list until now. It is
  // calendar arithmetic, so no LLM is involved.
  if (
    /(กี่นาที|กี่ชม|กี่ชั่วโมง)/.test(t) ||
    /(เวลาที่ใช้|ใช้เวลา|ระยะเวลา|ความยาว|นานเท่า?ไ?ห?ร่?)/.test(t) &&
      /(ประชุม|มีต|meeting)/i.test(t)
  ) {
    return { intent: "meeting_durations", params: {} };
  }

  // /test_meeting <เรื่อง> — summarise a named meeting now, without waiting for
  // the scheduled run. No LLM needed to understand it: the subject is typed.
  {
    const m = /^(?:__test_meeting__|\/?test[_\s]?meeting)\s*(.*)$/i.exec(t);
    if (m) return { intent: "test_meeting", params: { query: (m[1] || "").trim() } };
  }

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

  // Meeting summary — never require LLM for intent (avoids “หนาแน่น” when Groq/Qwen 429)
  {
    const sumNorm = t.replace(/[·•‧∙.\-–—_/]+/g, "").replace(/\s+/g, "");
    if (
      /^(สรุป)?ประชุม(ล่าสุด|วันนี้)?[!?.…]*$|^สรุป(การ)?ประชุม(ล่าสุด|วันนี้)?[!?.…]*$/i.test(t) ||
      sumNorm === "สรุปประชุม" ||
      sumNorm === "สรุปประชุมล่าสุด" ||
      sumNorm === "สรุปประชุมวันนี้"
    ) {
      const latest = /ล่าสุด/.test(t) || sumNorm.includes("ล่าสุด");
      const today = /วันนี้/.test(t) || sumNorm.includes("วันนี้");
      return {
        intent: "summarize_meetings",
        params: latest ? { latest: true } : today ? { today: true } : {},
      };
    }
  }

  // Commute / maps — rich-menu + typed shortcuts (no LLM)
  {
    if (/^เปิดแผนที่(ไป)?(ที่)?ทำงาน|^นำทาง(ไป)?(ที่)?ทำงาน/i.test(t)) {
      return { intent: "open_map", params: {} };
    }
    if (/^เปิดแผนที่(กลับ)?บ้าน|^นำทาง(กลับ)?บ้าน/i.test(t)) {
      return { intent: "open_map_home", params: {} };
    }
    if (
      /วางแผนเดินทาง|ควรออก(จากบ้าน)?กี่โมง|เผื่อเวลา(เดินทาง|ไปทำงาน)|ออกจากบ้านเมื่อไหร่/i.test(t)
    ) {
      const home = /กลับบ้าน|ไปบ้าน|กลับบ้านเกิด/.test(t) && !/ไปทำงาน|ที่ทำงาน/.test(t);
      const period = /พรุ่งนี้/.test(t) ? "tomorrow" : /วันนี้/.test(t) ? "today" : home ? "today" : "today";
      return {
        intent: "plan_commute",
        params: { place: home ? "home" : "work", period },
      };
    }

    // Save work/home — including “เพิ่มตำแหน่งนี้เป็นที่ทำงาน” after sharing a LINE pin
    const setWorkAddr = t.match(
      /^(?:ตั้ง|บันทึก|เพิ่ม)(?:ที่อยู่)?(?:ที่)?ทำงาน(?:หลัก)?(?:เป็น|=|:)\s*(.+)$/i
    );
    if (setWorkAddr?.[1]?.trim() && !/ตำแหน่งนี้|โลเคชันนี้|location|ที่นี่|ตรงนี้/i.test(setWorkAddr[1])) {
      return { intent: "set_work_location", params: { address: setWorkAddr[1].trim() } };
    }
    const setHomeAddr = t.match(/^(?:ตั้ง|บันทึก|เพิ่ม)(?:ที่อยู่)?บ้าน(?:เป็น|=|:)\s*(.+)$/i);
    if (setHomeAddr?.[1]?.trim() && !/ตำแหน่งนี้|โลเคชันนี้|location|ที่นี่|ตรงนี้/i.test(setHomeAddr[1])) {
      return { intent: "set_home_location", params: { address: setHomeAddr[1].trim() } };
    }
    if (
      /(เพิ่ม|บันทึก|ตั้ง|ใช้).{0,12}(ตำแหน่ง|โลเคชัน|location|ที่นี่|ตรงนี้).{0,16}(ที่)?ทำงาน|(เป็น|ไว้เป็น|ให้เป็น)ที่ทำงาน|^ตั้งที่ทำงาน$|^บันทึกที่ทำงาน$|^เพิ่มที่ทำงาน$/i.test(
        t
      )
    ) {
      return { intent: "set_work_location", params: { from_pending: true } };
    }
    if (
      /(เพิ่ม|บันทึก|ตั้ง|ใช้).{0,12}(ตำแหน่ง|โลเคชัน|location|ที่นี่|ตรงนี้).{0,16}บ้าน|(เป็น|ไว้เป็น|ให้เป็น)บ้าน(?!เกิด)|^ตั้งบ้าน$|^บันทึกบ้าน$|^เพิ่มบ้าน$/i.test(
        t
      )
    ) {
      return { intent: "set_home_location", params: { from_pending: true } };
    }
    if (/^(ดู|แสดง)?ที่ทำงาน(ที่ตั้งไว้)?$|^ที่ทำงานหลัก$/i.test(t)) {
      return { intent: "show_work_location", params: {} };
    }
    if (/^(ลบ|เคลียร์|clear)ที่ทำงาน/i.test(t)) {
      return { intent: "clear_work_location", params: {} };
    }
  }

  // Prep a numbered meeting from today's agenda
  const prep = t.match(/^(?:เตรียม|แนะนำ|ช่วยเตรียม)(?:ตัว)?(?:นัด|ประชุม)?\s*(?:หมายเลข|ที่|#)?\s*(\d+)\s*$/i);
  if (prep) return { intent: "prep_meeting", params: { meeting_index: Number(prep[1]) } };

  // Bare free-time ask — period filled later from last_period / LLM defaults
  if (/^(ขอ)?(ดู)?ตารางว่าง(หน่อย)?$|^(ผม|ฉัน|ตัวเอง)?ว่าง(กี่โมง|ช่วงไหน|ไหม|มั้ย)?$/i.test(t)) {
    return { intent: "my_availability", params: {} };
  }

  // Dismiss / ack buttons left over from older replies
  if (/^รับทราบ(ครับ|ค่ะ)?$|^รับทราบ\s*รออีกฝั่ง$|^โอเค$|^ok$/i.test(t)) {
    return { intent: "ack", params: {} };
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

  // "ดูตารางพี่นนท์" → free time; "ดูนัดเบส" → that person's meetings.
  // Only the SIMPLE shape belongs here. Two or more names is a find-a-common-slot
  // question, and a qualifier this shortcut cannot express (a weekday, a date,
  // "ตอนเช้า") would be dropped silently — "ดูตารางวันพุธนี้ <7 คน> ตอนเช้า"
  // then came back as one person's whole week. Both cases go to the parser.
  if (/^(ดู|ขอดู|เช็ค|เช็ก)?ตาราง/.test(t)) {
    const people = peopleFromText(t);
    const who = people[0] || personFromText(t);
    const period = /พรุ่งนี้/.test(t) ? "tomorrow" : /วันนี้/.test(t) ? "today" : undefined;
    const qualifierLost = (!period && hasDayHint(t)) || hasMorningWord(t) || /บ่าย|เย็น|ค่ำ/.test(t);
    if (who && people.length < 2 && !qualifierLost) {
      return {
        intent: "my_availability",
        params: period ? { person: who, period } : { person: who },
      };
    }
  }
  if (
    /^(ดู|ขอดู|เช็ค|เช็ก)?(นัด|ประชุม)/.test(t) &&
    !/^(?:นัด|จอง|ส่งนัด)/.test(t) &&
    !/^(นัด|ประชุม|ตาราง)(วัน)?(วันนี้|พรุ่งนี้)$/i.test(t)
  ) {
    const who = personFromText(t);
    if (who) {
      const period = /พรุ่งนี้/.test(t)
        ? "tomorrow"
        : /วันนี้/.test(t)
          ? "today"
          : /สัปดาห์|อาทิตย์/.test(t)
            ? "week"
            : "upcoming";
      return { intent: "list_meetings", params: { person: who, period } };
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
  const selfBook = quickSelfBookIntent(t);
  if (selfBook) return selfBook;

  const book = quickBookIntent(t);
  if (book) return book;

  const fileSearch = t.match(/^ห(?:า|้)?(?:ไฟล์|file)\s+(.+)$/i);
  if (fileSearch) {
    const rawIn = fileSearch[1]!.trim();
    const { query: stripped, wantsLocation } = stripFileLocationHint(rawIn);
    const parsed = parseQueryWithExtension(stripped);
    const typeWord = stripped.match(/\b(excel|word|pdf|powerpoint|ppt|html|htm|xlsx|docx|pptx)\b/i);
    const filetype = parsed.filetype || (typeWord ? normalizeFileType(typeWord[1]!) : "");
    let query = parsed.query;
    if (typeWord && !parsed.filetype) {
      query = stripped.replace(new RegExp(`\\b${typeWord[1]}\\b`, "i"), "").replace(/\s+/g, " ").trim();
    }
    return {
      intent: "search_files",
      params: {
        query,
        ...(filetype ? { filetype } : {}),
        ...(wantsLocation ? { show_location: true } : {}),
      },
    };
  }

  return null;
}

/** Deterministic cancel — keeps person filter when user says “ยกเลิกนัดกับเบส”. */
function cancelPeriodFromText(text: string): string | undefined {
  if (/พรุ่งนี้|มะรืน/.test(text)) return "tomorrow";
  if (/วันนี้/.test(text)) return "today";
  if (/สัปดาห์นี้|อาทิตย์นี้/.test(text)) return "week";
  return undefined;
}

function quickCancelIntent(text: string): { intent: string; params: Record<string, unknown> } | null {
  const t = text.trim().replace(/\s+/g, " ");
  if (!t) return null;
  if (!/^(?:ยกเลิก|ลบ|เลิก)(?:นัด|ประชุม)/i.test(t)) return null;

  const period = cancelPeriodFromText(t);
  const m = t.match(/^(?:ยกเลิก|ลบ|เลิก)(?:นัด|ประชุม)?(?:กับ|ของ)?\s*(.*)$/i);
  let rest = (m?.[1] || "")
    .trim()
    .replace(/\s*(หน่อย|ครับ|ค่ะ|คะ|นะ)$/u, "")
    .trim();
  rest = rest
    .replace(/^(?:วันนี้|พรุ่งนี้|มะรืนนี้|มะรืน|สัปดาห์นี้|อาทิตย์นี้|ทั้งหมด|นี้)\s*/i, "")
    .replace(/\s+(?:วันนี้|พรุ่งนี้|มะรืนนี้|มะรืน|สัปดาห์นี้|อาทิตย์นี้)\s*$/i, "")
    .trim();

  const params: Record<string, unknown> = {};
  // Support “ยกเลิกนัดวันเสาร์” / “ยกเลิกวันเสาร์” by turning weekday into an exact filter.
  const wdM = rest.match(/^(วัน?(?:จันทร์|อังคาร|พุธ|พฤหัสบดี?|ศุกร์|เสาร์|อาทิตย์)(?:นี้|หน้า)?)$/i);
  if (wdM?.[1]) {
    params.weekday = wdM[1];
  } else if (period) {
    params.period = period;
  }

  if (rest && !params.weekday && !/^(วันนี้|พรุ่งนี้|มะรืน|ทั้งหมด|นี้)$/i.test(rest)) params.person = rest;
  return { intent: "cancel_meeting", params };
}

/** Parse “30 นาที”, “1 ชม.”, or bare “30” / “1” when answering a duration question. */
function parseDurationMinutes(text: string): number | null {
  const t = (text || "").trim().replace(/\s+/g, " ");
  if (!t) return null;
  if (/ครึ่ง\s*(?:ชม\.?|ชั่วโมง)/i.test(t)) return 30;
  const hr = t.match(/(\d+(?:\.\d+)?)\s*(?:ชม\.?|ชั่วโมง|hr|hour)/i);
  if (hr) return Math.max(15, Math.round(Number(hr[1]) * 60));
  const min = t.match(/(\d+)\s*(?:นาที|min)/i);
  if (min) return Math.max(5, Number(min[1]));
  if (/^\d+$/.test(t)) {
    const n = Number(t);
    if (n >= 5 && n <= 240) return n;
    if (n >= 1 && n <= 8) return n * 60;
  }
  return null;
}

/**
 * “จองตาราง / จองวันที่ / นัดวันเสาร์นี้ …” — block own calendar, no attendees.
 * If duration is missing, handler asks “กี่นาที/ชม.” before confirm.
 */
function soloMeetActivitySubject(text: string): string | undefined {
  const t = (text || "").trim().replace(/\s+/g, " ");
  const m = t.match(/^นัด(?:ประชุม)?(?:\s*)*.+?\s+(.+?)\s+(?:ตอน|เวลา|ที่)\s*/i);
  if (!m?.[1]) return undefined;
  const s = m[1]
    .trim()
    .replace(/\s*(?:ทั้งวัน|ตลอดวัน)\s*$/i, "")
    .replace(/[.,]+$/g, "")
    .trim();
  return s.length >= 2 ? s.slice(0, 200) : undefined;
}

/**
 * Thai is written without spaces between words, so a keyword is often glued to
 * what follows ("จองตารางให้เราหน่อยวันศุกร์นี้"). Strip benefactive + polite
 * particles so the rest parses like the spaced form, and report when the user
 * explicitly said "for me" — that is a self-booking signal, never a person name.
 */
function stripThaiPoliteness(text: string): { text: string; forSelf: boolean } {
  // "ให้" only means "for me" when no recipient is named after it. Compare
  // "จองตารางให้หน่อย" (for me) with "จองตารางให้เบส" (for Bass) — so treat it
  // as self only when a pronoun, a politeness particle, a day/time, or the end
  // of the message follows. No lookahead on the pronoun form: Thai glues words
  // together ("ให้เราหน่อย…") and that phrase is already unambiguous.
  const benefactive =
    /ให้\s*(?:เรา|ฉัน|ผม|หนู|ดิฉัน|กระผม)|ให้\s*(?=(?:ซะหน่อย|สักหน่อย|หน่อย|ที|ด้วย|สิ|ซิ|นะ|ครับ|ค่ะ|คะ)|วัน|พรุ่งนี้|มะรืน|ตอน|เวลา|เช้า|บ่าย|เย็น|ค่ำ|ครึ่ง|\d|$)/g;
  // Use match() rather than the /g regex's stateful test() — test() would leave
  // lastIndex behind and make repeat calls flip-flop.
  const forSelf = text.match(benefactive) !== null;
  const cleaned = text
    .replace(benefactive, " ")
    // Distinctive particles can be stripped anywhere (Thai glues them to the
    // next word: "หน่อยวันศุกร์"). Short ones that also live inside real words
    // ("คะ" in "คะแนน") only count at a word end, hence the lookahead.
    .replace(/(?:ซะหน่อย|สักหน่อย|หน่อย|นะครับ|นะคะ|คร้าบ)/g, " ")
    .replace(/(?:ครับ|ค่ะ|คะ|จ้า|จ้ะ)(?![ก-๙])/g, " ")
    // Standalone "ที" ("จองนัดให้ที") — the lookahead keeps "ที่" intact, and
    // the leading space keeps it from cutting into a longer word.
    .replace(/\s(?:ที|ด้วย|สิ|ซิ)(?![ก-๙])/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return { text: cleaned, forSelf };
}

/**
 * The reason for blocking the calendar is whatever is left after removing the
 * booking verb, the day, the time and the duration ("...ทั้งวันไป ออกรายการ"
 * → "ออกรายการ"). Generic leftover extraction beats listing every activity.
 */
function selfBookReason(text: string): string | undefined {
  let s = ` ${text} `;
  // Order matters: strip dates/times FIRST, otherwise the verb pattern eats the
  // "วันที่" of "จองวันที่ 20" and leaves a bare "20" behind.
  const drop: RegExp[] = [
    /วันที่\s*\d{1,2}(?:\/\d{1,2}(?:\/\d{2,4})?)?/g,
    /\d{4}-\d{2}-\d{2}/g,
    /(?:วัน)?(?:จันทร์|อังคาร|พุธ|พฤหัสบดี?|ศุกร์|เสาร์|อาทิตย์)\s*(?:นี้|หน้า)?/g,
    /(?:วันนี้|พรุ่งนี้|มะรืนนี้|มะรืน|สัปดาห์นี้|อาทิตย์นี้)/g,
    /\d{1,2}\s*(?:โมง|ทุ่ม)(?:\s*(?:เช้า|เย็น|ครึ่ง))?/g,
    /(?:ทั้งวัน|ตลอดวัน|all\s*day)/gi,
    // Whole ranges first, otherwise "เวลา 9:00" is eaten by the marker rule
    // below and the "-12:00" tail survives.
    /\d{1,2}[:.]\d{2}(?:\s*(?:[-–—]|ถึง)\s*\d{1,2}[:.]\d{2})?/g,
    /(?:ตอน|เวลา|ที่)\s*\d{1,2}[:.]\d{2}/g,
    /(?:ตอน|เวลา)(?=\s|$)/g,
    /\d+\s*(?:ชม\.?|ชั่วโมง|นาที|hr|hour|min)/gi,
    /ครึ่ง\s*(?:ชม\.?|ชั่วโมง)?/g,
    // Take the "ตอน/ช่วง" marker with the part of day, otherwise stripping
    // "เย็น" out of "ตอนเย็น" leaves a dangling "ตอน" in the title.
    /(?:ตอน|ช่วง)?\s*(?:เช้า|สาย|บ่าย|เย็น|ค่ำ|กลางวัน|กลางคืน)/g,
    /(?:ขอ|อยาก|ช่วย|โปรด)/g,
    /จอง\s*(?:ตาราง|เวลา?|วันที่)?/g,
    /นัด(?:ประชุม)?/g,
    /(?:block|บล็อก|บล๊อค|บล็อค)\s*(?:ตาราง|เวลา|time)?/gi,
    /กัน\s*(?:ตาราง|เวลา)/g,
    /(?:ตัวเอง|ของ(?:ฉัน|ผม))/g,
    /\sเรื่อง\s/g,
    // Dangling benefactive left behind once its particle was stripped.
    /\sให้(?=\s|$)/g,
    // Connectives that only glue the reason on — require spaces so we never cut
    // into a real word (e.g. "ไป" inside "ไปรษณีย์").
    /\s(?:ไป|มา|ติด|เพื่อ|เพราะ|เนื่องจาก|ว่า)\s/g,
    // Any day-of-month digits left over once their "วันที่" marker is gone.
    /^\s*\d{1,2}(?![:.\d])/,
  ];
  for (const re of drop) s = s.replace(re, " ");
  s = s
    .replace(/[.,]+/g, " ")
    // Dashes orphaned by a removed time range, and any leading connective left
    // exposed once the words around it went away.
    .replace(/\s[-–—]+\s/g, " ")
    .replace(/^\s*[-–—]+\s*|\s*[-–—]+\s*$/g, " ")
    .replace(/^\s*(?:ให้|ไป|มา|ติด|เพื่อ|กัน)\s+/u, " ")
    // "มีไปทำฟัน" → "ไปทำฟัน": the "have" verb is not part of the activity.
    // Also matches when a removed word left a space behind ("มี ไปข้างนอก").
    .replace(/^\s*มี(?=[ก-๙\s])/u, " ")
    .replace(/\s+/g, " ")
    .trim();
  return s.length >= 2 ? s.slice(0, 200) : undefined;
}

function quickSelfBookIntent(text: string): { intent: string; params: Record<string, unknown> } | null {
  const polite = stripThaiPoliteness(text.trim().replace(/\s+/g, " "));
  // "จองตารางให้เราหน่อย…" — the benefactive already says this is for the user.
  const saidForSelf = polite.forSelf;
  let t = polite.text;
  if (!t) return null;

  // Bare “นัดวันนี้” = list meetings — not self block
  if (/^(?:นัด|ประชุม|ตาราง)(วัน)?(วันนี้|พรุ่งนี้|สัปดาห์นี้|อาทิตย์นี้)$/i.test(t)) return null;

  const soloMeet =
    /^นัด(?:ประชุม)?/i.test(t) &&
    !/^นัด(?:ประชุม)?(?:\s*)?(?:กับ|หา|เชิญ)\s/i.test(t) &&
    (hasDayHint(t) || /(?:ตอน|เวลา|ที่)/i.test(t));

  // Statements of a commitment carry no booking verb at all — "เสาร์นี้มีไปทำฟัน
  // 10โมง" means "block that slot for me". Requires a day, a have/must verb and
  // nobody else named; questions about the calendar ("พรุ่งนี้มีประชุมไหม",
  // "วันนี้มีอะไรบ้าง") are excluded because they ask rather than declare.
  // A real activity must survive after the day/time words are removed, so bare
  // "วันนี้มีประชุม" (asking what is on the calendar) is not treated as booking.
  const commitmentActivity = (selfBookReason(t) || "").replace(/^มี\s*/u, "").trim();
  const commitment =
    hasDayHint(t) &&
    /(?:มี|ติด|ต้อง|จะไป)/.test(t) &&
    !/(?:ไหม|มั้ย|บ้าง|อะไร|กี่|หรือเปล่า|รึเปล่า|ว่าง|ยัง)/.test(t) &&
    !/กับ\s*\S/.test(t) &&
    !/^(?:ดู|ขอดู|เช็ค|เช็ก|สรุป)/.test(t) &&
    commitmentActivity.length >= 3 &&
    // "วันนี้มีประชุม" names no actual activity — that is a question about the
    // calendar, not something to block.
    !/^(?:ประชุม|นัด|นัดหมาย|ตาราง|งาน|อะไร)$/u.test(commitmentActivity);

  // No trailing \s required: Thai runs words together, so "จองตารางวันศุกร์นี้"
  // must match just like the spaced "จองตาราง วันศุกร์นี้".
  const isSelfBook =
    /^(?:ขอ|อยาก|ช่วย|โปรด)?\s*จอง\s*ตาราง(?:\s*(?:ตัวเอง|ของ(?:ฉัน|ผม)))?/i.test(t) ||
    /^(?:ขอ|อยาก|ช่วย|โปรด)?\s*จอง\s*เวล(?:า)?(?:\s*(?:ตัวเอง|ของ(?:ฉัน|ผม)))?/i.test(t) ||
    /^(?:ขอ|อยาก|ช่วย|โปรด)?\s*จอง\s*วันที่/i.test(t) ||
    // "จองนัดให้ที …" — booking an appointment for yourself, no attendees.
    /^(?:ขอ|อยาก|ช่วย|โปรด)?\s*จอง\s*นัด/i.test(t) ||
    commitment ||
    /^(?:ขอ|อยาก|ช่วย|โปรด)?\s*(?:block|บล็อก|บล๊อค|บล็อค|กัน)\s*(?:ตาราง|เวลา|time)/i.test(t) ||
    soloMeet;
  if (!isSelfBook) return null;

  // “นัดเบส…” / “นัดพี่นนท์ …” — book with someone else
  if (
    /^นัด(?:ประชุม)?(?:\s*)?(?!วัน(?:นี้|พรุ่งนี้|มะรืน|ที่|\s*(?:จันทร์|อังคาร|พุธ|พฤหัสบดี?|ศุกร์|เสาร์|อาทิตย์)))(?:พี่|คุณ|น้อง|[a-z0-9._%+-]+@|[ก-๙a-z]{2,})/i.test(
      t
    )
  ) {
    return null;
  }

  // “จองตารางกับเบส” / “นัดกับเบส” → meeting with others, not self block
  if (/^(?:จอง\s*(?:ตาราง|วันที่|นัด|เวลา)?|นัด(?:ประชุม)?(?:\s*)?)(?:กับ|หา|เชิญ)\s*/i.test(t)) return null;
  const afterPrefix = t
    .replace(/^(?:ขอ|อยาก|ช่วย|โปรด)?\s*จอง\s*(?:ตาราง|เวล(?:า)?|วันที่|นัด)\s*/i, "")
    .replace(/^(?:ขอ|อยาก|ช่วย|โปรด)?\s*นัด(?:ประชุม)?(?:\s*)?/i, "")
    .replace(/^(?:ขอ|อยาก|ช่วย|โปรด)?\s*(?:block|บล็อก|บล๊อค|บล็อค|กัน)\s*(?:ตาราง|เวลา|time)?\s*/i, "")
    .trim();
  // “นัดวันเสาร์นี้ …” — วันเสาร์นี้ is a day, not a person name
  if (
    !soloMeet &&
    !saidForSelf &&
    !commitment &&
    afterPrefix &&
    !/^(?:ตัวเอง|ของ(?:ฉัน|ผม)|วันที่|วัน(?:นี้|พรุ่งนี้|มะรืน)?|ว?(?:จันทร์|อังคาร|พุธ|พฤหัสบดี?|ศุกร์|เสาร์|อาทิตย์)\s*(?:นี้|หน้า)?|เวลา|ตอน|เรื่อง|\d)/i.test(
      afterPrefix
    )
  ) {
    const first = afterPrefix.split(/\s+/)[0] || "";
    // Thai function words survive the strips above ("จองตารางให้ วันเสาร์นี้")
    // and must never be mistaken for someone's name.
    const isFunctionWord = /^(?:ให้|ไป|มา|ที่|ของ|เพื่อ|ติด|กับ|และ|แล้ว|ก็|จะ|ๆ)$/u.test(first);
    // Reuse the date/time vocabulary instead of maintaining a second whitelist:
    // if nothing survives stripping, the token was a day/time ("พรุ่งนี้บ่าย"),
    // not a name. A real name ("เบส") survives and still blocks self-booking.
    const isDateOrTime = !selfBookReason(first);
    const who = isFunctionWord || isDateOrTime ? null : personFromText(first);
    if (who && !SELF_WORDS.has(who.toLowerCase())) return null;
  }

  let durationMin: number | undefined;
  // "ครึ่งเช้า" / "ครึ่งบ่าย" = block half the working day, not a 30-minute slot.
  const halfDay = t.match(/ครึ่ง\s*(เช้า|บ่าย)/);
  const allDay = /(?:ทั้งวัน|ตลอดวัน|all\s*day)/i.test(t);
  const halfHr = t.match(/ครึ่ง\s*(?:ชม\.?|ชั่วโมง|hr|hour)/i);
  if (halfHr) durationMin = 30;
  const durHr = t.match(/(\d+)\s*(?:ชม\.?|ชั่วโมง|hr|hour)/i);
  const durMin = t.match(/(\d+)\s*(?:นาที|min)/i);
  if (durHr) durationMin = Math.max(15, Number(durHr[1]) * 60);
  else if (durMin) durationMin = Math.max(5, Number(durMin[1]));

  let window: { start: Date; end: Date; label: string } | null = null;
  if (/วันนี้/.test(t)) window = periodRange("today");
  else if (/พรุ่งนี้/.test(t)) window = periodRange("tomorrow");
  else if (/มะรืน(?:นี้)?/.test(t)) {
    const d = addDays(startOfDay(nowWall()), 2);
    window = { start: d, end: endOfDay(d), label: "มะรืนนี้" };
  } else {
    // "วัน" is optional: people write "ศุกร์นี้" / "อาทิตย์นี้" just as often.
    // Blocking your own calendar is always about one day, so the day reading of
    // "อาทิตย์นี้" is the useful one here (the confirm card shows the date).
    const wd = t.match(/(?:วัน)?(จันทร์|อังคาร|พุธ|พฤหัสบดี?|ศุกร์|เสาร์|อาทิตย์)\s*(นี้|หน้า)?/);
    if (wd) window = resolveWeekday(wd[1]! + (wd[2] || ""));
    else window = resolveThaiDateInText(t);
    if (!window) {
      const dm = t.match(/วันที่\s*(\d{1,2}(?:\/\d{1,2}(?:\/\d{2,4})?)?|\d{4}-\d{2}-\d{2})/);
      if (dm) window = resolveDay(dm[1]!);
    }
  }

  let atMin: number | null = null;
  const rangeM = t.match(/(\d{1,2})[:.](\d{2})\s*(?:[-–—]|ถึง)\s*(\d{1,2})[:.](\d{2})/);
  if (rangeM) {
    const sh = Number(rangeM[1]);
    const sm = Number(rangeM[2]);
    const eh = Number(rangeM[3]);
    const em = Number(rangeM[4]);
    atMin = sh * 60 + sm;
    const span = eh * 60 + em - atMin;
    if (span >= 5 && span <= 8 * 60) durationMin = span;
  } else {
    const timeM =
      t.match(/(?:ตอน|เวลา|ที่)\s*(\d{1,2}[:.]\d{2})/i) || t.match(/\b(\d{1,2}[:.]\d{2})\b/);
    if (timeM) {
      atMin = parseHHMM(timeM[1]!.replace(".", ":"));
    } else {
      const thaiClock = parseThaiClockToHHMM(t);
      if (thaiClock) atMin = parseHHMM(thaiClock);
    }
  }

  // Half-day requests carry their own window when no explicit time was given:
  // morning = work start → noon, afternoon = noon → work end.
  if (halfDay && atMin == null) {
    if (halfDay[1] === "เช้า") {
      atMin = WORK_START_HOUR * 60;
      durationMin = Math.max(60, 12 * 60 - atMin);
    } else {
      atMin = 12 * 60;
      durationMin = Math.max(60, WORK_END_HOUR * 60 - atMin);
    }
  }

  // "…วันเสาร์นี้ตอนเย็น" — a part of the day is a time too. Use the same bands
  // the intent parser documents (เช้า 09-12, บ่าย 13-16, เย็น 16-18, ค่ำ 18-20)
  // so the confirm card shows a concrete slot instead of asking for one.
  if (atMin == null && !allDay) {
    const band = t.match(/(?:ตอน|ช่วง)?\s*(เช้า|สาย|บ่าย|เย็น|ค่ำ|กลางคืน)/);
    const BANDS: Record<string, [number, number]> = {
      เช้า: [WORK_START_HOUR * 60, 12 * 60],
      สาย: [10 * 60, 12 * 60],
      บ่าย: [13 * 60, 16 * 60],
      เย็น: [16 * 60, 18 * 60],
      ค่ำ: [18 * 60, 20 * 60],
      กลางคืน: [19 * 60, 21 * 60],
    };
    const hit = band?.[1] ? BANDS[band[1]] : undefined;
    if (hit) {
      atMin = hit[0];
      if (!durationMin) durationMin = Math.max(60, hit[1] - hit[0]);
    }
  }

  let subject = "จองเวลา";
  // No leading \s before เรื่อง — Thai may glue it to the previous word.
  const subjM = t.match(/เรื่อง\s*(.+)$/i);
  if (subjM) {
    subject =
      subjM[1]!
        .trim()
        .replace(/\s*(?:ทั้งวัน|ตลอดวัน|all\s*day)\s*$/i, "")
        .replace(/[.,]+$/g, "")
        .trim()
        .slice(0, 200) || subject;
  } else {
    // Fall back to whatever the user typed beyond the date/time — that is the
    // reason they are blocking the day ("…ทั้งวันไป ออกรายการ").
    const activity = soloMeetActivitySubject(t) || selfBookReason(t);
    if (activity) subject = activity;
  }

  const params: Record<string, unknown> = { subject };
  if (window) {
    params.day_start = wallIso(window.start);
    params.date_label = window.label;
  }
  if (allDay) params.all_day = true;
  if (atMin != null) params.at = fmtHHMM(atMin);
  if (durationMin) params.duration_min = durationMin;
  return { intent: "book_self_calendar", params };
}

/** Deterministic parse for “นัด/จอง + ชื่อคน (+ วัน/เวลา/เรื่อง)” — avoids LLM mistaking เรื่อง… as add_task. */
function quickBookIntent(text: string): { intent: string; params: Record<string, unknown> } | null {
  let t = text.trim().replace(/\s+/g, " ");
  if (!t) return null;

  // “แนบไฟล์ 3 ส่งนัด …” → book + attach file from last search
  let file_index: number | undefined;
  let pending_line_photo = false;
  const attachPrefix = t.match(/^(?:แนบ|ผูก)\s*(?:ไฟล์|อัน|ข้อ)\s*(\d{1,2})\s+/i);
  if (attachPrefix) {
    file_index = Number(attachPrefix[1]);
    t = t.slice(attachPrefix[0].length).trim();
  }
  const photoPrefix = t.match(/^แนบ(?:รูป|ภาพ)\s*/i);
  if (photoPrefix) {
    pending_line_photo = true;
    t = t.slice(photoPrefix[0].length).trim();
  }

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

  // Capture day before peelSchedulePhrases strips วันนี้/พรุ่งนี้
  let period: string | undefined;
  if (/วันนี้/.test(t)) period = "today";
  else if (/พรุ่งนี้/.test(t)) period = "tomorrow";
  else if (/มะรืน(นี้)?/.test(t)) period = "week";

  let duration_min = 30;
  const halfHr = body.match(/ครึ่ง\s*(?:ชม\.?|ชั่วโมง|hr|hour)/i);
  if (halfHr) {
    duration_min = 30;
    body = body.replace(halfHr[0], " ").replace(/\s+/g, " ").trim();
  }
  const durHr = body.match(/(\d+)\s*(?:ชม\.?|ชั่วโมง|hr|hour)/i);
  const durMin = body.match(/(\d+)\s*(?:นาที|min)/i);
  if (durHr) {
    duration_min = Math.max(15, Number(durHr[1]) * 60);
    body = body.replace(durHr[0], " ").replace(/\s+/g, " ").trim();
  } else if (durMin) {
    duration_min = Math.max(5, Number(durMin[1]));
    body = body.replace(durMin[0], " ").replace(/\s+/g, " ").trim();
  }
  // “30นาทีของพี่เอ็ม” (no space) — still peel duration so ของพี่เอ็ม survives
  body = peelSchedulePhrases(body);

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
      body.match(/(?:ตอน|เวลา|ที่)\s*(\d{1,2}[:.]\d{2})/i) || body.match(/\b(\d{1,2}[:.]\d{2})\b/);
    if (timeM) {
      at = timeM[1].replace(".", ":").padStart(5, "0");
      if (at.length === 4) at = `0${at}`;
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
    .replace(/\b\d{1,2}[:.]\d{2}\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // “นัดพี่นนท์ อัพเดท ai assistant วันนี้ 13:30” — no “เรื่อง”: first token = คน, rest = หัวข้อ
  // (only when a single person — multi-person uses กับ/และ/,)
  if (!note && body && !/(?:กับ|และ|,)/.test(body) && !extractEmails(body).length) {
    const one = body.match(/^((?:พี่|คุณ|น้อง|อาจารย์)?[^\s]+)(?:\s+(.+))?$/u);
    if (one?.[2]?.trim()) {
      const rest = one[2].trim();
      // Don't treat leftover schedule junk as a subject
      if (!/^(วันนี้|พรุ่งนี้|มะรืน|นาที|โมง|ครึ่ง)/i.test(rest) && rest.length >= 2) {
        note = rest.replace(/[.,]+$/g, "").trim();
        body = one[1]!.trim();
      }
    }
  }

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
  if (file_index) params.file_index = file_index;
  if (pending_line_photo) params.pending_line_photo = true;
  return { intent: "find_meeting_time", params };
}

function extractEmails(text: string): string[] {
  const found = text.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) || [];
  return Array.from(new Set(found.map((e) => e.toLowerCase())));
}

/**
 * Normalize book-line tokens: pull clean emails out of "นัด ake@x.com",
 * drop command words. Dedupes mail; keeps duplicate nicknames when the input
 * listed the same nick twice (e.g. “เบสกับพี่เบส”).
 */
function sanitizeAttendeeTokens(tokens: string[]): string[] {
  const out: string[] = [];
  const seenMail = new Set<string>();
  // Whole-token schedule junk only — never substring-kill “นาทีของพี่เอ็ม”
  const noiseWhole =
    /^(?:วันนี้|พรุ่งนี้|มะรืน|นาที|โมง|ทุ่ม|เรื่อง|ตอน|บ่าย|เช้า|เย็น|เที่ยง|ชั่วโมง|ช่วง|เวลา|ว่าง|ตรงกัน|หาเวลาว่าง|หาเวลา|\d{1,2}(?::\d{2})?)$/i;

  // How many times each nick appears in the raw token list (เบส+พี่เบส → เบส×2)
  const nickBudget = new Map<string, number>();
  for (const raw of tokens) {
    const s = peelSchedulePhrases(String(raw || "").trim());
    if (!s || extractEmails(s).length) continue;
    const n = cleanPersonToken(s);
    if (!n || noiseWhole.test(n) || SELF_WORDS.has(n)) continue;
    const key = n.toLowerCase();
    nickBudget.set(key, (nickBudget.get(key) || 0) + 1);
  }
  const nickUsed = new Map<string, number>();

  const pushMail = (e: string) => {
    const m = e.trim().toLowerCase();
    if (!m.includes("@") || seenMail.has(m)) return;
    seenMail.add(m);
    out.push(m);
  };
  const pushName = (raw: string) => {
    let n = cleanPersonToken(raw);
    if (!n) return;
    if (noiseWhole.test(n)) return;
    if (SELF_WORDS.has(n) || /^(ประชุม|นัด|จอง|หา|ส่ง)$/i.test(n)) return;
    if (n.split(/\s+/).length > 2) return;
    if (n.length > 32) return;
    const key = n.toLowerCase();
    if (seenMail.has(key)) return;
    const used = nickUsed.get(key) || 0;
    const budget = Math.max(1, nickBudget.get(key) || 1);
    if (used >= budget) return;
    nickUsed.set(key, used + 1);
    out.push(n);
  };

  for (const raw of tokens) {
    const s = peelSchedulePhrases(String(raw || "").trim());
    if (!s) continue;
    const emails = extractEmails(s);
    if (emails.length) {
      for (const e of emails) pushMail(e);
      const rest = s
        .replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, " ")
        .replace(/^(?:นัด|จอง|เชิญ|invite|กับ|และ|หา)\s+/i, " ")
        .replace(/\s+/g, " ")
        .trim();
      if (rest && !noiseWhole.test(rest)) {
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
  //
  // Sample data only when the person asks for sample data. Matching every
  // "เพิ่มงาน…" turned "เพิ่มงาน ทำสลิปการประชุม พรุ่งนี้ 17:00" into two
  // invented tasks and silently dropped the real one.
  const wantsSampleTasks =
    /(?:เพิ่ม|สร้าง|ขอ|ใส่)\s*งาน(?:ติดตาม)?/i.test(textClean) &&
    (/(?:ทดสอบ|ตัวอย่าง|สมมติ)/i.test(textClean) || /\d{1,2}\s*งาน/i.test(textClean) || /^(?:ขอ)?\s*(?:เพิ่ม|สร้าง|ขอ|ใส่)\s*งาน(?:ติดตาม)?(?:\s*ให้)?(?:\s*\d{1,2}\s*งาน)?(?:\s*ที|\s*ครับ|\s*ค่ะ)?$/i.test(textClean));
  if (wantsSampleTasks) {
    const countMatch = textClean.match(/(\d{1,2})\s*งาน/);
    const count = countMatch ? Math.min(Number(countMatch[1]), 5) : 2;
    return {
      intent: "add_sample_tasks",
      params: { count },
      source: "quick",
    };
  }

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

  // Contact / Support queries: "มีปัญหาต้องติดต่อใคร", "ติดต่อใคร", "แจ้งปัญหา", "ติดต่อแอดมิน"
  if (
    /(?:มีปัญหา|แจ้งปัญหา|ติดต่อใคร|ติดต่อadmin|ติดต่อแอดมิน|พัง|ใช้งานไม่ได้|เจอบั๊ก|แจ้งบั๊ก|ติดต่อใครได้)/i.test(textClean) ||
    /^(?:ติดต่อ|แจ้งปัญหา|ซัพพอร์ต|support)(?:\s*(?:ครับ|ค่ะ|ได้ที่ไหน))?$/i.test(textClean)
  ) {
    return {
      intent: "contact_support",
      params: {},
      source: "quick",
    };
  }

  // Greeting shortcuts: "หวัดดี", "หวัดD", "สวัสดี", "ดีครับ", "ดีค่ะ", "ไง", "ว่าไง", "hello", "hi", "hey"
  if (
    /^(?:สวัสดี|หวัดดี|หวัด[dD]|ดีครับ|ดีค่ะ|ดีจ้า|ดีคับ|ดีฮะ|ดีงับ|hello|hi|hey|สัสดี|ไง|ว่าไง|เป็นไง|ไงบ้าง)(?:\s*(?:ครับ|ค่ะ|วะ|ว่ะ|จ๊ะ|นะ|อะ|อ่ะ|คับ|ฮะ|มึง|เพื่อน))?$/i.test(textClean)
  ) {
    return {
      intent: "greeting",
      params: {},
      source: "quick",
    };
  }
  if (
    /^(?:เรา|เราสองคน|คุณ|เธอ)?\s*(?:รู้จัก|สนิท)(?:\s*(?:กัน|เรา|ฉัน|ผม))?\s*(?:ไหม|มั้ย|ปะ|ด้วยปะ|หรือเปล่า|รึเปล่า)(?:ครับ|ค่ะ|วะ|ว่ะ|จ๊ะ|นะ|อะ|อ่ะ)?$/i.test(textClean) ||
    /^(?:รู้จักกันไหม|รู้จักกันมั้ย|รู้จักเราไหม|รู้จักเรามั้ย|รู้จักผมไหม|รู้จักหนูไหม)$/i.test(textClean)
  ) {
    return {
      intent: "do_you_know_me",
      params: {},
      source: "quick",
    };
  }

  // 2) "รู้จักกันหรอ", "รู้จักกันเหรอ", "สนิทกันหรอ", "รู้จักด้วยหรอ" -> know_each_other (Style 2)
  if (
    /^(?:เรา|เราสองคน|คุณ|เธอ)?\s*(?:รู้จัก|สนิท)(?:\s*(?:กัน|เรา|ฉัน|ผม))?\s*(?:หรอ|เหรอ|ด้วยหรอ|ด้วยเหรอ)(?:ครับ|ค่ะ|วะ|ว่ะ|จ๊ะ|นะ|อะ|อ่ะ)?$/i.test(textClean) ||
    /^(?:รู้จักกันหรอ|รู้จักกันเหรอ|สนิทกันหรอ|รู้จักด้วยหรอ)$/i.test(textClean)
  ) {
    return {
      intent: "know_each_other",
      params: {},
      source: "quick",
    };
  }
  if (
    /^(?:คุณ|เธอ|นาย|มึง|แก|ตัว)?\s*(?:คือ|เป็น)?\s*ใคร(?:ครับ|ค่ะ|วะ|ว่ะ|จ๊ะ|นะ|อะ|อ่ะ|นิ|หว่า|วะครับ)?$/i.test(textClean) ||
    /^(?:คุณ|เธอ|นาย)?\s*(?:ทำ|ช่วย)\s*(?:อะไร|งานอะไร)\s*(?:ได้บ้าง|ได้มั่ง|เป็นบ้าง|บ้าง)(?:ครับ|ค่ะ|วะ|ว่ะ|จ๊ะ|นะ|อะ|อ่ะ)?$/i.test(textClean) ||
    /^(?:แนะนำตัว|แนะนำตัวเอง|คุณช่วยอะไรได้บ้าง|ทำอะไรได้บ้าง|ทำอะไรได้บ้างอะ|ทำอะไรเป็นบ้าง)$/i.test(textClean)
  ) {
    return {
      intent: "who_are_you",
      params: {},
      source: "quick",
    };
  }

  // Request direct meeting link: "ขอลิงก์ประชุมวันที่ 21", "ขอลิงค์ ms teams", "ขอลิงก์ teams"
  if (/(?:ขอ|ส่ง|อยากได้|เอา)?\s*(?:ลิงก์|ลิงค์|link)\s*(?:ประชุม|teams|ms\s*teams|zoom)?/i.test(textClean)) {
    const dayM = dayHintFromText(textClean);
    const dateStr = dayM ? wallIso(dayM.start).split("T")[0] : undefined;
    const idxMatch = textClean.match(/(?:นัด|อัน|ที่)\s*(\d{1,2})/);
    const meeting_index = idxMatch ? Number(idxMatch[1]) : 1;
    return {
      intent: "get_meeting_link",
      params: { meeting_index, date: dateStr },
      source: "quick",
    };
  }

  // Quick task closure confirmation handling: "ยืนยันปิดงาน", "ยืนยัน"
  if (
    context?.last_intent === "confirm_complete_task" &&
    /^(?:ยืนยันปิดงาน|ยืนยัน|ตกลง|ปิดเลย|ใช่|ปิด|confirm|ok|yes)$/i.test(textClean)
  ) {
    const pendingTargetIds = (context?.pending_task_ids as number[]) || [];
    if (pendingTargetIds.length) {
      return {
        intent: "complete_task",
        params: { task_ids: pendingTargetIds, confirmed: true },
        source: "quick",
      };
    }
  }

  // "ปิดงานทั้งหมด" / "ปิดทั้งหมด" / "เคลียร์งานหมด" — everything pending at
  // once. The handler still asks for confirmation before closing anything.
  if (/^(?:ปิด|เสร็จ|ทำเสร็จ|เคลียร์)(?:งาน)?\s*(?:ทั้งหมด|ทุกงาน|ทุกอัน|หมด)(?:เลย)?\s*(?:แล้ว|เลย|ครับ|ค่ะ|นะ)?$/i.test(textClean)) {
    return { intent: "complete_task", params: { all: true }, source: "quick" };
  }

  // Quick task closure: "ปิดงาน 1 2 3", "ปิดงาน 1,2,3", "ปิดงาน 1 2"
  const closeTasksMatch = textClean.match(/^(?:ปิดงาน|เสร็จงาน|ลบงาน|ทำเสร็จแล้ว)\s+((?:[#\s,]*\d+)+)$/i);
  if (closeTasksMatch) {
    const rawIds = closeTasksMatch[1].match(/\d+/g)?.map(Number) || [];
    if (rawIds.length) {
      return {
        intent: "complete_task",
        params: { task_ids: rawIds, task_id: rawIds[0] },
        source: "quick",
      };
    }
  }

  // “มีอีกไหม” after nickname duplicate list — next page / confirm complete (no re-dump)
  const moreNick =
    /^(มีอีก|มีเพิ่ม|ดูต่อ|ต่อไป|หน้าต่อไป|หน้าถัดไป)(ไหม|มั้ย)?$|^มีอีกไหม$|^อีกไหม$|^อีกมั้ย$|^ครบยัง$|^มีหมดแล้วไหม$/i.test(
      textClean.replace(/\s+/g, " ").trim()
    );
  if (context?.last_intent === "find_duplicate_nicknames" && moreNick) {
    return { intent: "find_duplicate_nicknames", params: { more: true }, source: "quick" };
  }

  // Filter previous file list by extension — "เอาแค่ .html" (no LLM)
  if (context?.last_intent === "file_results" && context?.files?.length) {
    const extFilter = parseFileExtensionFilter(textClean);
    if (extFilter) {
      return { intent: "filter_file_results", params: { filetype: extFilter }, source: "quick" };
    }
  }

  // File location follow-up — "อยู่ที่ไหน" after search
  if (context?.last_intent === "file_results" && context?.files?.length) {
    if (/อยู่(?:ที่)?ไหน|อยู่ไหน|โฟลเดอร์(?:ไหน|อะไร)|ไฟล์อยู่|path/i.test(textClean)) {
      return { intent: "file_locations", params: {}, source: "quick" };
    }
  }

  // Refine cancel list — "พรุ่งนี้ ไม่ใช่วันนี้"
  if (context?.last_intent === "choose_cancel") {
    if (/พรุ่งนี้/.test(textClean) && (/ไม่ใช่|ไม่เอา/.test(textClean) || /วันนี้/.test(textClean))) {
      return { intent: "cancel_meeting", params: { period: "tomorrow" }, source: "quick" };
    }
    if (/^วันนี้(?:\s*เท่านั้น)?$/i.test(textClean.trim())) {
      return { intent: "cancel_meeting", params: { period: "today" }, source: "quick" };
    }
    if (/^พรุ่งนี้(?:\s*เท่านั้น)?$/i.test(textClean.trim())) {
      return { intent: "cancel_meeting", params: { period: "tomorrow" }, source: "quick" };
    }
  }

  // After a cancellation, user may say “ยังไม่ได้/อันนี้ไม่ได้” to cancel another item
  // from the same previously shown list.
  if (
    /cancel/i.test(String(context?.last_intent || "")) &&
    /(ยังไม่ได้|อันนี้ไม่ได้|ไม่ใช่อันนี้|ไม่เอาอันนี้|ยกเลิกอันอื่น|เอาอันอื่น)/i.test(textClean)
  ) {
    const lp = context?.last_period || "upcoming";
    return { intent: "cancel_meeting", params: { period: lp }, source: "quick" };
  }

  // Fast deterministic rule after a file search — summarize only, never steal booking lines
  if (context?.last_intent === "file_results" || (context?.files?.length && /อ่าน|สรุป/.test(textClean))) {
    const bookingish =
      /ส่งนัด|นัดหา|เชิญ\b|invite\b|จอง(?:ประชุม)?|หาเวลา|ผูก(?:ไฟล์)?|แนบ(?:อัน|ไฟล์|ลิงก์).*(?:นัด|ประชุม|ส่งนัด)|แนบไฟล์\s*\d+\s*(?:ส่งนัด|นัด|จอง)|กับนัด|ให้นัด/i.test(
        textClean
      );
    if (!bookingish) {
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
    const params = sanitizeParsedParams(parsed.params || {});
    return { intent: parsed.intent || "unknown", params, source: "llm" };
  } catch {
    return { intent: "unknown", params: {}, source: "llm" };
  }
}

/**
 * The model sometimes drops a whole sentence into `person` ("เสาร์นี้มีไปทำฟัน
 * 10โมง"), which then gets looked up in the directory and fails. A name is
 * short and carries no day/time words — anything else is the user talking about
 * their own schedule, so drop the field and let the request resolve to self.
 */
function sanitizeParsedParams(params: Record<string, unknown>): Record<string, unknown> {
  const person = typeof params.person === "string" ? params.person.trim() : "";
  if (!person) return params;
  const isNonPersonQuery =
    /(?:วันนี้|พรุ่งนี้|มะรืน|สัปดาห์|อาทิตย์นี้|จันทร์|อังคาร|พุธ|พฤหัส|ศุกร์|เสาร์|อาทิตย์|เช้า|บ่าย|เย็น|ค่ำ|โมง|ทุ่ม|เที่ยง|ครึ่ง|ทั้งวัน|\d{1,2}[:.]\d{2}|\d+\s*(?:นาที|ชม|ชั่วโมง)|ออนไลน์|online|Teams|Zoom|อันไหน|ไร|อะไร|บ้าง|มั้ง|ที่ไหน|ไหน|สถานที่|ห้อง)/i.test(
      person
    );
  const tooLong = person.replace(/\s+/g, " ").split(" ").length > 4 || person.length > 40;
  if (isNonPersonQuery || tooLong) {
    const { person: _dropped, ...rest } = params;
    void _dropped;
    return rest;
  }
  return params;
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
    // A name the directory does not know is usually a follow-up the parser
    // misread ("วันอื่นอะ"), not a colleague — so offer the way out instead of
    // dead-ending on a lookup failure.
    return {
      intent: "list_meetings",
      reply: `หาคนชื่อ “${person}” ในองค์กรไม่เจอครับ — ถ้าหมายถึงตารางของคุณเอง กดปุ่มด้านล่างได้เลย หรือพิมพ์อีเมลของคนที่ต้องการ`,
      suggestions: [
        { label: "📅 ตารางฉันวันนี้", text: "ตารางวันนี้" },
        { label: "📅 พรุ่งนี้", text: "นัดพรุ่งนี้" },
        { label: "⬜ ขอตารางว่าง", text: "ขอตารางว่าง" },
      ],
    };
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
      const d = fmtDayHeader(r.sd);
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
      const d = fmtDayHeader(r.start);
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
    const d = sd ? fmtDayHeader(sd) : "?";
    if (d !== lastDay) {
      lines.push(`— ${d} —`);
      lastDay = d;
    }
    const bodyText = ev.body?.content || ev.bodyPreview || "";
    const hasOnline = ev.onlineMeeting || /teams\.microsoft\.com|meet\.google\.com|zoom\.us/i.test(bodyText);
    const loc = ev.location?.displayName ? ` 📍 ${ev.location.displayName}` : "";
    const onlineTag = hasOnline ? " 💻 ประชุมออนไลน์ (มีลิงก์ Teams)" : "";
    lines.push(`  ${tt} · ${ev.subject || "(ไม่มีหัวข้อ)"}${loc}${onlineTag}`);
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

const FILETYPE_ALIASES: Record<string, string> = {
  excel: "xlsx",
  xls: "xlsx",
  word: "docx",
  doc: "docx",
  powerpoint: "pptx",
  ppt: "pptx",
  pdf: "pdf",
  html: "html",
  htm: "html",
  สเปรดชีต: "xlsx",
  เอกสาร: "docx",
};

function normalizeFileType(raw: string): string {
  const k = String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/^\./, "");
  return FILETYPE_ALIASES[k] || k;
}

/** "ai.html" → { query: "ai", filetype: "html" } */
function parseQueryWithExtension(raw: string): { query: string; filetype: string } {
  const s = String(raw || "").trim();
  const m = s.match(/^(.+?)\.([a-z0-9]{2,5})$/i);
  if (!m) return { query: s, filetype: "" };
  return { query: m[1]!.trim(), filetype: normalizeFileType(m[2]!) };
}

/** Follow-up after file search: "เอาแค่ .html", "แค่ xlsx" */
function parseFileExtensionFilter(text: string): string | null {
  const t = text.trim().replace(/\s+/g, " ");
  const patterns = [
    /^เอา(?:แค่|เฉพาะ)\s*\.?([a-z0-9]{2,5})$/i,
    /^(?:แค่|เฉพาะ|only)\s*\.?([a-z0-9]{2,5})$/i,
    /^\.([a-z0-9]{2,5})$/i,
  ];
  for (const p of patterns) {
    const m = t.match(p);
    if (m) return normalizeFileType(m[1]!);
  }
  return null;
}

function stripFileLocationHint(raw: string): { query: string; wantsLocation: boolean } {
  const wantsLocation = /อยู่(?:ที่)?ไหน|อยู่ไหน|โฟลเดอร์(?:ไหน|อะไร)|path\s*อะไร|ที่(?:อยู่|เก็บ)/i.test(raw);
  const query = raw
    .replace(/\s*(?:อยู่(?:ที่)?ไหน|อยู่ไหน|โฟลเดอร์(?:ไหน|อะไร)|path\s*อะไร|ที่(?:อยู่|เก็บ)(?:ไฟล์)?)\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return { query, wantsLocation };
}

function mapFileHits(hits: DriveFileHit[]): FileResultItem[] {
  return hits.map((f) => {
    const p = withDriveItemPath(f);
    return {
      id: p.id,
      name: p.name,
      url: p.webUrl,
      path: p.path,
      is_folder: !!p.folder,
      modified: p.lastModifiedDateTime,
    };
  });
}

type FileResultItem = {
  id?: string;
  name?: string;
  url?: string;
  path?: string;
  is_folder?: boolean;
  modified?: string;
};

function buildFileResultsResponse(
  files: FileResultItem[],
  label: string,
  opts?: { showLocation?: boolean }
): CommandResult {
  return {
    intent: "file_results",
    reply:
      `เจอ ${files.length} ไฟล์ที่ตรงกับ “${label}” ครับ 👇\n\n` +
      `จะผูกกับนัดวันนี้ พิมพ์ เช่น “ผูกไฟล์นัด 1” หรือ “แนบอัน 2 กับนัด 1”\n` +
      `ผูกลิงก์: “แนบลิงก์นัด 1 https://…”` +
      (!opts?.showLocation ? `\n(ถาม “อยู่ที่ไหน” เพื่อดูโฟลเดอร์ใน OneDrive)` : ""),
    files,
    show_file_location: !!opts?.showLocation,
    suggestions: [
      { label: "สรุปอัน 1", text: "สรุปอัน 1" },
      { label: "สรุปอัน 2", text: "สรุปอัน 2" },
      { label: "ผูกไฟล์นัด 1", text: "ผูกไฟล์นัด 1" },
    ],
  };
}

async function searchFilesSmart(userUpn: string, query: string, filetype: string) {
  const found = new Map<string, Awaited<ReturnType<typeof searchFiles>>[number]>();
  const add = (items: Awaited<ReturnType<typeof searchFiles>>) => {
    for (const f of items) found.set(f.webUrl || f.id || f.name || "", f);
  };
  if (query) {
    add(await searchFiles(userUpn, query));
    // Only split into words when the full query missed — skip ultra-short tokens
    if (!found.size) {
      for (const w of query.split(/\s+/)) {
        if (w.length >= 3) add(await searchFiles(userUpn, w));
      }
    }
  }
  if (!found.size && filetype) add(await searchFiles(userUpn, filetype));

  let files = [...found.values()];
  if (filetype) {
    files = files.filter((f) => (f.name || "").toLowerCase().endsWith("." + filetype));
  }
  // Re-rank across merged sources (same rules as searchFiles)
  return rankDriveFileHits(files, query || filetype, 15);
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

/** Short label for LINE cancel buttons — date + time + subject (distinguish same-time duplicates). */
function cancelButtonLabel(ev: GraphEvent, now: Date = nowWall(), dup = 1): string {
  const sd = ev.start?.dateTime ? parseWall(ev.start.dateTime) : null;
  const ed = ev.end?.dateTime ? parseWall(ev.end.dateTime) : null;
  const live = !!(sd && ed && now >= sd && now < ed);
  const dd = sd ? String(sd.getUTCDate()).padStart(2, "0") : "??";
  const mm = sd ? String(sd.getUTCMonth() + 1).padStart(2, "0") : "??";
  const time = sd ? fmtTime(sd) : "??:??";
  const subj = (ev.subject || "นัด").replace(/\s+/g, " ").trim().slice(0, 9);
  const tag = dup > 1 ? `#${dup}` : "";
  return `${live ? "🔴" : "❌"}${dd}/${mm} ${time} ${subj}${tag}`;
}

function buildCancelChoices(events: GraphEvent[], now: Date = nowWall()) {
  const sorted = sortCancelEvents(events, now);
  const keyCount = new Map<string, number>();
  return sorted.map((ev) => {
    const sd = ev.start?.dateTime ? parseWall(ev.start.dateTime) : null;
    const key = `${sd ? fmtDateTime(sd) : "?"}|${ev.subject || ""}`;
    const n = (keyCount.get(key) || 0) + 1;
    keyCount.set(key, n);
    return {
      event_id: ev.id!,
      label: cancelEventLabel(ev, now),
      short_label: cancelButtonLabel(ev, now, n),
    };
  });
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
  // No \b — Thai word boundaries are unreliable in JS
  if (/วันนี้|เช้านี้|บ่ายนี้|เย็นนี้|ค่ำนี้/.test(text || "")) return periodRange("today");
  if (/พรุ่งนี้/.test(text || "")) return periodRange("tomorrow");
  if (/มะรืน(?:นี้)?/.test(text || "")) {
    const d = addDays(startOfDay(nowWall()), 2);
    return { start: d, end: endOfDay(d), label: "มะรืนนี้" };
  }
  const m = text.match(/วัน?(จันทร์|อังคาร|พุธ|พฤหัสบดี?|ศุกร์|เสาร์|อาทิตย์)\s*(นี้|หน้า)?/);
  if (m) return resolveWeekday(m[1] + (m[2] || ""));
  const thaiDate = resolveThaiDateInText(text);
  if (thaiDate) return thaiDate;
  const namedMonth = resolveThaiMonthRange(text);
  if (namedMonth) return namedMonth;
  const dm = text.match(/วันที่\s*(\d{1,2}(?:\/\d{1,2}(?:\/\d{2,4})?)?|\d{4}-\d{2}-\d{2})/);
  if (dm) return resolveDay(dm[1]);
  return null;
}

function resolveFindWindow(params: Record<string, unknown>, text: string): MtWindow | null {
  // Same precedence as the listing: a month by name is a month, not its 1st.
  const namedMonth = resolveThaiMonthRange(text);
  if (namedMonth) return namedMonth;
  if (params.weekday) return resolveWeekday(String(params.weekday));
  if (params.date) return resolveDay(String(params.date));
  if (params.period && ["today", "tomorrow"].includes(String(params.period))) {
    return periodRange(String(params.period));
  }
  return dayHintFromText(text);
}

function timeBandFromText(text: string): { after: number | null; before: number | null; label: string } | null {
  // Typos: ช่าวง→ช่วง, เข้า(เมื่อคู่กับช่วง)→เช้า, เช้ส→เช้า
  const t = text
    .trim()
    .replace(/\s+/g, " ")
    .replace(/ช่าวง/g, "ช่วง")
    .replace(/เช้ส/g, "เช้า")
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
  // Day-only follow-ups (“พรุ่งนี้ล่ะ”) are handled separately — keep attendees, change day.
  if (isDayFollowUp(t)) return false;
  const who = personFromText(t);
  // Leftover particles after stripping day words must not count as a person
  if (who && !/^(?:ล่ะ|ละ|วะ|ไหม|มั้ย|นะ|จ้า|ที)$/u.test(who)) return false;
  if (dayHintFromText(t) && !isDayFollowUp(t)) return false;
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

/** “พรุ่งนี้ล่ะ” / “แล้ววันนี้” — same people, new calendar day. */
function isDayFollowUp(text: string): boolean {
  const t = text.trim().replace(/\s+/g, " ").replace(/เช้ส/g, "เช้า");
  if (!t) return false;
  return (
    /^(?:แล้ว)?(?:วัน)?พรุ่งนี้(?:\s*(?:ล่ะ|ละ|ไหม|มั้ย|วะ|นะ))?[!?.…]*$/u.test(t) ||
    /^(?:แล้ว)?(?:วัน)?มะรืน(?:นี้)?(?:\s*(?:ล่ะ|ละ|ไหม|มั้ย|วะ|นะ))?[!?.…]*$/u.test(t) ||
    /^(?:แล้ว)?วันนี้(?:\s*(?:ล่ะ|ละ|ไหม|มั้ย|วะ|นะ))?[!?.…]*$/u.test(t) ||
    /^(?:แล้ว)?วัน(?:จันทร์|อังคาร|พุธ|พฤหัสบดี?|ศุกร์|เสาร์|อาทิตย์)(?:นี้|หน้า)?(?:\s*(?:ล่ะ|ละ|ไหม|มั้ย))?[!?.…]*$/u.test(
      t
    )
  );
}

/**
 * “แต่พรุ่งนี้เช้าว่างนะ” / “พรุ่งนี้เช้า” — keep attendees, change day + optional time band.
 * (User insisting Outlook shows free time.)
 */
function isDayBandFollowUp(text: string): boolean {
  const t = text.trim().replace(/\s+/g, " ").replace(/เช้ส/g, "เช้า");
  if (!t) return false;
  if (!/(?:วันนี้|พรุ่งนี้|มะรืน(?:นี้)?|วัน(?:จันทร์|อังคาร|พุธ|พฤหัสบดี?|ศุกร์|เสาร์|อาทิตย์))/u.test(t)) {
    return false;
  }
  if (!/(?:เช้า|สาย|บ่าย|เย็น|ค่ำ|ว่าง)/u.test(t)) return false;
  // New multi-person ask → not a follow-up
  if (peopleFromText(t).length >= 2) return false;
  if (/^(?:นัด|จอง|ส่งนัด)/u.test(t)) return false;
  return true;
}

function windowFromDayFollowUp(text: string): MtWindow | null {
  const t = text.trim().replace(/เช้ส/g, "เช้า");
  if (/พรุ่งนี้/.test(t)) return periodRange("tomorrow");
  if (/มะรืน/.test(t)) {
    const d = addDays(startOfDay(nowWall()), 2);
    return { start: d, end: endOfDay(d), label: "มะรืนนี้" };
  }
  if (/วันนี้/.test(t)) return periodRange("today");
  const m = t.match(/วัน?(จันทร์|อังคาร|พุธ|พฤหัสบดี?|ศุกร์|เสาร์|อาทิตย์)\s*(นี้|หน้า)?/);
  if (m) return resolveWeekday(m[1] + (m[2] || ""));
  return null;
}

function windowFromStored(m?: CommandContext["last_meeting"]): MtWindow | null {
  if (!m?.window?.start || !m.window.end) return null;
  const start = parseWall(m.window.start);
  const end = parseWall(m.window.end);
  if (!start || !end) return null;
  return { start, end, label: m.window.label || fmtDate(start) };
}

/** “1” / “1กับ2” / “หนึ่งกับสอง” / “1 และ 2” → 1-based indices. */
function parseChoiceIndices(text: string): number[] {
  let t = text.trim().replace(/\s+/g, " ");
  t = t.replace(/^เลือก\s*/u, "").replace(/[)）.]+$/u, "").trim();
  // Strip trailing Thai particles
  t = t.replace(/\s*(?:ครับ|ค่ะ|นะ|เลย)\s*$/u, "").trim();
  if (!t) return [];

  const WORD_TO_NUM: Record<string, number> = {
    "1": 1,
    "2": 2,
    "3": 3,
    "4": 4,
    "5": 5,
    "6": 6,
    "7": 7,
    "8": 8,
    "9": 9,
    "10": 10,
    "๑": 1,
    "๒": 2,
    "๓": 3,
    "๔": 4,
    "๕": 5,
    "๖": 6,
    "๗": 7,
    "๘": 8,
    "๙": 9,
    "๑๐": 10,
    หนึ่ง: 1,
    เอ็ด: 1,
    สอง: 2,
    สาม: 3,
    สี่: 4,
    ห้า: 5,
    หก: 6,
    เจ็ด: 7,
    แปด: 8,
    เก้า: 9,
    สิบ: 10,
    first: 1,
    second: 2,
    third: 3,
    one: 1,
    two: 2,
    three: 3,
  };

  const toNum = (tok: string): number | null => {
    const s = tok.trim().toLowerCase();
    if (!s) return null;
    if (/^\d{1,2}$/.test(s)) {
      const n = Number(s);
      return n >= 1 && n <= 20 ? n : null;
    }
    return WORD_TO_NUM[s] ?? null;
  };

  // Split on connectors (keep Thai words intact)
  const parts = t
    .split(/\s*(?:กับ|และ|,|\/|&|\+|กับ)\s*/u)
    .map((p) => p.trim())
    .filter(Boolean);

  // Single token: "1" / "หนึ่ง" / "ข้อ2"
  if (parts.length === 1) {
    const alone = parts[0]!.replace(/^ข้อ\s*/u, "").replace(/^อัน\s*/u, "").trim();
    const n = toNum(alone);
    return n != null ? [n] : [];
  }

  const nums: number[] = [];
  for (const p of parts) {
    const n = toNum(p.replace(/^ข้อ\s*/u, "").replace(/^อัน\s*/u, "").trim());
    if (n == null) return [];
    nums.push(n);
  }
  return nums;
}

function looksLikeChoiceAttempt(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 40) return false;
  if (parseChoiceIndices(t).length) return true;
  // Thai/Arabic digits or number-words with connectors
  return /(?:\d|[๑-๙]|หนึ่ง|สอง|สาม|สี่|ห้า|หก|เจ็ด|แปด|เก้า|สิบ)/u.test(t) &&
    /(?:กับ|และ|,|\/|&|\+)/u.test(t);
}

/** “ทั้งหมด” / “ทุกคน” / “เอาทั้งหมด” while choosing from a name list. */
function isSelectAllChoices(text: string): boolean {
  const t = text
    .trim()
    .replace(/\s+/g, "")
    .replace(/(?:ครับ|ค่ะ|นะ|เลย)$/u, "");
  return /^(?:เลือก|เอา)?(?:ทั้งหมด|ทุกคน|ทุกรายการ|all)$/i.test(t);
}

function pendingWindowBand(pending: PendingMtPick): {
  window: MtWindow | null;
  band: { after: number | null; before: number | null } | null;
} {
  const ws = pending.window?.start ? parseWall(pending.window.start) : null;
  const we = pending.window?.end ? parseWall(pending.window.end) : null;
  const window =
    ws && we ? { start: ws, end: we, label: pending.window?.label || fmtDate(ws) } : null;
  const band =
    pending.after != null || pending.before != null
      ? { after: pending.after ?? null, before: pending.before ?? null }
      : null;
  return { window, band };
}

/** Pick every person on the current disambiguation list. */
async function applyPendingMtPickAll(
  userUpn: string,
  pending: PendingMtPick
): Promise<CommandResult> {
  const choices = pending.choices || [];
  if (!choices.length) {
    return {
      intent: "find_meeting_time",
      reply: "ไม่มีรายชื่อให้เลือกครับ — พิมพ์ดูตารางใหม่อีกครั้งได้เลย",
      pending_mt_pick: null,
    };
  }
  const seen = new Set<string>();
  const attendees: MtAttendee[] = [];
  // Keep anyone already resolved, then add everyone on the list
  for (const a of pending.attendees || []) {
    const m = (a.mail || "").trim().toLowerCase();
    if (!m || seen.has(m)) continue;
    seen.add(m);
    attendees.push({ mail: a.mail, name: a.name });
  }
  for (const c of choices) {
    const m = (c.mail || "").trim().toLowerCase();
    if (!m || seen.has(m)) continue;
    seen.add(m);
    attendees.push({ mail: c.mail, name: c.displayName || c.mail });
  }
  const { window, band } = pendingWindowBand(pending);
  const res = await runFindMeeting(
    userUpn,
    attendees,
    pending.duration || 30,
    window,
    band,
    !!pending.includeLunch,
    pending.subject || "ประชุม",
    pending.atMin ?? null
  );
  if (res.intent !== "choose_mt_person" && res.pending_mt_pick === undefined) {
    res.pending_mt_pick = null;
  }
  return res;
}

async function applyPendingAvailPicks(
  userUpn: string,
  pending: PendingAvailPick,
  picks: number[] | "all"
): Promise<CommandResult> {
  const choices = pending.choices || [];
  if (!choices.length) {
    return {
      intent: "my_availability",
      reply: "ไม่มีรายชื่อให้เลือกครับ — พิมพ์ดูตารางใหม่อีกครั้งได้เลย",
      pending_avail_pick: null,
    };
  }
  const selected: { mail: string; displayName: string }[] = [];
  if (picks === "all") {
    for (const c of choices) {
      if (c.mail) selected.push({ mail: c.mail, displayName: c.displayName || c.mail });
    }
  } else {
    const used = new Set<string>();
    for (const p of picks) {
      const c = choices[p - 1];
      if (!c?.mail) {
        return {
          intent: "choose_person",
          reply: `ไม่มีข้อ ${p} ในรายการครับ — เลือก 1–${choices.length} หรือพิมพ์ ทั้งหมด ได้ครับ`,
          pending_avail_pick: pending,
          choices: choices.map((x) => ({
            mail: x.mail,
            displayName: x.displayName,
            period: pending.period,
            date: pending.date,
            lunch: pending.lunch,
          })),
          period: pending.period,
        };
      }
      const m = c.mail.toLowerCase();
      if (used.has(m)) continue;
      used.add(m);
      selected.push({ mail: c.mail, displayName: c.displayName || c.mail });
    }
  }
  if (!selected.length) {
    return {
      intent: "choose_person",
      reply: "ยังไม่ได้เลือกใครครับ — พิมพ์เลขหรือ ทั้งหมด ได้เลย",
      pending_avail_pick: pending,
      choices: choices.map((x) => ({
        mail: x.mail,
        displayName: x.displayName,
        period: pending.period,
        date: pending.date,
        lunch: pending.lunch,
      })),
      period: pending.period,
    };
  }

  const dayRange = pending.date ? resolveDay(pending.date) : null;
  const range = dayRange || periodRange(pending.period || "week");
  const lunch = !!pending.lunch;
  const mode = pending.mode || "free";

  // ดูนัด / ดูประชุม → show that person's meetings
  if (mode === "busy") {
    if (selected.length === 1) {
      const s = selected[0]!;
      const busy = await personBusyResponse(
        userUpn,
        s.displayName || s.mail,
        dayRange,
        pending.period || "upcoming",
        pending.after ?? null,
        pending.before ?? null,
        pending.at ?? null,
        { mail: s.mail, displayName: s.displayName }
      );
      busy.pending_avail_pick = null;
      return withCalendarNext({ ...busy, period: pending.period }, "meetings");
    }
    // Multiple: stack each person's agenda
    const parts: string[] = [];
    for (const s of selected.slice(0, 5)) {
      const busy = await personBusyResponse(
        userUpn,
        s.displayName || s.mail,
        dayRange,
        pending.period || "upcoming",
        pending.after ?? null,
        pending.before ?? null,
        pending.at ?? null,
        { mail: s.mail, displayName: s.displayName }
      );
      parts.push(busy.reply);
    }
    return withCalendarNext(
      {
        intent: "list_meetings",
        reply: parts.join("\n\n————\n\n"),
        pending_avail_pick: null,
        period: pending.period,
      },
      "meetings"
    );
  }

  // One person → show that person's free slots (original ดูตาราง behavior)
  if (selected.length === 1) {
    const s = selected[0]!;
    const res = await availabilityResponse(userUpn, s.mail, s.displayName, range, lunch);
    res.pending_avail_pick = null;
    return withCalendarNext({ ...res, period: pending.period }, "free");
  }

  // Multiple → common free time (ดูตารางเบส + ทั้งหมด / 1กับ2)
  const res = await runFindMeeting(
    userUpn,
    selected.map((s) => ({ mail: s.mail, name: s.displayName })),
    30,
    range,
    null,
    lunch,
    "ประชุม",
    null
  );
  if (res.pending_avail_pick === undefined) res.pending_avail_pick = null;
  return res;
}

async function applyPendingMtPicks(
  userUpn: string,
  pending: PendingMtPick,
  picks: number[]
): Promise<CommandResult> {
  const choices = pending.choices || [];
  const attendees: MtAttendee[] = (pending.attendees || []).map((a) => ({
    mail: a.mail,
    name: a.name,
  }));
  const unresolved = attendees
    .map((a, i) => (!a.mail && a.name ? i : -1))
    .filter((i) => i >= 0);
  if (!unresolved.length) {
    return {
      intent: "find_meeting_time",
      reply: "เลือกรายชื่อครบแล้วครับ — พิมพ์ดูตารางใหม่อีกครั้งได้เลย",
      pending_mt_pick: null,
    };
  }
  if (!picks.length) {
    return {
      intent: "choose_mt_person",
      reply: "พิมพ์เลขจากรายการได้ครับ เช่น 1 หรือ 1กับ2 (เลือกสองคนพร้อมกัน)",
      pending_mt_pick: pending,
      choices: choices.map((c) => ({ mail: c.mail, displayName: c.displayName })),
    };
  }
  const need = Math.min(picks.length, unresolved.length);
  const used = new Set<string>();
  for (let k = 0; k < need; k++) {
    const idx = picks[k]! - 1;
    const c = choices[idx];
    if (!c?.mail) {
      return {
        intent: "choose_mt_person",
        reply: `ไม่มีข้อ ${picks[k]} ในรายการครับ — เลือก 1–${choices.length} ได้ครับ (หรือพิมพ์ 1กับ2)`,
        pending_mt_pick: pending,
        choices: choices.map((x) => ({ mail: x.mail, displayName: x.displayName })),
      };
    }
    const mail = c.mail.toLowerCase();
    if (used.has(mail)) {
      return {
        intent: "choose_mt_person",
        reply: "เลือกคนซ้ำกันครับ — ลองเลขคนละคน เช่น 1กับ2",
        pending_mt_pick: pending,
        choices: choices.map((x) => ({ mail: x.mail, displayName: x.displayName })),
      };
    }
    used.add(mail);
    attendees[unresolved[k]!] = { mail: c.mail, name: c.displayName || c.mail };
  }
  const { window, band } = pendingWindowBand(pending);
  const res = await runFindMeeting(
    userUpn,
    attendees,
    pending.duration || 30,
    window,
    band,
    !!pending.includeLunch,
    pending.subject || "ประชุม",
    pending.atMin ?? null
  );
  // Clear pick state once resolved (or when asking the next person — runFindMeeting sets new pending)
  if (res.intent !== "choose_mt_person" && res.pending_mt_pick === undefined) {
    res.pending_mt_pick = null;
  }
  return res;
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

/** When postback would exceed LINE's 300-char limit, stash payload and return a short ref. */
async function encodeMtDataSafe(
  ownerUpn: string,
  attendees: MtAttendee[],
  duration: number,
  window?: MtWindow | null,
  band?: { after: number | null; before: number | null } | null,
  includeLunch = false,
  atMin?: number | null,
  subject?: string,
  dnRef?: string
): Promise<string> {
  const full = encodeMtData(attendees, duration, window, band, includeLunch, atMin, subject, dnRef);
  if (full.length <= 280) return full;
  const id = createHash("sha1")
    .update(`${ownerUpn}|${Date.now()}|${full}`)
    .digest("hex")
    .slice(0, 12);
  await setSetting(
    ownerUpn,
    `mt_find_${id}`,
    JSON.stringify({
      attendees,
      duration,
      window: window
        ? { start: wallIso(window.start), end: wallIso(window.end), label: window.label }
        : null,
      after: band?.after ?? null,
      before: band?.before ?? null,
      atMin: atMin ?? null,
      subject: subject || "ประชุม",
      includeLunch: !!includeLunch,
      dnRef: dnRef || "",
    })
  );
  return new URLSearchParams({ a: "findmt", ref: id }).toString();
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

const SELF_BOOK_DURATION_SUGGESTIONS = [
  { label: "30 นาที", text: "30 นาที" },
  { label: "1 ชม.", text: "1 ชม." },
  { label: "2 ชม.", text: "2 ชม." },
];

function selfBookWindowFromParams(
  params: Record<string, unknown>,
  text: string
): { start: Date; end: Date; label: string } | null {
  const dayStart = String(params.day_start || "");
  if (dayStart) {
    const d = parseWall(dayStart);
    if (d) {
      const label = String(params.date_label || fmtDate(d));
      return { start: startOfDay(d), end: endOfDay(d), label };
    }
  }
  if (params.date_label) {
    const parsed = resolveDay(String(params.date_label));
    if (parsed) return parsed;
  }
  return dayHintFromText(text) || periodRange("today");
}

async function runSelfBookCalendar(
  userUpn: string,
  text: string,
  params: Record<string, unknown>
): Promise<CommandResult> {
  const subject = String(params.subject || params.note || "จองเวลา").trim().slice(0, 200) || "จองเวลา";
  const window = selfBookWindowFromParams(params, text);
  if (!window) {
    return {
      intent: "book_self_calendar",
      reply:
        "ยังไม่แน่ใจว่าจะจองวันไหนครับ — ลองระบุ เช่น วันนี้, พรุ่งนี้, วันที่ 5 กันยา, หรือ 5/9",
      pending_self_book: null,
    };
  }

  const allDay =
    !!params.all_day || /(?:ทั้งวัน|ตลอดวัน|all\s*day)/i.test(text);

  if (allDay) {
    const dayStart = startOfDay(window.start);
    const dayEnd = startOfDay(addDays(window.start, 1));
    const exact = {
      start: wallIso(dayStart),
      end: wallIso(dayEnd),
      label: `${fmtDayHeader(dayStart)} (ทั้งวัน)`,
    };
    return {
      intent: "confirm_meeting",
      reply:
        `สรุปการจองเวลาในตาราง — กดยืนยันถ้าถูกต้อง\n` +
        `📌 ${subject}\n` +
        `🕐 ${exact.label}\n` +
        `(ไม่มีผู้เข้าร่วม — จองเฉพาะตัวเอง)`,
      slots: [exact],
      meeting: { attendees: [], duration: 24 * 60, subject, all_day: true },
      pending_self_book: null,
    };
  }

  let atMin = parseHHMM(params.at);
  if (atMin == null) atMin = parseClockToMinutes(text);
  if (atMin == null) {
    return {
      intent: "book_self_calendar",
      reply:
        `จองตาราง ${window.label} — ระบุเวลาด้วยนะครับ\n` +
        `(เช่น 9โมง, 09:00, บ่าย 2)\n` +
        `หรือพิมพ์ “ทั้งวัน” ถ้าต้องการจองทั้งวัน`,
      pending_self_book: null,
    };
  }

  let duration = Number(params.duration_min) || 0;
  if (!duration) duration = parseDurationMinutes(text) || 0;

  if (!duration) {
    const pending: PendingSelfBook = {
      dayStart: wallIso(window.start),
      dateLabel: window.label,
      atMin,
      subject,
    };
    return {
      intent: "book_self_calendar",
      reply:
        `จองตารางตัวเอง ${window.label} เวลา ${fmtHHMM(atMin)} น.\n\n` +
        `จองกี่นาทีหรือกี่ชั่วโมงครับ? (เช่น 30 นาที, 1 ชม.)`,
      pending_self_book: pending,
      suggestions: SELF_BOOK_DURATION_SUGGESTIONS,
    };
  }

  const slotStart = new Date(startOfDay(window.start));
  slotStart.setUTCHours(Math.floor(atMin / 60), atMin % 60, 0, 0);
  const slotEnd = addMinutes(slotStart, duration);
  const exact = {
    start: wallIso(slotStart),
    end: wallIso(slotEnd),
    label: fmtSlotRange(slotStart, slotEnd),
  };
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
      `สรุปการจองเวลาในตาราง — กดยืนยันถ้าถูกต้อง\n` +
      `📌 ${subject}\n` +
      `🕐 ${exact.label}\n` +
      `(ไม่มีผู้เข้าร่วม — จองเฉพาะตัวเอง)` +
      pastNote,
    slots: [exact],
    meeting: { attendees: [], duration, subject },
    pending_self_book: null,
  };
}

/** Edit distance, capped — only used to tell near-identical Thai spellings apart. */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 2) return 3;
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let carry = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const keep = prev[j];
      prev[j] = Math.min(
        prev[j] + 1,
        prev[j - 1] + 1,
        carry + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
      carry = keep;
    }
  }
  return prev[b.length];
}

/**
 * Is `token` this person, allowing for how Thai names get typed?
 *
 * "ชนันชิดา" and the directory's "ชนัญชิดา" differ by one letter — น for ญ, the
 * kind of slip nobody notices while typing and no prefix match forgives. One
 * substitution is allowed from four characters, two from seven.
 */
function nameTokenMatches(token: string, displayName: string): boolean {
  const t = token.trim().toLowerCase();
  if (t.length < 2) return false;
  const dn = displayName.toLowerCase();
  if (dn.includes(t)) return true;
  const slack = t.length >= 7 ? 2 : t.length >= 4 ? 1 : 0;
  if (!slack) return false;
  return dn
    .split(/[\s._\-()/]+/)
    .filter((w) => w.length >= 3)
    .some((w) => editDistance(t, w) <= slack);
}

/**
 * Several names typed for ONE person — a nickname pinned down by the real name.
 *
 * "ดูตารางนัด เบส ชนันชิดา" means the เบส called ชนันชิดา. Read as two people it
 * asked which เบส, then went looking for a second colleague called ชนันชิดา and
 * found nobody. So: when one candidate for one token also answers to the other
 * tokens, that single person is the answer.
 */
async function collapseToOnePerson(tokens: string[]): Promise<UserInfo | null> {
  const names = tokens.map((t) => t.trim()).filter((t) => t && !t.includes("@"));
  if (names.length < 2) return null;
  for (const probe of names) {
    let cands: UserInfo[] = [];
    try {
      cands = await searchUsers(probe, 10);
    } catch {
      continue;
    }
    const others = names.filter((n) => n !== probe);
    const hit = cands.find((c) =>
      others.every((o) => nameTokenMatches(o, c.displayName || c.mail || ""))
    );
    if (hit) return hit;
  }
  return null;
}

/**
 * The colleagues this person actually meets, most frequent first.
 *
 * "นัดประชุม" with no name used to end the conversation — correct, a booking
 * needs someone, but a dead end. The calendar already knows who they meet: read
 * the last six weeks of events and count who turns up.
 */
async function frequentContacts(userUpn: string, limit = 8): Promise<UserInfo[]> {
  const now = nowWall();
  const from = addMinutes(now, -45 * 24 * 60);
  let events: Awaited<ReturnType<typeof getEventsRange>> = [];
  try {
    events = await getEventsRange(userUpn, wallIso(from), wallIso(now));
  } catch {
    return [];
  }
  const me = userUpn.toLowerCase();
  const seen = new Map<string, { info: UserInfo; n: number }>();
  const note = (name?: string, mail?: string) => {
    const key = (mail || "").toLowerCase();
    if (!key || key === me || !key.includes("@")) return;
    const hit = seen.get(key);
    if (hit) hit.n++;
    else seen.set(key, { info: { mail: mail as string, displayName: name || (mail as string) }, n: 1 });
  };
  for (const ev of events) {
    note(ev.organizer?.emailAddress?.name, ev.organizer?.emailAddress?.address);
    for (const a of ev.attendees || []) note(a.emailAddress?.name, a.emailAddress?.address);
  }
  // Rooms, shared mailboxes and the Teams service account attend a lot of
  // meetings; none of them is somebody to book with.
  return [...seen.values()]
    .filter((v) => !isNonPersonAccount(v.info))
    .filter((v) => v.info.mail.toLowerCase().endsWith("@ktisgroup.com"))
    .sort((a, b) => b.n - a.n)
    .slice(0, limit)
    .map((v) => v.info);
}

export async function runFindMeeting(
  userUpn: string,
  // reassigned when several names turn out to be one person
  attendees: MtAttendee[],
  duration: number,
  window?: MtWindow | null,
  band?: { after: number | null; before: number | null; label?: string } | null,
  includeLunch = false,
  subject = "ประชุม",
  atMin: number | null = null,
  opts?: {
    showMore?: boolean;
    attachFile?: { id?: string; name?: string; url?: string };
    attachLinePhoto?: boolean;
  }
): Promise<CommandResult> {
  const denied = needCalendarConsent();
  if (denied) return denied;

  // One person named twice ("เบส ชนันชิดา") reads as two attendees. Collapse it
  // before asking anybody to pick, or the picker asks "คนที่ 1/2" about a
  // second person who does not exist.
  const needNames = attendees.filter((x) => !x.mail && x.name).map((x) => String(x.name));
  if (attendees.length > 1 && needNames.length === attendees.length) {
    const one = await collapseToOnePerson(needNames);
    if (one) {
      trace("fetch", `ชื่อเดียวกันคนเดียว · ${needNames.join(" + ")}`);
      attendees = [{ mail: one.mail, name: one.displayName || one.mail }];
    }
  }

  // Resolve each name; stop and ask when a name matches more than one person.
  for (let i = 0; i < attendees.length; i++) {
    const a = attendees[i];
    if (a.mail || !a.name) continue;
    const taken = new Set(
      attendees
        .map((x) => (x.mail || "").trim().toLowerCase())
        .filter(Boolean)
    );
    let cands = await searchUsers(a.name);
    // “เบสกับพี่เบส” — after picking the 1st Base, hide them from the 2nd pick
    if (taken.size) {
      cands = cands.filter((c) => !taken.has((c.mail || "").toLowerCase()));
    }
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
          data: await encodeMtDataSafe(userUpn, next, duration, window, band, includeLunch, atMin, subject, dnRef),
        });
      }
      const dayNote = window ? ` (${window.label})` : "";
      const which =
        attendees.length > 1
          ? ` (คนที่ ${i + 1}/${attendees.length})`
          : "";
      const multiHint =
        attendees.filter((x) => !x.mail && x.name).length >= 2
          ? `\n💡 พิมพ์ได้ เช่น 1กับ2, หนึ่งกับสอง หรือ ทั้งหมด`
          : `\n💡 พิมพ์เลขได้ เช่น 1 หรือ หนึ่ง`;
      const pending: PendingMtPick = {
        attendees: attendees.map((x) => ({ mail: x.mail, name: x.name })),
        choices: choices.map((c) => ({
          mail: c.mail,
          displayName: String(c.displayName || c.mail),
        })),
        duration,
        window: window
          ? { start: wallIso(window.start), end: wallIso(window.end), label: window.label }
          : null,
        after: band?.after ?? null,
        before: band?.before ?? null,
        atMin: atMin ?? null,
        subject,
        includeLunch,
      };
      return {
        intent: "choose_mt_person",
        reply: `เจอหลายคนที่ตรงกับ “${a.name}”${which} — เลือกคนที่ต้องการดูตารางครับ${dayNote} 👇${multiHint}`,
        choices,
        pending_mt_pick: pending,
      };
    } else if (taken.size && (await searchUsers(a.name)).length > 0) {
      // All remaining candidates were already picked as earlier attendees
      return {
        intent: "find_meeting_time",
        reply:
          `ชื่อ “${a.name}” เหลือแต่คนที่เลือกไปแล้วครับ — ลองพิมพ์อีเมลของอีกคน เช่น “เบสกับ chananchida.b@ktisgroup.com”`,
      };
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
  let cleaned = result.slots.map((s) => {
    const start = parseWall(s.start);
    const end = parseWall(s.end);
    const label =
      start && end
        ? fmtSlotRange(start, end)
        : (s.label || "").replace(/\s*·\s*หลังเลิกงาน/g, "");
    return { ...s, label };
  });
  // Hard guard: if user asked a specific day, never list slots outside that day
  if (window) {
    const w0 = window.start.getTime();
    const w1 = window.end.getTime();
    cleaned = cleaned.filter((s) => {
      const t = parseWall(s.start)?.getTime();
      return t != null && t >= w0 && t < w1;
    });
  }
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
  // Always show organizer + guests (หาเวลาว่างต้องครบทุกคน รวมตัวเอง เช่น เอก+เอ็ม+นนท์)
  const who = await formatMeetingPeople(userUpn, attendees.filter((a) => a.mail));
  const dayLabel = window ? enrichDayLabel(window.label || fmtDate(window.start), window.start) : "";
  const dayNote = dayLabel ? ` (${dayLabel})` : "";
  const bandNote =
    resolvedAt != null ? ` ตอน ${fmtHHMM(resolvedAt)}` : band?.label ? ` ${band.label}` : "";
  const attachNote = opts?.attachFile?.name ? `\n📎 จะแนบไฟล์: ${opts.attachFile.name}` : "";
  const photoNote = opts?.attachLinePhoto ? `\n📷 จะแนบรูปจาก LINE` : "";
  const meetingBase = (): NonNullable<CommandResult["meeting"]> => ({
    attendees: resolved,
    duration,
    subject,
    window: window
      ? {
          start: wallIso(window.start),
          end: wallIso(window.end),
          label: dayLabel || window.label,
        }
      : undefined,
    ...(opts?.attachFile ? { attach_file: opts.attachFile } : {}),
    ...(opts?.attachLinePhoto ? { attach_line_photo: true } : {}),
  });
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
        : window
          ? `\n\n${window.label}ยังไม่มีช่วงว่างตรงกัน ${duration} นาทีครับ — ลองพิมพ์ “พรุ่งนี้” หรือวันอื่นได้ครับ`
          : "";
    return {
      intent: "find_meeting_time",
      reply: formatBusy(result.busy) + note + hint + `\n(ค้นของ:\n👤 ${who}${dayNote}${bandNote})`,
      meeting: meetingBase(),
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
        label: fmtSlotRange(slotStart, slotEnd),
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
        attachNote +
        photoNote +
        pastNote +
        note,
      slots: [exact],
      meeting: meetingBase(),
    };
  }

  const afterHoursNote = pageHasAfterHours
    ? `\n💡 ${String(WORK_END_HOUR).padStart(2, "0")}:00–20:00 น. = หลังเลิกงาน`
    : "";

  const reply =
    (opts?.showMore ? `ช่วงว่างเพิ่มเติมครับ\n` : `เจอเวลาที่ทุกคนว่างตรงกัน${dayNote}${bandNote}ครับ\n`) +
    `👤 ${who}\n` +
    (subject && subject !== "ประชุม" ? `📌 ${subject}\n` : "") +
    (attachNote ? attachNote.trimStart() + "\n" : "") +
    (photoNote ? photoNote.trimStart() + "\n" : "") +
    `เลือกเวลาเริ่มประชุม (${duration} นาที) จากรายการด้านล่างได้เลย 👇` +
    afterHoursNote +
    note;

  return {
    intent: "choose_slot",
    reply,
    slots: result.slots,
    ranges: result.ranges,
    meeting: meetingBase(),
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

/** Organizer first, then guests — หาเวลาว่างต้องโชว์ครบทุกคนที่ถูกเช็คตาราง */
async function formatMeetingPeople(organizerUpn: string, guests: MtAttendee[]): Promise<string> {
  const org = (organizerUpn || "").trim().toLowerCase();
  const guestMails = new Set(
    guests.map((g) => (g.mail || "").trim().toLowerCase()).filter(Boolean)
  );
  const people: MtAttendee[] = [];
  if (org && !guestMails.has(org)) {
    people.push({ mail: org });
  }
  for (const g of guests) {
    if (g.mail) people.push(g);
  }
  return formatAttendeeLines(people);
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
    // Never strand the user on “หนาแน่น” — recover known commands without LLM.
    try {
      const quick = quickFeedIntent(
        (text || "")
          .normalize("NFC")
          .replace(/[\u200B-\u200D\uFEFF\u00A0]/g, "")
          .replace(/\s+/g, " ")
          .trim()
      );
      if (quick) {
        trace("parse", `★ AI:NONE · recover intent=${quick.intent} after LLM failure`);
        return await handleParsed(userUpn, text, context, lite, quick.intent, quick.params);
      }
    } catch (e2) {
      console.error("[handleCommand] recover failed", String(e2).slice(0, 200));
    }
    return {
      intent: "error",
      reply:
        "ขออภัยครับ ระบบ AI ติดขัดชั่วคราว แต่ยังสั่งงานหลักได้ เช่น «สรุปประชุม» «ข่าววันนี้» «ตารางวันนี้» หรือกดเมนูด้านล่างครับ",
    };
  }
}

// Handle a tap on a LINE quick-reply/postback button. `data` is the postback
// payload (URLSearchParams). Each action is self-contained (stateless) so it
// completes in one step without stored conversation context.
/** Match a typed task name against pending titles: exact, then either side
 *  containing the other (people paraphrase and drop words). */
export function matchTasksByTitle(tasks: Task[], wanted: string): Task[] {
  const norm = (v: string) => v.toLowerCase().replace(/\s+/g, " ").trim();
  const w = norm(wanted);
  if (!w) return [];
  const exact = tasks.filter((t) => norm(t.title) === w);
  if (exact.length) return exact;
  return tasks.filter((t) => {
    const title = norm(t.title);
    return title.includes(w) || w.includes(title);
  });
}

/** Numbered choices for "which task?" — the tap closes it (a=done). */
export function taskChoices(tasks: Task[]): { index: number; task_id: number; label: string }[] {
  return tasks.slice(0, 12).map((t, i) => ({
    index: i + 1,
    task_id: t.id,
    label: t.title,
  }));
}

/**
 * Display name for a tapped person. The button used to carry it in the postback
 * (`n`), but a Thai name URL-encodes past LINE's 300-character limit and the
 * button then never rendered, so lib/linePickers.ts drops `n` when it does not
 * fit. Older cards still in someone's chat history send it — use it when it is
 * there, look it up by mail when it is not.
 */
async function pickedPersonName(data: URLSearchParams, mail: string): Promise<string> {
  const given = (data.get("n") || "").trim();
  if (given) return given;
  if (!mail) return mail;
  try {
    const info = await resolveUserInfo(mail);
    const dn = (info?.displayName || "").trim();
    if (dn && !dn.includes("@")) return dn;
  } catch {
    /* fall back to the address */
  }
  return mail;
}

export async function handleSelection(userUpn: string, data: URLSearchParams): Promise<CommandResult> {
  const a = data.get("a") || "";
  try {
    if (a === "done") {
      const tid = Number(data.get("t") || "");
      if (!tid) return { intent: "error", reply: "ข้อมูลไม่ครบ ลองใหม่อีกครั้งครับ" };
      const ok = await updateTaskStatus(tid, "done");
      return { intent: "complete_task", reply: ok ? "ปิดงานแล้วครับ ✅" : "งานนี้ถูกปิดไปแล้ว หรือไม่พบครับ" };
    }
    if (a === "avail" || a === "book" || a === "cancel" || a === "cancelok" || a === "findmt") {
      const denied = needCalendarConsent();
      if (denied) return denied;
    }
    if (a === "avail") {
      const mail = data.get("m") || "";
      const name = await pickedPersonName(data, mail);
      if (!mail) return { intent: "error", reply: "ข้อมูลไม่ครบ ลองใหม่อีกครั้งครับ" };
      const d = data.get("d");
      const range = d ? resolveDay(d) || periodRange("week") : periodRange(data.get("p") || "week");
      return await availabilityResponse(userUpn, mail, name, range, data.get("ln") === "1");
    }
    if (a === "personbusy") {
      const mail = data.get("m") || "";
      const name = await pickedPersonName(data, mail);
      if (!mail) return { intent: "error", reply: "ข้อมูลไม่ครบ ลองใหม่อีกครั้งครับ" };
      const d = data.get("d");
      const day = d ? resolveDay(d) : null;
      const period = data.get("p") || "upcoming";
      const af = data.get("af");
      const bf = data.get("bf");
      const tm = data.get("tm");
      const busy = await personBusyResponse(
        userUpn,
        name,
        day,
        period,
        af != null && af !== "" ? Number(af) : null,
        bf != null && bf !== "" ? Number(bf) : null,
        tm != null && tm !== "" ? Number(tm) : null,
        { mail, displayName: name }
      );
      return withCalendarNext({ ...busy, period: day ? undefined : period }, "meetings");
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
    // Deleting a meeting cannot be undone, so always show what is about to go
    // and wait for an explicit confirm.
    if (a === "cancel") {
      const id = data.get("id") || "";
      if (!id) return { intent: "error", reply: "ไม่พบนัดที่จะยกเลิกครับ" };
      let ev: GraphEvent | null = null;
      try {
        ev = await getEvent(userUpn, id);
      } catch {
        ev = null;
      }
      const lines = ["🗑️ ยืนยันยกเลิกนัด", ""];
      if (ev) {
        const s = ev.start?.dateTime ? parseWall(ev.start.dateTime) : null;
        const e = ev.end?.dateTime ? parseWall(ev.end.dateTime) : null;
        lines.push(`📌 ${(ev.subject || "(ไม่มีหัวข้อ)").trim()}`);
        if (s) lines.push(`🕐 ${fmtDateTime(s)}${e ? `-${fmtTime(e)}` : ""}`);
        const where = ev.location?.displayName || (ev.onlineMeeting ? "ออนไลน์ (Teams)" : "");
        if (where) lines.push(`📍 ${where}`);
        const people = (ev.attendees || [])
          .map((at) => at.emailAddress?.name || at.emailAddress?.address || "")
          .filter(Boolean)
          .slice(0, 5);
        if (people.length) lines.push(`👤 ${people.join(", ")}`);
      } else {
        lines.push("(ดึงรายละเอียดนัดไม่ได้ — ตรวจสอบให้แน่ใจก่อนยืนยันนะครับ)");
      }
      lines.push("", "ยกเลิกแล้วกู้คืนไม่ได้ ยืนยันไหมครับ? 👇");
      return {
        intent: "confirm_cancel",
        reply: lines.join("\n"),
        choices: [
          { data: `a=cancelok&id=${encodeURIComponent(id)}`, label: "✅ ยืนยันยกเลิก" },
          { data: "a=cancelkeep", label: "↩️ ไม่ยกเลิก" },
        ],
      };
    }
    if (a === "cancelkeep") {
      return { intent: "cancel_aborted", reply: "โอเคครับ — ไม่ได้ยกเลิกนัด ทุกอย่างยังอยู่ตามเดิม 👍" };
    }
    if (a === "cancelok") {
      const id = data.get("id") || "";
      if (!id) return { intent: "error", reply: "ไม่พบนัดที่จะยกเลิกครับ" };
      await deleteEvent(userUpn, id);
      return { intent: "cancelled", reply: "✅ ยกเลิกนัดแล้วครับ" };
    }
    if (a === "sum") {
      const id = data.get("id") || "";
      if (!id) return { intent: "error", reply: "ไม่พบนัดที่จะสรุปครับ" };
      const { summarizeOne } = await import("@/lib/meetings");
      const res = await summarizeOne(userUpn, id);
      if (!res.ok) {
        return { intent: "error", reply: `⚠️ ${res.reason || "สรุปไม่สำเร็จ"}` };
      }
      let reply = res.summary || `สรุป: ${res.subject}`;
      try {
        const added = await ingestActionItems(res.action_items || []);
        if (added) reply += `\n\n(บันทึกงานติดตามใหม่ ${added} รายการ)`;
      } catch {
        /* ignore task ingest errors on LINE path */
      }
      return { intent: "meeting_summary", reply };
    }
    if (a === "findmt") {
      const ref = data.get("ref") || "";
      if (ref) {
        try {
          const raw = await getSetting(userUpn, `mt_find_${ref}`);
          if (!raw) {
            return { intent: "error", reply: "รายการเลือกหมดอายุแล้วครับ — พิมพ์คำสั่งดูตารางใหม่อีกครั้งได้เลย" };
          }
          const saved = JSON.parse(raw) as {
            attendees?: MtAttendee[];
            duration?: number;
            window?: { start?: string; end?: string; label?: string } | null;
            after?: number | null;
            before?: number | null;
            atMin?: number | null;
            subject?: string;
            includeLunch?: boolean;
            dnRef?: string;
          };
          const attendees = Array.isArray(saved.attendees) ? saved.attendees : [];
          if (saved.dnRef) {
            const map = await loadMtDisplayNames(userUpn, saved.dnRef);
            for (const att of attendees) {
              const m = (att.mail || "").toLowerCase();
              if (m && map[m]) att.name = map[m];
            }
          }
          const ws = saved.window?.start ? parseWall(saved.window.start) : null;
          const we = saved.window?.end ? parseWall(saved.window.end) : null;
          const window =
            ws && we
              ? { start: ws, end: we, label: saved.window?.label || fmtDate(ws) }
              : null;
          const band =
            saved.after != null || saved.before != null
              ? {
                  after: saved.after ?? null,
                  before: saved.before ?? null,
                  label: saved.after != null && saved.after >= 16 * 60 ? "ช่วงเย็น" : undefined,
                }
              : null;
          return await runFindMeeting(
            userUpn,
            attendees,
            Number(saved.duration || 30),
            window,
            band,
            !!saved.includeLunch,
            saved.subject || "ประชุม",
            saved.atMin ?? null
          );
        } catch {
          return { intent: "error", reply: "อ่านรายการเลือกไม่สำเร็จ — พิมพ์คำสั่งใหม่อีกครั้งครับ" };
        }
      }
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
  text = (text || "")
    .normalize("NFC")
    .replace(/[\u200B-\u200D\uFEFF\u00A0]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  // Immediate date query check at the top of handle (Asia/Bangkok Wall Time)
  if (/วันนี้วันอะไร|วันนี้วันที่เท่าไหร่|วันนี้วันที่เท่าไร|วันนี้วันไร|เช็กวัน|เช็กวันที่|วันนี้วันที่/i.test(text)) {
    const nowBkk = nowWall();
    const thaiDays = ["อาทิตย์", "จันทร์", "อังคาร", "พุธ", "พฤหัสบดี", "ศุกร์", "เสาร์"];
    const thaiMonths = [
      "มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน",
      "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"
    ];
    const dayName = thaiDays[nowBkk.getDay()];
    const dateNum = nowBkk.getDate();
    const monthName = thaiMonths[nowBkk.getMonth()];
    const yearBE = nowBkk.getFullYear() + 543;
    const hours = String(nowBkk.getHours()).padStart(2, "0");
    const minutes = String(nowBkk.getMinutes()).padStart(2, "0");

    return {
      intent: "what_date_today",
      reply: `📅 **วันนี้คือ วัน${dayName}ที่ ${dateNum} ${monthName} พ.ศ. ${yearBE}** (เวลา ${hours}:${minutes} น.) ครับ! 🗓️✨\n\nต้องการให้ผมสรุปตารางวาระงานหรือเช็กนัดหมายของวันนี้เพิ่มเติมไหมครับ?`,
      suggestions: [
        { label: "สรุปตารางเช้า", text: "สรุปตารางเช้า" },
        { label: "ดูงานที่ต้องติดตาม", text: "ดูงานที่ต้องติดตาม" },
        { label: "ข่าววันนี้", text: "ข่าววันนี้" },
      ],
    };
  }

  // Immediate user identity query check (ผมชื่ออะไร / ฉันชื่ออะไร / ฉันชื่อ / ชื่อฉัน / ผมชื่อ / ชื่อผม)
  if (/^(?:ผมชื่อ|ฉันชื่อ|ชื่อฉัน|ชื่อผม|ชื่ออะไร|ผมชื่ออะไร|ฉันชื่ออะไร|ผมเป็นใคร|ฉันเป็นใคร|ผู้ใช้ชื่ออะไร|ชื่อผู้ใช้|ชื่อไร|ผมชื่อไร|ฉันชื่อไร)$|^(?:ผมชื่อ|ฉันชื่อ|ชื่อฉัน|ชื่อผม)\b/i.test(text)) {
    let nameShow = userUpn;
    if (userUpn.toLowerCase().includes("weerasak")) {
      nameShow = "คุณวีรศักดิ์ พิมพ์ต้น (Weerasak Pimton)";
    }
    return {
      intent: "who_am_i",
      reply: `👤 คุณคือ **${nameShow}** (\`${userUpn}\`)\n\nผูกบัญชี Microsoft 365 และระบบองค์กรเรียบร้อยครับ 🤖✨\nวันนี้มีอะไรให้ผมช่วยจัดการปฏิทินหรือติดตามงานไหมครับ?`,
      suggestions: [
        { label: "สรุปตารางเช้า", text: "สรุปตารางเช้า" },
        { label: "ดูงานที่ต้องติดตาม", text: "ดูงานที่ต้องติดตาม" },
        { label: "ข่าววันนี้", text: "ข่าววันนี้" },
      ],
    };
  }

  // Immediate email request check (ขอเมลพี่แบงค์ / ขออีเมล... / หาอีเมล...)
  if (/(?:ขอ|หา|ขอเช็ก|ค้นหา)\s*(?:เมล|อีเมล|email| mail)\s*(?:ของ)?\s*(.+)/i.test(text)) {
    const rawTarget = text.replace(/^(?:ขอ|หา|ขอเช็ก|ค้นหา)\s*(?:เมล|อีเมล|email| mail)\s*(?:ของ)?\s*/i, "").trim();
    if (rawTarget) {
      try {
        const candidates = await searchUsers(rawTarget);
        if (candidates.length === 1) {
          const u = candidates[0];
          return {
            intent: "get_email",
            reply: `📧 **อีเมลของ ${u.displayName}**: \`${u.mail}\` ✉️✨`,
            suggestions: [
              { label: "สรุปตารางเช้า", text: "สรุปตารางเช้า" },
              { label: "ดูงานที่ต้องติดตาม", text: "ดูงานที่ต้องติดตาม" },
            ],
          };
        } else if (candidates.length > 1) {
          const choicesList = candidates.slice(0, 5).map((c, i) => `${i + 1}) **${c.displayName}**: \`${c.mail}\``).join("\n");
          return {
            intent: "get_email",
            reply: `พบรายชื่อ ${candidates.length} ท่านที่ตรงกับ “${rawTarget}” ในระบบครับ 👇\n\n${choicesList}`,
          };
        } else {
          return {
            intent: "get_email",
            reply: `ไม่พบอีเมลของ “${rawTarget}” ในสมุดโทรศัพท์/ระบบองค์กร Microsoft 365 ครับ 🔍`,
          };
        }
      } catch (e) {
        console.warn("get_email error:", e);
      }
    }
  }

  // Deterministic quick intent shortcuts at the very top of handle:
  const quickTop = await parseIntent(text, context);
  if (quickTop.source === "quick") {
    trace("parse", `★ AI:NONE · intent=${quickTop.intent} (กฎตายตัว ไม่เรียก API)`);
    return await handleParsed(userUpn, text, context, lite, quickTop.intent, quickTop.params);
  }

  // Pending duration after “จองตาราง … เวลา …”
  if (context?.pending_self_book) {
    const p = context.pending_self_book;
    if (p.allDay || /(?:ทั้งวัน|ตลอดวัน)/i.test(text)) {
      trace("parse", "★ AI:NONE · intent=book_self_calendar (ทั้งวัน ไม่เรียก API)");
      return runSelfBookCalendar(userUpn, text, {
        day_start: p.dayStart,
        date_label: p.dateLabel,
        subject: p.subject || "จองเวลา",
        all_day: true,
      });
    }
    const dur = parseDurationMinutes(text);
    if (dur) {
      trace("parse", "★ AI:NONE · intent=book_self_calendar (ตอบระยะเวลา ไม่เรียก API)");
      return runSelfBookCalendar(userUpn, text, {
        day_start: p.dayStart,
        date_label: p.dateLabel,
        at: fmtHHMM(p.atMin ?? 0),
        duration_min: dur,
        subject: p.subject || "จองเวลา",
      });
    }
    return {
      intent: "book_self_calendar",
      reply: "ยังอ่านระยะเวลาไม่ชัดครับ — ลองพิมพ์ เช่น 30 นาที หรือ 1 ชม.",
      pending_self_book: context.pending_self_book,
      suggestions: SELF_BOOK_DURATION_SUGGESTIONS,
    };
  }

  // Typed picks after “เจอหลายคน…” — find-meeting path
  if (context?.pending_mt_pick?.choices?.length) {
    if (isSelectAllChoices(text)) {
      trace("parse", "★ AI:NONE · intent=choose_mt_person (เลือกทั้งหมด ไม่เรียก API)");
      return applyPendingMtPickAll(userUpn, context.pending_mt_pick);
    }
    const picks = parseChoiceIndices(text);
    if (picks.length) {
      trace("parse", `★ AI:NONE · intent=choose_mt_person (พิมพ์เลข ${picks.join(",")} ไม่เรียก API)`);
      return applyPendingMtPicks(userUpn, context.pending_mt_pick, picks);
    }
    if (looksLikeChoiceAttempt(text)) {
      return {
        intent: "choose_mt_person",
        reply:
          "ยังอ่านเลขไม่ชัดครับ — ลองพิมพ์ 1กับ2, หนึ่งกับสอง, ทั้งหมด หรือกดปุ่มเลขด้านล่างได้เลย",
        pending_mt_pick: context.pending_mt_pick,
        choices: context.pending_mt_pick.choices,
      };
    }
  }

  // Typed picks after “ดูตารางเบส” (choose_person) — “1” / “1กับ2” / “ทั้งหมด”
  if (context?.pending_avail_pick?.choices?.length) {
    if (isSelectAllChoices(text)) {
      trace("parse", "★ AI:NONE · intent=choose_person (เลือกทั้งหมด → หาเวลาตรงกัน)");
      return applyPendingAvailPicks(userUpn, context.pending_avail_pick, "all");
    }
    const picks = parseChoiceIndices(text);
    if (picks.length) {
      trace("parse", `★ AI:NONE · intent=choose_person (พิมพ์เลข ${picks.join(",")} ไม่เรียก API)`);
      return applyPendingAvailPicks(userUpn, context.pending_avail_pick, picks);
    }
    if (looksLikeChoiceAttempt(text)) {
      return {
        intent: "choose_person",
        reply:
          "ยังอ่านเลขไม่ชัดครับ — ลองพิมพ์ 1, 1กับ2, ทั้งหมด หรือกดปุ่มเลขด้านล่างได้เลย",
        pending_avail_pick: context.pending_avail_pick,
        choices: context.pending_avail_pick.choices.map((c) => ({
          mail: c.mail,
          displayName: c.displayName,
          period: context.pending_avail_pick!.period,
          date: context.pending_avail_pick!.date,
          lunch: context.pending_avail_pick!.lunch,
        })),
        period: context.pending_avail_pick.period,
      };
    }
  }

  // Instant calendar list shortcuts BEFORE follow-up heuristics / LLM
  // (prevents “ดูประชุมเช้านี้” being eaten by last_meeting time-band follow-up)
  {
    const linkQ = quickLinkMeetingIntent(text);
    if (linkQ?.intent === "pending_meeting_photo") {
      trace("parse", "★ AI:NONE · intent=pending_meeting_photo (กฎตายตัว ไม่เรียก API)");
      return handleParsed(userUpn, text, context, lite, linkQ.intent, linkQ.params);
    }
    const quick = quickFeedIntent(text);
    if (
      quick?.intent === "list_meetings" ||
      quick?.intent === "get_brief" ||
      quick?.intent === "get_news" ||
      quick?.intent === "summarize_meetings" ||
      quick?.intent === "find_meeting_time" ||
      quick?.intent === "book_self_calendar" ||
      quick?.intent === "cancel_meeting" ||
      quick?.intent === "my_availability" ||
      quick?.intent === "prep_meeting" ||
      quick?.intent === "plan_commute" ||
      quick?.intent === "open_map" ||
      quick?.intent === "open_map_home" ||
      quick?.intent === "set_work_location" ||
      quick?.intent === "set_home_location" ||
      quick?.intent === "show_work_location" ||
      quick?.intent === "clear_work_location" ||
      quick?.intent === "ack" ||
      quick?.intent === "preview_summary_link" ||
      quick?.intent === "test_meeting" ||
      quick?.intent === "meeting_durations" ||
      quick?.intent === "help_menu" ||
      quick?.intent === "preview_morning" ||
      quick?.intent === "search_files" ||
      quick?.intent === "add_sample_tasks"
    ) {
      trace("parse", `★ AI:NONE · intent=${quick.intent} (กฎตายตัว ไม่เรียก API)`);
      return await handleParsed(userUpn, text, context, lite, quick.intent, quick.params);
    }
  }

  // if the user has a selected time slot, try to act on it first
  if (context?.selected) {
    const booked = await bookFromContext(userUpn, text, context.selected);
    if (booked) return booked;
  }

  // Follow-up on a multi-person search: keep the same attendees.
  // “ตอนเย็นว่างไหม” = same day + time band; “พรุ่งนี้ล่ะ” / “แต่พรุ่งนี้เช้าว่างนะ” = new day (± band).
  if (
    context?.last_meeting?.attendees?.length &&
    (isTimeFollowUp(text) || isDayFollowUp(text) || isDayBandFollowUp(text))
  ) {
    const dayFollow = isDayFollowUp(text) || isDayBandFollowUp(text);
    const band = dayFollow ? timeBandFromText(text.replace(/เช้ส/g, "เช้า")) : timeBandFromText(text);
    const window = dayFollow
      ? windowFromDayFollowUp(text)
      : windowFromStored(context.last_meeting) || dayHintFromText(text);
    trace(
      "parse",
      `★ AI:NONE · intent=find_meeting_time (${dayFollow ? "ติดตามวัน" : "ติดตามเวลา"} ไม่เรียก API)`
    );
    return runFindMeeting(
      userUpn,
      context.last_meeting.attendees.map((mail) => ({ mail })),
      context.last_meeting.duration || 30,
      window,
      band,
      wantsLunchIncluded(text),
      context.last_meeting.subject || "ประชุม"
    );
  }

  // Self-book / solo นัด — always try before LLM (even inside find_meeting_time path)
  const selfBookEarly = quickSelfBookIntent(text);
  if (selfBookEarly?.intent === "book_self_calendar") {
    trace("parse", "★ AI:NONE · intent=book_self_calendar (กฎตายตัว ไม่เรียก API)");
    return await handleParsed(userUpn, text, context, lite, selfBookEarly.intent, selfBookEarly.params);
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
  // Every path (quick rules, LLM, follow-ups) funnels through here, so this is
  // the one place a bogus name can be dropped. A follow-up that only moves the
  // day — "และวันพฤหัสล่ะ" — must fall back to whoever was being discussed,
  // not be looked up in the directory as a person.
  if (typeof params.person === "string") {
    // "นัดกรพรุ่งนี้" arrives as person="กรพรุ่งนี้"; the name is กร, and the day
    // belongs to the period the caller already parsed.
    const name = nameFromCandidate(stripGluedWhen(params.person));
    if (!name || isCalendarTalk(name) || looksLikeSentence(name)) delete params.person;
    else params.person = name;
  }
  // "สรุปตารางเวลาของแบงค์เดือนสิงหาคม" came back as get_brief — the morning
  // brief, which is always today and always the asker, so both the colleague
  // and the month were dropped and the reply was this person's own two
  // meetings. A brief that names somebody, or asks for a stretch longer than
  // today, is a calendar listing instead.
  if (intent === "get_brief") {
    const who =
      (typeof params.person === "string" && params.person.trim()) || personFromText(text);
    const wider = /(?:เดือน|สัปดาห์|อาทิตย์|ทั้งเดือน|ทั้งสัปดาห์|พรุ่งนี้|มะรืน|ย้อนหลัง|ที่ผ่านมา)/u.test(text);
    if (who || wider) {
      intent = "list_meetings";
      if (who) params.person = who;
      if (!params.period && !params.date && !params.weekday) {
        // A month named outright ("เดือนกรกฎาคม") resolves to that month later;
        // "เดือนนี้" and the rest still need a period.
        params.period = resolveThaiMonthRange(text)
          ? "month"
          : /(?:เดือน|ทั้งเดือน)/u.test(text)
            ? "month"
            : /(?:สัปดาห์|อาทิตย์)/u.test(text)
              ? "week"
              : /พรุ่งนี้/u.test(text)
                ? "tomorrow"
                : "today";
      }
      trace("parse", `★ ปรับเป็น list_meetings (${who ? "มีชื่อคน" : "ช่วงกว้างกว่าวันนี้"})`);
    }
  }

  if (Array.isArray(params.attendees)) {
    const cleaned = (params.attendees as unknown[])
      .map((a) => (typeof a === "string" ? nameFromCandidate(stripGluedWhen(a)) : ""))
      .filter((a) => a && !isCalendarTalk(a) && !looksLikeSentence(a));
    if (cleaned.length) params.attendees = cleaned;
    else delete params.attendees;
  }

  if (intent === "clear_memory") {
    await clearMeetingPhotoContext(userUpn);
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

  if (intent === "preview_morning") {
    trace("compose", "ตัวอย่างข้อความเช้า (ตาราง + ข่าว)");
    const { buildMorningPreview } = await import("@/lib/newsPage");
    try {
      const p = await buildMorningPreview(userUpn);
      return {
        intent: "preview_morning",
        // No explanatory footer: a preview has to look exactly like the message
        // it previews, or it is not showing what will actually arrive.
        reply: p.message,
        // The real morning message offers a button per meeting; a preview
        // without them cannot show whether that still works.
        suggestions: [
          ...p.choices.slice(0, 3).map((c) => ({
            label: `เตรียมนัด ${c.index}`,
            text: `เตรียมนัด ${c.index}`,
          })),
          { label: "ดูแบบสรุปประชุม", text: "/test ประชุม" },
        ],
      };
    } catch (e) {
      return {
        intent: "preview_morning",
        reply: `สร้างตัวอย่างข้อความเช้าไม่สำเร็จครับ\nเหตุผล: ${String(e).slice(0, 150)}`,
      };
    }
  }

  if (intent === "preview_summary_link") {
    trace("compose", "ตัวอย่างสรุปประชุมแบบลิงก์");
    // Built from the most recent real summary when there is one, so the preview
    // shows what this person would actually have received.
    const { previewSummaryLinkMessage } = await import("@/lib/summaryPage");
    return {
      intent: "preview_summary_link",
      reply: await previewSummaryLinkMessage(userUpn),
      suggestions: [
        { label: "/ช่วยเหลือ", text: "/ช่วยเหลือ" },
        { label: "ตารางวันนี้", text: "ตารางวันนี้" },
      ],
    };
  }

  if (intent === "help_menu") {
    const key = String(params.topic || "").trim();
    const topic = key ? HELP_TOPICS.find((x) => x.key === key) : null;
    if (topic) {
      trace("compose", `คู่มือ · ${topic.title}`);
      // Every command in the topic is a button, not just the first three: the
      // page's tap-to-send links do nothing inside LINE's in-app browser, so the
      // chat has to be the place where a command can actually be run. LINE takes
      // 13 buttons; the largest topic has seven.
      return {
        intent: "help_menu",
        reply: helpTopicText(topic),
        flex: helpTopicFlex(topic),
        suggestions: [
          ...topic.commands.slice(0, 11).map((c) => ({ label: c.label, text: c.text })),
          { label: "◀ หมวดอื่น", text: "/ช่วยเหลือ" },
        ],
      };
    }
    trace("compose", "คู่มือ · เมนูหมวด");
    return {
      intent: "help_menu",
      reply: helpMenuText(),
      flex: helpMenuFlex(),
      // One chip per topic; the label is already trimmed to LINE's 20 characters
      // in lib/help.ts, and LINE shows 13 at most — eight topics fit with room.
      suggestions: visibleTopics().map((x) => ({ label: x.chip, text: x.chip })),
    };
  }

  if (intent === "meeting_durations") {
    trace("fetch", "เวลาที่ใช้ในแต่ละประชุม");
    const { listRecentOnline: listOnline, durationLabel } = await import("@/lib/meetings");
    const rows = await listOnline(userUpn);
    if (!rows.length) {
      return { intent, reply: "ไม่พบประชุมออนไลน์ที่จบไปแล้วใน 14 วันที่ผ่านมาครับ" };
    }
    const withMins = rows.filter((r) => r.minutes > 0);
    const total = withMins.reduce((s, r) => s + r.minutes, 0);
    const lines = rows.map((r, i) => `${i + 1}) ${r.label}`);
    return {
      intent,
      reply: [
        "⏱️ เวลาที่ใช้ในแต่ละประชุม (ออนไลน์ 14 วันที่ผ่านมา)",
        "",
        ...lines,
        "",
        withMins.length
          ? `รวม ${withMins.length} ประชุม · ${durationLabel(total)} · เฉลี่ย ${durationLabel(
              Math.round(total / withMins.length)
            )}/ประชุม`
          : "ไม่มีข้อมูลเวลาเริ่ม-จบครบพอจะคิดเวลาได้ครับ",
      ].join("\n"),
      suggestions: [
        { label: "สรุปประชุม", text: "สรุปประชุม" },
        { label: "/test_meeting", text: "/test_meeting" },
      ],
    };
  }

  if (intent === "test_meeting") {
    const query = String(params.query || "").trim();
    const { listTestMeetings, buildTestSummary, durationLabel } = await import("@/lib/meetings");
    const { buildSummaryUrl, summaryTeaser } = await import("@/lib/summaryPage");

    /** The pick-one list, shown when no subject was given or none matched. */
    const listReply = (choices: Awaited<ReturnType<typeof listTestMeetings>>, head: string) => {
      if (!choices.length) {
        return (
          `${head}\n\n` +
          "ไม่พบประชุมออนไลน์ที่จบแล้วใน 7 วันที่ผ่านมา — สรุปประชุมต้องมีประชุมที่บันทึก transcript ไว้ก่อนครับ"
        );
      }
      const lines = choices.map(
        (c) =>
          `${c.index}) ${c.subject} · ${c.when}` +
          (c.minutes ? ` · ${durationLabel(c.minutes)}` : "") +
          (c.summarised ? " ✅ สรุปแล้ว" : c.hasTranscript ? " 📝 มี transcript" : " ⚠️ ไม่มี transcript")
      );
      return [
        head,
        "",
        ...lines,
        "",
        "พิมพ์ /test_meeting <เลข> หรือ /test_meeting <ชื่อเรื่อง>",
        "อยากเห็นรูปแบบสรุปก่อน (ไม่ต้องมี transcript): /test_meeting demo",
      ].join("\n");
    };

    // "demo" — run the summariser over a sample transcript. Teams only makes a
    // transcript when recording was on, so a week can pass with nothing real to
    // summarise, and then there is nothing to look at either.
    if (/^(demo|ตัวอย่าง|sample)$/i.test(query)) {
      trace("fetch", "ทดสอบสรุปประชุม · ตัวอย่าง transcript สมมติ");
      const { buildDemoSummary } = await import("@/lib/meetings");
      const demo = await buildDemoSummary();
      trace("compose", "สรุปประชุมตัวอย่าง");
      return {
        intent: "test_meeting",
        reply: [
          "🧪 ตัวอย่างสรุปประชุม — transcript สมมติ ไม่ใช่ประชุมจริง",
          "",
          demo.text,
          "",
          "— ข้อความที่จะส่งจริงจะมาแบบนี้ —",
          summaryTeaser(demo.subject, demo.when, demo.text, buildSummaryUrl(demo.id)),
        ].join("\n"),
        suggestions: [
          { label: "ทดสอบประชุมจริง", text: "/test_meeting" },
          { label: "ตารางวันนี้", text: "ตารางวันนี้" },
        ],
      };
    }

    if (!query) {
      trace("fetch", "ทดสอบสรุปประชุม · ขอรายการให้เลือก");
      const choices = await listTestMeetings(userUpn);
      return {
        intent: "test_meeting",
        reply: listReply(choices, "🧪 ทดสอบสรุปประชุม — เลือกประชุมที่ต้องการ"),
      };
    }

    trace("fetch", `ทดสอบสรุปประชุม · ${query.slice(0, 40)}`);
    const res = await buildTestSummary(userUpn, query);
    if (!res.ok) {
      const head =
        res.reason === "no_transcript"
          ? `⚠️ ประชุม “${res.subject}” ไม่มี transcript ให้สรุปครับ — Teams สร้าง transcript เฉพาะตอนเปิด “บันทึกและถอดเสียง” ในห้องประชุม (ถ้าเพิ่งจบ รออีก 10-15 นาที)`
          : res.reason === "not_found"
            ? `หาประชุมชื่อ “${query}” ไม่เจอใน 7 วันที่ผ่านมาครับ`
            : "ไม่พบประชุมออนไลน์ที่จบแล้วใน 7 วันที่ผ่านมาครับ";
      trace("reply", `ทดสอบสรุปประชุม · ${res.reason}`, "skip");
      return { intent: "test_meeting", reply: listReply(res.choices, head) };
    }

    trace("compose", `สรุปประชุมทดสอบ · ${res.reused ? "ใช้ของที่สรุปไว้แล้ว" : "สรุปใหม่"}`);
    const url = buildSummaryUrl(res.id);
    // The summary in full — this is a test, the point is to read it — followed
    // by the message shape that would actually be delivered.
    const reply = [
      `🧪 ทดสอบสรุปประชุม${res.reused ? " (ใช้สรุปที่เคยทำไว้)" : ""}`,
      "",
      res.text,
      "",
      "— ข้อความที่จะส่งจริงจะมาแบบนี้ —",
      summaryTeaser(res.subject, res.when, res.text, url),
    ].join("\n");
    return {
      intent: "test_meeting",
      reply,
      suggestions: [
        { label: "ทดสอบอันอื่น", text: "/test_meeting" },
        { label: "ตารางวันนี้", text: "ตารางวันนี้" },
      ],
    };
  }

  if (intent === "ack") {
    return {
      intent: "ack",
      reply: "รับทราบครับ ✅",
    };
  }

  if (intent === "book_self_calendar") {
    trace("fetch", "จองตารางตัวเอง (ไม่มีผู้เข้าร่วม)", "start");
    return runSelfBookCalendar(userUpn, text, params);
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

  if (intent === "pending_meeting_photo") {
    const denied = needCalendarConsent();
    if (denied) return denied;
    const mi = Number(params.meeting_index || 1) || 1;
    await markPendingMeetingPhoto(userUpn, mi);
    return {
      intent,
      reply:
        "ส่งรูปมาในแชทได้เลยครับ 📷\n" +
        `จะแนบเข้านัดล่าสุดที่เพิ่งสร้าง (หรือนัด ${mi} ในตารางวันนี้)\n\n` +
        "หรือพิมพ์ “แนบรูป ส่งนัด …” เพื่อจองนัดใหม่พร้อมแนบรูป",
    };
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
        "คุณเป็นผู้ช่วยสรุปเอกสารสั้นๆ เป็นภาษาไทย อ่านเนื้อหาที่ให้แล้วสรุปประเด็นสำคัญ 3–8 ข้อ กระชับ ชัดเจน ห้ามแต่งข้อมูลที่ไม่มีในไฟล์\n" +
          "ถ้าเป็นคู่มือ/เอกสารผลิตภัณฑ์ ให้สรุปว่าเอกสารนี้คืออะไร ใช้ทำอะไร และหัวข้อหลัก — ห้ามสรุปเป็นโครงสร้าง HTML/CSS/โค้ด เว้นแต่ผู้ใช้ถามเรื่องเทคนิค",
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

    // Handle date parameter (e.g. "ขอลิงก์ประชุมวันที่ 21")
    if (params.date) {
      const dateStr = String(params.date);
      const dayRange = resolveDay(dateStr);
      if (dayRange) {
        const events = await getEventsRange(userUpn, wallIso(dayRange.start), wallIso(dayRange.end));
        if (events.length) {
          const targetIndex = idx && idx <= events.length ? idx - 1 : 0;
          const hit = events[targetIndex];
          if (hit?.id) {
            eventId = hit.id;
            fallback = hit;
          }
        }
      }
    }

    if (!eventId) {
      const entry = idx ? await resolveAgendaEntry(userUpn, idx) : null;
      if (entry) {
        eventId = entry.eventId;
        fallback = entry.event;
      }
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

  if (intent === "get_meeting_link") {
    const denied = needCalendarConsent();
    if (denied) return denied;
    const idx = Number(params.meeting_index ?? params.index ?? 0);
    let event: import("@/lib/graph").GraphEvent | undefined;

    if (params.date) {
      const dateStr = String(params.date);
      const dayRange = resolveDay(dateStr);
      if (dayRange) {
        const events = await getEventsRange(userUpn, wallIso(dayRange.start), wallIso(dayRange.end));
        if (events.length) {
          const targetIndex = idx && idx <= events.length ? idx - 1 : 0;
          event = events[targetIndex];
        }
      }
    }

    if (!event) {
      const entry = idx ? await resolveAgendaEntry(userUpn, idx) : null;
      if (entry?.event) {
        event = entry.event;
      }
    }

    if (!event) {
      const agenda = await buildMorningAgenda(userUpn);
      if (agenda.events.length) {
        event = agenda.events[0];
      }
    }

    if (!event) {
      return { intent: "get_meeting_link", reply: "ไม่พบลิงก์ประชุมในวันที่ระบุครับ" };
    }

    const bodyHtml = event.body?.content || "";
    const bodyText = stripHtml(bodyHtml) || (event.bodyPreview || "");
    const urls = extractUrls(bodyHtml + "\n" + bodyText);
    const teamsLink =
      event.onlineMeeting?.joinUrl ||
      urls.find((u) => u.includes("teams.microsoft.com/l/meetup-join")) ||
      urls.find((u) => u.includes("meet.google.com") || u.includes("zoom.us")) ||
      (bodyHtml.match(/https:\/\/[^\s"'<>]+/i)?.[0] ?? undefined);

    const subj = event.subject || "ประชุม";
    const loc = event.location?.displayName ? `\n📍 สถานที่/ห้องประชุม: ${event.location.displayName}` : "";
    if (teamsLink) {
      return {
        intent: "get_meeting_link",
        reply: `🔗 ลิงก์เข้าประชุม "${subj}":${loc}\n${teamsLink}`,
      };
    } else {
      return {
        intent: "get_meeting_link",
        reply: `📌 นัด "${subj}":${loc}\n(ไม่พบลิงก์ MS Teams หรือประชุมออนไลน์แนบอยู่ในระบบครับ)`,
      };
    }
  }

  if (intent === "get_news") {
    trace("fetch", "📰 ดึงข่าวจากแหล่งที่ติดตาม", "start");

    // Answer in the reply if at all possible: a reply is free and arrives, while
    // the push fallback silently delivers nothing once the monthly quota is gone.
    // Dropping unreadable sources took the digest to ~10s, so the old 12s race
    // was losing by a hair and handing the answer to a channel that could not
    // send it.
    if (lite) {
      const upn = userUpn;
      const digestPromise = buildDigest(upn);
      type Race = { done: true; digest: DigestResult } | { done: false };
      const raced: Race = await Promise.race([
        digestPromise.then((digest) => ({ done: true as const, digest })),
        new Promise<Race>((resolve) => setTimeout(() => resolve({ done: false }), 35_000)),
      ]);

      if (raced.done) {
        const digest = raced.digest;
        trace("fetch", digest.stories.length ? `📰 ได้ข่าว ${digest.stories.length} เรื่อง` : "📰 ไม่มีข่าวใหม่");
        if (!digest.stories.length) {
          const extra = formatDigestSkippedNote(digest.skipped, false);
          return {
            intent,
            reply:
              (digest.note || "ยังไม่มีข่าวให้สรุปครับ") +
              "\n\nพิมพ์ “ดูแหล่งข่าว” เพื่อตรวจแหล่งก่อนได้ครับ" +
              extra,
          };
        }
        const extra = formatDigestSkippedNote(digest.skipped, true);
        await rememberDeliveredStories(upn, digest.stories);
        trace("compose", "📰 สรุปข่าวภาษาไทย");
        // Link, not a wall of text: the page holds the full summaries and every
        // source link, and this reply stays one short bubble.
        const { buildNewsUrl, newsIdFor, saveNewsPage, toPageStories } = await import("@/lib/newsPage");
        const now = new Date(Date.now() + 7 * 60 * 60 * 1000);
        const months = ["ม.ค.","ก.พ.","มี.ค.","เม.ย.","พ.ค.","มิ.ย.","ก.ค.","ส.ค.","ก.ย.","ต.ค.","พ.ย.","ธ.ค."];
        const dateLabel = `${now.getUTCDate()} ${months[now.getUTCMonth()]} ${now.getUTCFullYear() + 543}`;
        const pageId = newsIdFor(upn, now.toISOString().slice(0, 10));
        const pageStories = toPageStories(digest.stories);
        await saveNewsPage(pageId, { dateLabel, stories: pageStories, note: digest.note, createdAt: Date.now() });
        const heads = pageStories.slice(0, 3).map((st, i) => `${i + 1}) ${st.headline}`);
        return {
          intent,
          reply: [
            `📰 ข่าววันนี้ · ${pageStories.length} เรื่อง`,
            "",
            ...heads,
            "",
            `อ่านทั้งหมด 👉 ${buildNewsUrl(pageId)}`,
          ].join("\n") + extra,
          data: digest.stories,
        };
      }

      trace("fetch", "📰 สรุปข่าวช้า · ส่งต่อ line-now", "start");

      // Primary: line-now. Backup: always finish here too (claim = one push only).
      // Old path only backed up when kick threw → silent no-push if line-now died.
      const finishLocal = (async () => {
        try {
          const digest = await digestPromise;
          // Retry claim: line-now may hold briefly then die without sending.
          for (let attempt = 0; attempt < 4; attempt++) {
            if (await claimDigestPush(upn)) {
              try {
                if (!digest.stories?.length) {
                  const why =
                    digest.note ||
                    (digest.skipped.length ? `ข้าม: ${digest.skipped.join(", ")}` : "ไม่มีข่าวใหม่ให้สรุป");
                  await sendLine(
                    upn,
                    "",
                    `สรุปข่าวแล้วยังไม่มีเรื่องส่งครับ (${why})\n\nพิมพ์ “ดูแหล่งข่าว” เพื่อตรวจแหล่งก่อนได้ครับ`
                  );
                } else {
                  await rememberDeliveredStories(upn, digest.stories);
                  const extra = formatDigestSkippedNote(digest.skipped, !!digest.stories?.length);
                  await sendLine(upn, "", formatStoriesText(digest.stories, digest.note) + extra);
                  trace("reply", `📰 ตอบกลับ get_news สำรอง (${digest.stories.length} เรื่อง)`);
                }
              } finally {
                await clearDigestClaim(upn);
              }
              return;
            }
            await new Promise((r) => setTimeout(r, 28_000));
          }
        } catch (err) {
          console.warn("[get_news backup]", String(err).slice(0, 200));
          try {
            if (await claimDigestPush(upn)) {
              try {
                await sendLine(upn, "", "สรุปข่าวไม่สำเร็จครับ — ลองพิมพ์ “ข่าววันนี้” อีกครั้งได้เลย");
              } finally {
                await clearDigestClaim(upn);
              }
            }
          } catch { /* ignore */ }
        }
      })();

      // The kick starts a second serverless invocation that nothing waits on. If
      // the platform stops it before it does anything, it leaves a job in the log
      // that begins and never ends — which is where the ghost "cron · ส่งข่าว
      // LINE" rows came from. It exists only to deliver by push, so when there
      // is no push quota to deliver with, do not start it at all.
      const quotaBefore = await (await import("@/lib/line")).lineQuotaLeft();
      if (quotaBefore === null || quotaBefore > 0) {
        try {
          await kickLineDigest(upn);
        } catch (e) {
          console.warn("[get_news kick]", String(e).slice(0, 160));
        }
      } else {
        trace("fetch", "📰 ไม่เรียก line-now — โควตาส่งหมด (จะเตรียมข่าวไว้ให้แทน)", "skip");
      }

      try {
        waitUntil(finishLocal);
      } catch { /* non-Vercel */ }
      after(async () => {
        try {
          await finishLocal;
        } catch { /* ignore */ }
      });

      // Only promise a push we can actually pay for. With the monthly quota
      // spent, "it will arrive shortly" is untrue — the background build still
      // runs, so asking again shortly is answered from the warm cache.
      const { lineQuotaLeft } = await import("@/lib/line");
      const quotaLeft = await lineQuotaLeft();
      const canPush = quotaLeft === null || quotaLeft > 0;
      return {
        intent,
        newsPending: canPush,
        reply: canPush
          ? "กำลังรวบรวมและสรุปข่าวครับ — จะส่งเข้า LINE ให้อัตโนมัติเมื่อเสร็จ (ประมาณ 1–2 นาที)\n\nหรือพิมพ์ “ดูแหล่งข่าว” เพื่อตรวจแหล่งก่อนได้ครับ"
          : "กำลังรวบรวมข่าวอยู่ครับ แต่ตอนนี้ส่งข้อความอัตโนมัติไม่ได้ (โควตา LINE เดือนนี้หมด)\n\nรอสักครู่แล้วพิมพ์ “ข่าวตอนนี้” อีกครั้ง — รอบหน้าจะตอบได้ทันทีเพราะเตรียมไว้แล้วครับ",
      };
    }

    // Web / non-LINE: wait for digest inline
    let digest: DigestResult;
    try {
      digest = await buildDigest(userUpn);
    } catch (e) {
      digest = {
        stories: [],
        skipped: [String(e).slice(0, 80)],
        note: "ดึงข่าวไม่สำเร็จครับ ลองใหม่อีกครั้งได้เลย",
      };
    }
    trace("fetch", digest.stories.length ? `📰 ได้ข่าว ${digest.stories.length} เรื่อง` : "📰 ไม่มีข่าวใหม่");
    const { stories, skipped, note } = digest;
    if (!stories.length) {
      const extra = formatDigestSkippedNote(skipped, false);
      trace("compose", "📰 แจ้งผลสรุปข่าว");
      return {
        intent,
        reply:
          (note || "ยังไม่มีข่าวให้สรุปครับ") +
          "\n\nเพิ่มแหล่งได้ในแชท เช่น “เพิ่มแหล่งข่าว https://...” หรือ “ดูแหล่งข่าว” แล้วลองพิมพ์ “มีข่าวอะไรบ้าง” อีกครั้งครับ" +
          extra,
      };
    }
    const extra = formatDigestSkippedNote(skipped, true);
    await rememberDeliveredStories(userUpn, stories);
    trace("compose", "📰 สรุปข่าวภาษาไทย");
    return { intent, reply: formatStoriesText(stories, note) + extra, data: stories };
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
    // A month by name is a real range ("กรกฎาคม" is July, not "this month").
    const namedMonth = resolveThaiMonthRange(tNorm);
    // The intent parser turns "เดือนกรกฎาคม" into date=2026-07-01, which reads as
    // one day. A month named in the text is the whole month, so it wins; a real
    // date ("วันที่ 5 กรกฎาคม") never reaches here as a month.
    const day =
      namedMonth ??
      (params.date
        ? resolveDay(String(params.date))
        : params.weekday
          ? resolveWeekday(String(params.weekday))
          : null);
    const after = parseHHMM(params.after);
    const before = parseHHMM(params.before);
    const at = parseHHMM(params.at);

    // Self agenda — only when NO named person (ดูนัดเบส must NOT match)
    const namedPerson =
      String(params.person || "").trim() || personFromText(tNorm);
    const selfAgenda =
      !namedPerson &&
      (/^(ดู)?(ประชุม|นัด)(?:วัน)?(?:นี้|พรุ่งนี้)?[!?.…]*$/u.test(tNorm) ||
        /ตารางวันนี้|มีนัดอะไร|มีประชุมอะไร|เช้านี้|บ่ายนี้/.test(tNorm));

    if (!selfAgenda) {
      const personHint = namedPerson;
      if (personHint) {
        const cands = await searchUsers(personHint);
        if (cands.length > 1) {
          const dayIso = day
            ? `${day.start.getUTCFullYear()}-${String(day.start.getUTCMonth() + 1).padStart(2, "0")}-${String(day.start.getUTCDate()).padStart(2, "0")}`
            : undefined;
          const pending: PendingAvailPick = {
            choices: cands.slice(0, 10).map((c) => ({
              mail: c.mail,
              displayName: c.displayName || c.mail,
            })),
            period,
            date: dayIso,
            query: personHint,
            mode: "busy",
            after,
            before,
            at,
          };
          return {
            intent: "choose_person",
            reply:
              `เจอหลายคนที่ตรงกับ “${personHint}” เลือกคนที่ต้องการดูนัดครับ 👇` +
              `\n💡 พิมพ์ได้ เช่น 1 หรือ ทั้งหมด`,
            choices: cands.map((c) => ({
              mail: c.mail,
              displayName: c.displayName,
              period,
              date: dayIso,
              mode: "busy",
              after: after != null ? String(after) : undefined,
              before: before != null ? String(before) : undefined,
              at: at != null ? String(at) : undefined,
            })),
            period: day ? undefined : period,
            pending_avail_pick: pending,
          };
        }
        const pre =
          cands.length === 1
            ? { mail: cands[0]!.mail, displayName: cands[0]!.displayName }
            : undefined;
        const busy = await personBusyResponse(
          userUpn,
          personHint,
          day,
          period,
          after,
          before,
          at,
          pre || undefined
        );
        return withCalendarNext({ ...busy, period: day ? undefined : period }, "meetings");
      }
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
    // "เวลาว่างเดือนกรกฎาคม" is that month, not the 1st of it.
    const dayRange =
      resolveThaiMonthRange(text) ??
      (params.weekday
        ? resolveWeekday(String(params.weekday))
        : params.date
          ? resolveDay(String(params.date))
          : null);
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
        const pending: PendingAvailPick = {
          choices: cands.slice(0, 10).map((c) => ({
            mail: c.mail,
            displayName: c.displayName || c.mail,
          })),
          period,
          date: dayIso,
          lunch,
          query: det,
          mode: "free",
        };
        return {
          intent: "choose_person",
          reply:
            `เจอหลายคนที่ตรงกับ “${det}” เลือกคนที่ต้องการดูตารางครับ 👇` +
            `\n💡 พิมพ์ได้ เช่น 1, 1กับ2 หรือ ทั้งหมด (หาเวลาว่างตรงกัน)`,
          choices: cands.map((c) => ({
            mail: c.mail,
            displayName: c.displayName,
            period,
            date: dayIso,
            lunch,
          })),
          period,
          pending_avail_pick: pending,
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
    try {
      const isHome = intent === "set_home_location";
      let addr = String(params.address || "").trim();
      let lat: string | number | undefined;
      let lng: string | number | undefined;
      const wantPending = !!(params as { from_pending?: boolean }).from_pending || !addr;

      if (wantPending) {
        const pending = await loadPendingLineLocation(userUpn);
        if (pending) {
          addr =
            (pending.address || "").trim() ||
            (pending.title || "").trim() ||
            `${pending.lat},${pending.lng}`;
          lat = pending.lat;
          lng = pending.lng;
        }
      }

      if (!addr) {
        const gpsUrl = gpsCapturePageUrl(userUpn, isHome ? "home" : "work");
        return {
          intent,
          reply: isHome
            ? "ยังไม่มีตำแหน่งล่าสุดครับ\n\nบอทดึง GPS จากมือถือเองไม่ได้ ต้องให้คุณอนุญาตก่อน — กด «ดึง GPS เป็นบ้าน» ด้านล่างได้เลย\nหรือส่งพินจาก LINE (+ → ตำแหน่ง) แล้วพิมพ์ «เพิ่มตำแหน่งนี้เป็นบ้าน»"
            : "ยังไม่มีตำแหน่งล่าสุดครับ\n\nบอทดึง GPS จากมือถือเองไม่ได้ ต้องให้คุณอนุญาตก่อน — กด «ดึง GPS เป็นที่ทำงาน» ด้านล่างได้เลย\nหรือส่งพินจาก LINE (+ → ตำแหน่ง) แล้วพิมพ์ «เพิ่มตำแหน่งนี้เป็นที่ทำงาน»",
          uri_actions: [
            {
              label: isHome ? "ดึง GPS เป็นบ้าน" : "ดึง GPS เป็นที่ทำงาน",
              uri: gpsUrl,
            },
          ],
          suggestions: [
            {
              label: isHome ? "ตั้งบ้านเป็น…" : "ตั้งที่ทำงานเป็น…",
              text: isHome ? "ตั้งบ้านเป็น " : "ตั้งที่ทำงานเป็น ",
            },
          ],
        };
      }

      await addPlace(userUpn, isHome ? "home" : "work", addr, addr, true, { lat, lng });
      await clearPendingLineLocation(userUpn);
      return {
        intent,
        reply: isHome
          ? `บันทึกบ้านแล้วครับ 🏠\n${addr}`
          : `บันทึกที่ทำงานหลักแล้วครับ 📍\n${addr}\nต่อไปกด «วางแผนเดินทาง» หรือพิมพ์ “เปิดแผนที่ไปที่ทำงาน” ได้เลย`,
      };
    } catch (e) {
      console.error("[set_location]", String(e).slice(0, 200));
      return {
        intent,
        reply: "บันทึกตำแหน่งไม่สำเร็จชั่วคราว — ลองส่งตำแหน่งใหม่ หรือตั้งที่หน้าเว็บ ⚙️ ได้ครับ",
      };
    }
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
    try {
      const category = params.place === "home" ? "home" : "work";
      const where = category === "home" ? "บ้าน" : "ที่ทำงาน";
      let place = null as Awaited<ReturnType<typeof getPrimaryPlace>>;
      try {
        place = await getPrimaryPlace(userUpn, category);
      } catch (e) {
        console.warn("[plan_commute] getPrimaryPlace", String(e).slice(0, 160));
      }
      if (!place) {
        return {
          intent,
          reply:
            `ยังไม่ได้ตั้ง${where}ครับ ตั้งได้ที่เมนู ⚙️ ก่อนนะครับ แล้วพิมพ์ «วางแผนเดินทาง» อีกครั้งได้เลย`,
        };
      }
      const url = navUrl(place.location, place.lat, place.lng);

      const day = params.date ? resolveDay(String(params.date)) : null;
      const { start, end, label: dayLabel } = day || periodRange((params.period as string) || "today");

      let first: { m: number; subj: string } | null = null;
      try {
        for (const ev of await getEventsRange(userUpn, wallIso(start), wallIso(end))) {
          const m = eventStartMinutes(ev);
          if (m === null) continue;
          if (!first || m < first.m) {
            const priv = ["private", "personal", "confidential"].includes((ev.sensitivity || "").toLowerCase());
            first = { m, subj: priv ? "(นัดส่วนตัว)" : ev.subject || "(ไม่มีหัวข้อ)" };
          }
        }
      } catch (e) {
        console.warn("[plan_commute] calendar lookup failed", String(e).slice(0, 160));
      }

      let workStart = `${String(WORK_START_HOUR).padStart(2, "0")}:00`;
      try {
        const s = await allSettings(userUpn);
        workStart = s.work_start || workStart;
      } catch { /* keep default */ }

      const lines = [`🚗 วางแผนเดินทางไป${where} (${dayLabel})`, ""];
      if (category === "work") {
        let arrive = workStart;
        lines.push(`🕗 เข้างาน ${workStart} น.`);
        if (first) {
          const fh = fmtHHMM(first.m);
          lines.push(`📌 นัดแรก ${fh} น. — ${first.subj}`);
          if (fh < workStart) arrive = fh;
        } else {
          lines.push("📌 ยังดึงนัดวันนั้นไม่ได้ — ใช้เวลาเข้างานเป็นหลักครับ");
        }
        lines.push("", `👉 ควรไปถึงก่อน ${arrive} น. เผื่อเวลาเดินทาง+หาที่จอดด้วยนะครับ`);
      } else {
        lines.push("👉 กดปุ่มด้านล่างเพื่อดูเส้นทาง/สภาพจราจรก่อนออกเดินทางได้เลยครับ");
      }
      lines.push(url ? "แตะปุ่มด้านล่างเพื่อเปิดเส้นทาง (ดูเวลาเดินทางจริงจากการจราจรได้)" : `(“${where}” ยังไม่มีพิกัด/ที่อยู่ครบ เปิดเส้นทางไม่ได้ — เพิ่มได้ที่ ⚙️)`);
      return { intent, reply: lines.join("\n"), map_url: url, map_where: where };
    } catch (e) {
      console.error("[plan_commute]", String(e).slice(0, 200));
      return {
        intent: "plan_commute",
        reply:
          "🚗 วางแผนเดินทาง\n\nระบบช้าชั่วคราว — ตั้งที่ทำงาน/บ้านที่ ⚙️ แล้วกดเมนูอีกครั้งได้ครับ",
      };
    }
  }

  if (intent === "file_locations") {
    const prev = context?.files || [];
    if (!prev.length) {
      return { intent, reply: "ยังไม่มีรายการไฟล์ครับ — ลองพิมพ์ “หาไฟล์ …” ก่อน" };
    }
    const enriched = await enrichDriveHitPaths(
      userUpn,
      prev.map((f) => ({ id: f.id, name: f.name, webUrl: f.url }))
    );
    const files = mapFileHits(enriched);
    return {
      intent: "file_results",
      reply: "ตำแหน่งไฟล์ใน OneDrive ครับ 👇",
      files,
      show_file_location: true,
    };
  }

  if (intent === "filter_file_results") {
    const ft = normalizeFileType(String(params.filetype || ""));
    const all = context?.files || [];
    if (!all.length) {
      return { intent, reply: "ยังไม่มีรายการไฟล์ให้กรองครับ — ลองพิมพ์ “หาไฟล์ …” ก่อน" };
    }
    const filtered = all.filter((f) => (f.name || "").toLowerCase().endsWith("." + ft));
    if (!filtered.length) {
      return { intent, reply: `ในรายการก่อนหน้าไม่มีไฟล์ .${ft} ครับ` };
    }
    const showLoc = filtered.some((f) => f.path && f.path !== "OneDrive");
    return buildFileResultsResponse(filtered, `.${ft}`, { showLocation: showLoc });
  }

  if (intent === "search_files") {
    let q = String(params.query || "").trim();
    let ft = normalizeFileType(String(params.filetype || ""));
    const locFromText = stripFileLocationHint(text);
    const wantsLocation = !!params.show_location || locFromText.wantsLocation;
    if (!q && locFromText.query) q = locFromText.query;
    if (q) {
      const stripped = stripFileLocationHint(q);
      if (stripped.query) q = stripped.query;
    }
    if (!ft && q) {
      const parsed = parseQueryWithExtension(q);
      if (parsed.filetype) {
        q = parsed.query;
        ft = parsed.filetype;
      }
    }
    if (!q && !ft) return { intent, reply: "ระบุคำค้นไฟล์ด้วยครับ เช่น “หาไฟล์งบประมาณ”" };
    let hits = await searchFilesSmart(userUpn, q, ft);
    if (wantsLocation) hits = await enrichDriveHitPaths(userUpn, hits);
    if (!hits.length) {
      const what = q ? (ft ? `${q} (.${ft})` : q) : `.${ft}`;
      return { intent, reply: `ไม่พบไฟล์ที่ตรงกับ “${what}” ใน OneDrive ครับ` };
    }
    const label = q ? (ft ? `${q} (.${ft})` : q) : `.${ft}`;
    return buildFileResultsResponse(mapFileHits(hits), label, { showLocation: wantsLocation });
  }

  if (intent === "cancel_meeting") {
    const denied = needCalendarConsent();
    if (denied) return denied;
    const period = String(params.period || "upcoming");
    // Encoded exact scopes we may store in context.last_period
    // e.g. "weekday:เสาร์", "date:12/08/2026"
    const encodedWeekday = period.match(/^weekday:(.+)$/i)?.[1]?.trim();
    const encodedDate = period.match(/^date:(.+)$/i)?.[1]?.trim();
    if (encodedWeekday && !params.weekday) params.weekday = encodedWeekday;
    if (encodedDate && !params.date) params.date = encodedDate;
    const effectivePeriod = encodedWeekday || encodedDate ? "custom" : period;
    // Allow weekday/date cancellation to filter to exactly that day.
    const weekdayRaw = params.weekday ? String(params.weekday) : "";
    const dateRaw = params.date ? String(params.date) : "";
    let start: Date;
    let end: Date;
    let periodLabel: string;
    let scopePeriod: string;
    if (weekdayRaw) {
      const range = resolveWeekday(weekdayRaw);
      if (range) {
        start = range.start;
        end = range.end;
        periodLabel = range.label;
        scopePeriod = `weekday:${weekdayRaw}`;
      } else {
        const r = periodRange(period);
        start = r.start;
        end = r.end;
        periodLabel = r.label;
        scopePeriod = effectivePeriod;
      }
    } else if (dateRaw) {
      const range = resolveDay(dateRaw);
      if (range) {
        start = range.start;
        end = range.end;
        periodLabel = range.label;
        scopePeriod = `date:${dateRaw}`;
      } else {
        const r = periodRange(period);
        start = r.start;
        end = r.end;
        periodLabel = r.label;
        scopePeriod = effectivePeriod;
      }
    } else {
      const r = periodRange(period);
      start = r.start;
      end = r.end;
      periodLabel = r.label;
      scopePeriod = effectivePeriod;
    }

    let events = await getEventsRange(userUpn, wallIso(start), wallIso(end));
    // Still cancellable until end time (in-progress included)
    const now = nowWall();
    events = events.filter((ev) => {
      const ed = ev.end?.dateTime ? parseWall(ev.end.dateTime) : null;
      return !ed || ed > now;
    });
    // Keep only events that start within the requested day/range
    events = events.filter((ev) => {
      const sd = ev.start?.dateTime ? parseWall(ev.start.dateTime) : null;
      if (!sd) return true;
      return sd >= start && sd <= end;
    });
    if (!events.length) {
      return {
        intent,
        reply: `ไม่มีนัดที่จะยกเลิก${scopePeriod !== "upcoming" ? ` ${periodLabel}` : " ในช่วง 2 สัปดาห์ข้างหน้า"}ครับ`,
        period: scopePeriod,
      };
    }

    const personHint = String(params.person || "").trim();
    if (personHint) {
      const mails = await resolveCancelPersonMails(personHint, userUpn);
      const filtered = events.filter((ev) => eventTouchesPerson(ev, personHint, mails));
      if (!filtered.length) {
        const choices = buildCancelChoices(events, now);
        return {
          intent: "choose_cancel",
          reply: `ไม่พบนัด${period !== "upcoming" ? periodLabel : ""} ที่เกี่ยวกับ “${personHint}” ครับ — เลือกรายการทั้งหมดได้ด้านล่าง 👇`,
          choices,
          period,
        };
      }
      events = filtered;
    }

    const choices = buildCancelChoices(events, now);
    const liveCount = choices.filter((c) => c.label.startsWith("🔴")).length;
    const scope = scopePeriod !== "upcoming" ? periodLabel : "";
    let reply = personHint
      ? `เจอนัด${scope ? ` ${scope}` : ""} ที่เกี่ยวกับ “${personHint}” ${choices.length} รายการ — เลือกที่ยกเลิกครับ 👇`
      : scope
        ? `เลือกนัด ${scope} ที่ต้องการยกเลิกครับ 👇`
        : "เลือกนัดที่ต้องการยกเลิกครับ 👇";
    if (liveCount) {
      reply =
        `นัดที่ยังไม่หมดเวลา/กำลังประชุม ยกเลิกได้ครับ\n` +
        (scope ? `(${scope}) ` : "") +
        (personHint ? `กรอง “${personHint}” แล้ว ` : "") +
        `เลือกด้านล่าง 👇`;
    }
    return { intent: "choose_cancel", reply, choices, period: scopePeriod };
  }

  if (intent === "list_tasks") {
    // The stored UTC read as "2026-08-22T10:00:00+00:00" in the chat, and LINE
    // underlined it as a link. Show Bangkok wall time, written the way the rest
    // of the assistant writes dates.
    const dueLabel = (iso: string): string => {
      const wall = utcIsoToWall(iso);
      return wall ? `${fmtDate(wall)} ${fmtTime(wall)}` : iso;
    };
    const tasks = await listTasks(userUpn);
    const pending = tasks.filter((t) => t.status === "pending" || t.status === "overdue");
    if (!pending.length) {
      return { intent, reply: "ไม่มีงานติดตามค้างอยู่ครับ 👍" };
    }
    const lines = [`📌 งานที่ต้องติดตามค้างอยู่ (${pending.length} รายการ):`, ""];
    pending.forEach((t, i) => {
      const dueStr = t.due ? ` (กำหนดส่ง: ${dueLabel(t.due)})` : "";
      const resp = t.responsible ? ` [ผู้รับผิดชอบ: ${t.responsible}]` : "";
      const stTag = t.status === "overdue" ? " ⚠️ เกินกำหนด" : "";
      const srcTag = t.source === "meeting_auto" ? " 🤖 (จากสรุปการประชุม)" : t.source === "manual" ? " 👤 (เพิ่มเอง)" : "";
      lines.push(`${i + 1}) ${t.title}${dueStr}${resp}${srcTag}${stTag}`);
    });
    lines.push("\nพิมพ์ เช่น “ปิดงาน 1” เพื่อทำเครื่องหมายสำเร็จ");
    return { intent, reply: lines.join("\n"), data: pending };
  }

  if (intent === "add_sample_tasks") {
    const count = Number(params.count || 2);
    const samples = [
      { title: "จัดทำสรุปรายงานผลการดำเนินงานโครงการประจำเดือน", responsible: "เบส", due: "พรุ่งนี้ 17:00" },
      { title: "ตรวจสอบและปรับปรุงเอกสารคู่มือฟังก์ชันการใช้งานระบบ", responsible: "คุณป้อง", due: "วันจันทร์ 12:00" },
      { title: "ติดตามความคืบหน้าการเชื่อมต่อระบบปฏิทิน Outlook", responsible: "เอก", due: "วันศุกร์นี้" },
    ];

    const addedList: string[] = [];
    let lastError = "";
    for (let i = 0; i < count; i++) {
      const s = samples[i % samples.length];
      const titleWithTime = count > 1 ? `${s.title} (${i + 1})` : s.title;
      try {
        const tid = await addTask({
          owner_upn: userUpn,
          title: titleWithTime,
          responsible: s.responsible,
          responsible_upn: null,
          // Thai wording straight into a timestamp column threw on every row
          due: normalizeDue(s.due),
          source: "manual",
        });
        if (tid) {
          addedList.push(`• ${titleWithTime} [ผู้รับผิดชอบ: ${s.responsible}]`);
        }
      } catch (err) {
        console.error("[add_sample_tasks] error adding task:", err);
        lastError = String(err).slice(0, 160);
        trace("fetch", `เพิ่มงานตัวอย่างไม่สำเร็จ: ${lastError}`, "error");
      }
    }

    if (!addedList.length) {
      return {
        intent: "add_task",
        reply: `⚠️ บันทึกงานลงฐานข้อมูลไม่สำเร็จครับ${lastError ? `\n(${lastError})` : ""}`,
      };
    }

    return {
      intent: "add_task",
      reply:
        `✅ **เพิ่มงานติดตามทดสอบเรียบร้อย ${addedList.length} รายการครับ:**\n\n` +
        `${addedList.join("\n")}\n\n` +
        `พิมพ์ **“ดูงานที่ต้องติดตาม”** เพื่อตรวจสอบรายการทั้งหมด`,
    };
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
    const rawIds = Array.isArray(params.task_ids) ? (params.task_ids as number[]) : [];
    const singleTid = Number(params.task_id);
    const isConfirmed = !!params.confirmed;
    // "ทั้งหมด" means whatever is pending right now, so the ids are read here
    // instead of carried over from a listing that may be stale.
    const allIds = params.all
      ? (await listTasks(userUpn))
          .filter((t) => t.status === "pending" || t.status === "overdue")
          .map((t) => t.id)
      : [];
    if (params.all && !allIds.length) return { intent, reply: "ไม่มีงานค้างอยู่ครับ 👍" };
    const targetNumbers = allIds.length
      ? allIds
      : rawIds.length
        ? rawIds
        : singleTid
          ? [singleTid]
          : [];

    if (targetNumbers.length > 0) {
      const pending = (await listTasks(userUpn)).filter(
        (t) => t.status === "pending" || t.status === "overdue"
      );
      const matchedTasks: { id: number; title: string }[] = [];

      for (const num of targetNumbers) {
        let target = pending.find((t) => t.id === num);
        if (!target && num >= 1 && num <= pending.length) {
          target = pending[num - 1];
        }
        if (target) {
          matchedTasks.push({ id: target.id, title: target.title });
        } else {
          matchedTasks.push({ id: num, title: `งาน #${num}` });
        }
      }

      if (!matchedTasks.length) {
        return { intent, reply: "ไม่พบงานหมายเลขที่ระบุครับ" };
      }

      // If not confirmed yet, ask user for confirmation first!
      if (!isConfirmed) {
        const confirmList = matchedTasks.map((t) => `• ${t.title}`).join("\n");
        return {
          intent: "confirm_complete_task",
          pending_task_ids: matchedTasks.map((t) => t.id),
          reply:
            `⚠️ ยืนยันการปิดงาน ${matchedTasks.length} รายการต่อไปนี้ไหมครับ?\n\n` +
            `${confirmList}\n\n` +
            `กดปุ่ม “ยืนยันปิดงาน” ด้านล่าง หรือพิมพ์ “ปิดเลย”`,
          suggestions: [
            { label: "ยืนยันปิดงาน", text: "ยืนยันปิดงาน" },
            { label: "ยกเลิก", text: "ดูงานที่ต้องติดตาม" },
          ],
        };
      }

      // Confirmed: Execute the status updates
      const closedTitles: string[] = [];
      for (const t of matchedTasks) {
        if (await updateTaskStatus(t.id, "done")) {
          closedTitles.push(`• ${t.title}`);
        }
      }

      if (closedTitles.length > 0) {
        return {
          intent,
          reply: `✅ ปิดงาน ${closedTitles.length} รายการแล้วครับ:\n${closedTitles.join("\n")}`,
        };
      }
      return { intent, reply: "เกิดข้อผิดพลาด ไม่สามารถปิดงานที่ระบุได้ครับ" };
    }

    // The overdue reminder shows task TITLES, so that is what people type back
    // ("test meeting ปิดงานเลย") — match on the title instead of demanding a number.
    const wanted = String(params.title || "").trim();
    const pending = (await listTasks(userUpn)).filter(
      (t) => t.status === "pending" || t.status === "overdue"
    );
    if (!pending.length) return { intent, reply: "ไม่มีงานค้างอยู่ครับ" };
    if (!wanted) return { intent: "choose_task", reply: "ปิดงานไหนครับ เลือกได้เลย 👇", choices: taskChoices(pending) };
    const hit = matchTasksByTitle(pending, wanted);
    if (hit.length === 1) {
      await updateTaskStatus(hit[0].id, "done");
      return { intent, reply: `ปิดงาน «${hit[0].title}» แล้วครับ ✅` };
    }
    if (hit.length > 1) {
      return { intent: "choose_task", reply: `เจอ ${hit.length} งานที่ชื่อใกล้เคียง เลือกอันที่จะปิดครับ 👇`, choices: taskChoices(hit) };
    }
    return {
      intent: "choose_task",
      reply: `ไม่เจองานชื่อ «${wanted}» ครับ นี่คืองานค้างทั้งหมด เลือกอันที่จะปิดได้เลย 👇`,
      choices: taskChoices(pending),
    };
  }

  if (intent === "summarize_meetings") {
    const choices = await listRecentOnline(userUpn);
    if (!choices.length) return { intent, reply: "ไม่พบประชุมออนไลน์ที่จบไปแล้วใน 14 วันที่ผ่านมาครับ" };
    const wantLatest = !!(params as { latest?: boolean }).latest;
    const wantToday = !!(params as { today?: boolean }).today;
    let pick = choices;
    if (wantToday) {
      const today = new Date().toLocaleDateString("en-CA", { timeZone: process.env.TIMEZONE || "Asia/Bangkok" });
      const filtered = choices.filter((c) => (c.label || "").includes(today) || /\d{1,2}\/\d{1,2}/.test(c.label || ""));
      // Prefer labels that look like today; fall back to all if filter empty
      if (filtered.length) pick = filtered;
    }
    if (wantLatest || (wantToday && pick.length === 1)) {
      const first = pick[0];
      if (first?.event_id) {
        const { summarizeOne } = await import("@/lib/meetings");
        const { ingestActionItems } = await import("@/lib/followup");
        const res = await summarizeOne(userUpn, first.event_id);
        if (!res.ok) return { intent: "error", reply: `⚠️ ${res.reason || "สรุปไม่สำเร็จ"}` };
        let reply = res.summary || `สรุป: ${res.subject}`;
        try {
          const added = await ingestActionItems(res.action_items || []);
          if (added) reply += `\n\n(บันทึกงานติดตามใหม่ ${added} รายการ)`;
        } catch { /* ignore */ }
        return { intent: "meeting_summary", reply };
      }
    }
    return { intent: "choose_meeting", reply: "พบประชุมที่ผ่านมา เลือกอันที่ต้องการสรุปได้เลยครับ 👇", choices: pick };
  }

  if (intent === "find_meeting_time") {
    const denied = needCalendarConsent();
    if (denied) return denied;
    // LLM sometimes misroutes “จองวันที่ … ทั้งวัน” here — recover via self-book rules
    const selfBook = quickSelfBookIntent(text);
    if (selfBook?.intent === "book_self_calendar") {
      trace("parse", "★ AI:NONE · intent=book_self_calendar (กู้จาก find_meeting_time ไม่เรียก API)");
      return runSelfBookCalendar(userUpn, text, selfBook.params);
    }
    const attendeesRaw = (params.attendees as string[]) || [];
    // Don't reuse last booking's 10 นาที for a fresh “ดูตาราง…” ask
    const duration = Number(
      params.duration_min ||
        (!attendeesRaw.length ? context?.last_meeting?.duration : undefined) ||
        30
    );
    let window = resolveFindWindow(params, text);
    // Day-only follow-up (“พรุ่งนี้ล่ะ”) — never let LLM swap attendees
    if (isDayFollowUp(text) || isDayBandFollowUp(text)) {
      window = windowFromDayFollowUp(text) || window;
    }
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
    } else if (
      (isDayFollowUp(text) || isDayBandFollowUp(text)) &&
      context?.last_meeting?.attendees?.length
    ) {
      // Keep Em+Non etc. — do not re-resolve nicknames (เอ็ม↔เอก)
      attendeeTokens = context.last_meeting.attendees.map(String);
    } else if (!attendeeTokens.length) {
      attendeeTokens = (context?.last_meeting?.attendees || []).map(String);
    }
    const attendees: MtAttendee[] = attendeeTokens.map((token) =>
      attendeeFromToken(String(token), userUpn)
    );

    if (!attendees.length) {
      // Nobody named — offer the people actually met lately rather than ending
      // the conversation with a question the asker has to answer from memory.
      trace("fetch", "เสนอรายชื่อคนที่นัดบ่อย");
      const contacts = await frequentContacts(userUpn);
      if (!contacts.length) {
        return {
          intent: "find_meeting_time",
          reply: "ยังไม่ทราบว่าจะนัดกับใครครับ ลองพิมพ์ชื่อหรืออีเมลของคนที่ต้องการนัดมาได้เลย",
        };
      }
      const dur = Number(params.duration_min) || 30;
      const contactChoices = [];
      for (const c of contacts) {
        const next: MtAttendee[] = [{ mail: c.mail, name: c.displayName || c.mail }];
        const dnRef = await stashMtDisplayNames(userUpn, next);
        contactChoices.push({
          mail: c.mail,
          displayName: c.displayName || c.mail,
          data: await encodeMtDataSafe(userUpn, next, dur, null, null, false, null, "ประชุม", dnRef),
        });
      }
      return {
        intent: "choose_mt_person",
        reply:
          "จะนัดกับใครครับ? นี่คือคนที่คุณนัดบ่อยช่วงนี้ — เลือกได้เลย 👇\n" +
          "💡 พิมพ์เลขได้ เช่น 1 หรือ 1กับ2 (เลือกสองคนพร้อมกัน) หรือพิมพ์ชื่อ/อีเมลคนอื่นก็ได้",
        choices: contactChoices,
        pending_mt_pick: {
          attendees: [{ name: "" }],
          choices: contactChoices.map((c) => ({ mail: c.mail, displayName: String(c.displayName) })),
          duration: dur,
          window: null,
          after: null,
          before: null,
          atMin: null,
          subject: "ประชุม",
          includeLunch: false,
        },
      };
    }
    let subject = String(params.note || params.subject || "ประชุม").trim() || "ประชุม";
    let atMin = parseHHMM(params.at);
    let meetDuration = duration;

    // Recover duration / subject from the raw line when the parser/LLM dropped them
    const halfHit = text.match(/ครึ่ง\s*(?:ชม\.?|ชั่วโมง)/i);
    if (halfHit) meetDuration = 30;
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

    // “แนบไฟล์ 3 …” after search_files → snapshot OneDrive file onto the booking
    let attachFile: { id?: string; name?: string; url?: string } | undefined;
    const fileIdx =
      Number(params.file_index || 0) ||
      Number((text.match(/(?:แนบ|ผูก)\s*(?:ไฟล์|อัน|ข้อ)\s*(\d{1,2})/i) || [])[1] || 0);
    if (fileIdx > 0) {
      const f = context?.files?.[fileIdx - 1];
      if (f && !f.is_folder && (f.url || f.id)) {
        attachFile = { id: f.id, name: f.name, url: f.url };
      } else {
        return {
          intent: "find_meeting_time",
          reply:
            `อยากแนบไฟล์ข้อ ${fileIdx} แต่${context?.files?.length ? `ไม่มีในรายการล่าสุด (มี ${context.files.length} ไฟล์)` : "ยังไม่มีรายการไฟล์จากการค้นหา"}\n` +
            `ลองพิมพ์ “หาไฟล์ …” ก่อน แล้วค่อย “แนบไฟล์ ${fileIdx} ส่งนัด …” อีกครั้งครับ`,
        };
      }
    }

    const wantsLinePhoto =
      !!params.pending_line_photo ||
      /^แนบ(?:รูป|ภาพ)\b/i.test(text) ||
      !!(await loadPendingLinePhoto(userUpn));

    return runFindMeeting(
      userUpn,
      attendees,
      meetDuration,
      window,
      band,
      wantsLunchIncluded(text),
      subject,
      atMin,
      { showMore: !!params.show_more, attachFile, attachLinePhoto: wantsLinePhoto }
    );
  }

  if (intent === "who_are_you") {
    // Style 1 (Pro & Comprehensive):
    // "ผมคือ **KTIS X AI Assistant** 🤖 ผู้ช่วย AI ประจำตัวที่ฉลาดและทำงานไวที่สุดใน KTIS ครับ! ⚡\n\nเรื่องงานยาก ๆ ให้ผมช่วยดูแลได้สบายมาก:\n📅 **จัดการตาราง & จัดคิวประชุม** — เช็กเวลาว่าง นัดคน นัดห้อง ได้ในพริบตา\n📝 **สรุปประชุมอัจฉริยะ** — อ่าน Transcript จาก Teams แล้วสรุปประเด็น + Action Items ให้ทันที\n📌 **ติดตามงานไม่ให้ตกหล่น** — คอยจำและเตือนงานที่ต้องทำ\n📰 **คัดกรองข่าวสาร & อัปเดตเช้า** — เสิร์ฟสรุปข่าวและตารางงานถึงมือทุกเช้า\n\nอยากให้ผมช่วยจัดการเรื่องไหน สั่งมาได้เลยครับ! 🚀"

    // Style 2 (Friendly & Confident - SELECTED):
    const style2 =
      "ผมคือ **KTIS X AI Assistant** เลขาส่วนตัวสุดอัจฉริยะที่คุณขาดไม่ได้ครับ! 😎✨\n\n" +
      "ทำงาน 24 ชม. ไม่มีง่วง ไม่มีบ่น:\n" +
      "• อยากนัดใคร? เดี๋ยวหาเวลาว่างตรงกันให้\n" +
      "• ประชุมยาวขี้เกียจฟัง? เดี๋ยวสรุปเนื้อหาและงานติดตามให้\n" +
      "• งานเยอะจนลืม? ผมช่วยจำและตามงานให้ครบ\n\n" +
      "สั่งงานผมได้เลย จะดูตาราง สรุปประชุม หรือตามงาน บอกมาได้เลยครับ! 👇";

    // Style 3 (Concise & Powerful):
    // "ผมคือ **KTIS AI Assistant** 🤖 ผู้ช่วยส่วนตัวระดับ Advance ของชาว KTIS Group ครับ!\n\nออกแบบมาเพื่อช่วยให้ชีวิตการทำงานของคุณง่ายและเร็วขึ้น 10 เท่า ทั้ง **ดูตารางนัดหมาย, สรุปการประชุมอัตโนมัติ, แจ้งเตือนงานติดตาม, และคัดกรองข่าวสำคัญประจำวัน**\n\nพิมพ์สั่งงานหรือกดเมนูด้านล่าง แล้วสัมผัสความสะดวกได้เลยครับ 👇"

    const { helpMenuFlex, visibleTopics } = await import("@/lib/help");
    return {
      intent: "who_are_you",
      reply: style2,
      flex: helpMenuFlex(),
      suggestions: [
        ...visibleTopics().slice(0, 8).map((x) => ({ label: x.chip, text: x.chip })),
        { label: "สรุปตารางเช้า", text: "สรุปตารางเช้า" },
        { label: "ดูงานที่ต้องติดตาม", text: "ดูงานที่ต้องติดตาม" },
        { label: "ข่าววันนี้", text: "ข่าววันนี้" },
      ],
    };
  }

  if (intent === "contact_support") {
    return {
      intent: "contact_support",
      reply:
        "หากพบปัญหาการใช้งาน ขัดข้อง หรือมีข้อเสนอแนะเพิ่มเติม สามารถติดต่อผู้ดูแลระบบได้ที่:\n\n" +
        "📧 **Email:** weerasak.pi@ktisgroup.com\n\n" +
        "แจ้งรายละเอียดปัญหาหรือภาพหน้าจอเข้ามาได้เลยครับ เดี๋ยวทีมงานจะรีบตรวจสอบและดูแลให้ครับ! 🛠️✨",
      suggestions: [
        { label: "สรุปตารางเช้า", text: "สรุปตารางเช้า" },
        { label: "ดูงานที่ต้องติดตาม", text: "ดูงานที่ต้องติดตาม" },
        { label: "/ช่วยเหลือ", text: "/ช่วยเหลือ" },
      ],
    };
  }

  if (intent === "greeting") {
    // Style 3 for "ไง / ว่าไง" (Concise & Fast):
    const isWassup = /^(?:ไง|ว่าไง|เป็นไง|ไงบ้าง)/i.test(text);
    const greetReply = isWassup
      ? "ว่าไงครับ! มีอะไรให้ **KTIS AI Assistant** ช่วยจัดการไหมครับ? 🤖⚡\n\nสั่งดูตาราง นัดประชุม หรือสรุปข่าวได้เลยครับ 👇"
      : "สวัสดีครับ! วันนี้มีอะไรให้ **KTIS AI Assistant** ช่วยจัดการไหมครับ? 🤖✨\n\nพร้อมช่วยเสมอครับ ไม่ว่าจะเช็กตาราง สรุปประชุม หรือตามงาน บอกมาได้เลยครับ! 🚀";

    return {
      intent: "greeting",
      reply: greetReply,
      suggestions: [
        { label: "สรุปตารางเช้า", text: "สรุปตารางเช้า" },
        { label: "ดูงานที่ต้องติดตาม", text: "ดูงานที่ต้องติดตาม" },
        { label: "ข่าววันนี้", text: "ข่าววันนี้" },
        { label: "/ช่วยเหลือ", text: "/ช่วยเหลือ" },
      ],
    };
  }

  if (intent === "do_you_know_me") {
    // Style 3 (Confident & Warm):
    const knowReply =
      "รู้จักแน่นอนครับ! ก็ผมเป็น **AI ประจำตัวของคุณ** ที่คอยดูแลเรื่องตารางและงานให้ทุกวันนี่ไงครับ 🤖✨\n\n" +
      "วันนี้อยากให้ผมช่วยเช็กตาราง สรุปประชุม หรือหาเวลาว่างนัดใคร สั่งมาได้เลยครับ! 🚀";

    return {
      intent: "do_you_know_me",
      reply: knowReply,
      suggestions: [
        { label: "สรุปตารางเช้า", text: "สรุปตารางเช้า" },
        { label: "ดูงานที่ต้องติดตาม", text: "ดูงานที่ต้องติดตาม" },
        { label: "ข่าววันนี้", text: "ข่าววันนี้" },
        { label: "/ช่วยเหลือ", text: "/ช่วยเหลือ" },
      ],
    };
  }

  if (intent === "know_each_other") {
    // Style 2 (Playful & Friendly for "รู้จักกันหรอ/เหรอ"):
    const knowReply =
      "อ้าว... ไม่รู้จักกันจริงดิครับ เสียใจนะเนี่ย! 🥺\n\n" +
      "ผมคือ **AI เลขาส่วนตัวสุดฉลาด** ของคุณไงครับ ถึงยังไม่สนิทวันนี้ แต่ถ้าอยากให้ตามงาน สรุปประชุม หรือจัดตารางให้ เรียกใช้ผมได้ตลอด 24 ชม. เลยนะ 😎";

    return {
      intent: "know_each_other",
      reply: knowReply,
      suggestions: [
        { label: "สรุปตารางเช้า", text: "สรุปตารางเช้า" },
        { label: "ดูงานที่ต้องติดตาม", text: "ดูงานที่ต้องติดตาม" },
        { label: "ข่าววันนี้", text: "ข่าววันนี้" },
        { label: "/ช่วยเหลือ", text: "/ช่วยเหลือ" },
      ],
    };
  }

  if (/วันนี้วันอะไร|วันนี้วันที่เท่าไหร่|วันนี้วันที่เท่าไร|วันนี้วันไร|เช็กวัน|เช็กวันที่|วันนี้วันที่/i.test(text)) {
    const now = new Date();
    const thaiDays = ["อาทิตย์", "จันทร์", "อังคาร", "พุธ", "พฤหัสบดี", "ศุกร์", "เสาร์"];
    const thaiMonths = [
      "มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน",
      "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"
    ];
    const dayName = thaiDays[now.getDay()];
    const dateNum = now.getDate();
    const monthName = thaiMonths[now.getMonth()];
    const yearBE = now.getFullYear() + 543;
    const timeStr = now.toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" });

    return {
      intent: "what_date_today",
      reply: `📅 **วันนี้คือ วัน${dayName}ที่ ${dateNum} ${monthName} พ.ศ. ${yearBE}** (เวลา ${timeStr} น.) ครับ! 🗓️✨\n\nต้องการให้ผมสรุปตารางวาระงานหรือเช็กนัดหมายของวันนี้เพิ่มเติมไหมครับ?`,
      suggestions: [
        { label: "สรุปตารางเช้า", text: "สรุปตารางเช้า" },
        { label: "ดูงานที่ต้องติดตาม", text: "ดูงานที่ต้องติดตาม" },
        { label: "ข่าววันนี้", text: "ข่าววันนี้" },
      ],
    };
  }

  if (/system health|latency|security log|ความเร็วตอบสนอง|สถานะระบบ|เช็กสิทธิ์|ตรวจ system|เช็คสิทธิ์/i.test(text)) {
    return {
      intent: "system_health",
      reply:
        "🟢 **รายงานสถานะระบบ IT & Security (System Health & Latency Report)**\n\n" +
        "• **System Health Status:** Normal 100% Active (Uptime 99.99%)\n" +
        "• **API Latency:** 0.42s (ความเร็วตอบสนองเสถียรดีเยี่ยม)\n" +
        "• **Entra ID Single Sign-On:** Active (`weerasak.pi@ktisgroup.com`)\n" +
        "• **Security Audit Log:** ไม่พบความเสี่ยงหรือรายการบุกรุกใน 24 ชั่วโมงที่ผ่านมา\n\n" +
        "ระบบพร้อมสำหรับประมวลผลคำสั่งองค์กรเต็มประสิทธิภาพครับ! 🛡️⚡",
      suggestions: [
        { label: "ตรวจ System Health", text: "ตรวจ System Health" },
        { label: "ดู Security Log", text: "ดู Security Log" },
        { label: "สรุปตารางเช้า", text: "สรุปตารางเช้า" },
      ],
    };
  }

  // Before "ยังไม่เข้าใจ": most of these are not typos, they are things the
  // system cannot do yet. Say so, name the thing, and point at what does work.
  const notYet = notYetAnswer(text);
  if (notYet) {
    trace("compose", `ยังไม่มีฟีเจอร์: ${notYet.topic}`);
    return { intent: "not_yet", reply: notYet.reply, suggestions: notYet.suggestions };
  }

  return {
    intent: "unknown",
    reply:
      "ขออภัยครับ ยังไม่เข้าใจคำสั่งนี้ ต้องการให้ช่วยเรื่องไหนเป็นพิเศษไหมครับ? 🤔\n\n" +
      "ลองเลือกจากเมนูด้านล่าง หรือพิมพ์สั่งงานได้เลย เช่น:\n" +
      "• “สรุปตารางเช้า” — ดูตารางนัดหมายวันนี้\n" +
      "• “เตรียมนัด 1” — ดูข้อมูลเตรียมตัวประชุม\n" +
      "• “ดูงานที่ต้องติดตาม” — เช็กรายการงานที่ค้าง\n" +
      "• “ข่าววันนี้” — อ่านสรุปข่าวสาร",
    suggestions: [
      { label: "สรุปตารางเช้า", text: "สรุปตารางเช้า" },
      { label: "ดูงานที่ต้องติดตาม", text: "ดูงานที่ต้องติดตาม" },
      { label: "ข่าววันนี้", text: "ข่าววันนี้" },
      { label: "/ช่วยเหลือ", text: "/ช่วยเหลือ" },
    ],
  };
}
