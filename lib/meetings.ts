// Meeting transcripts + summaries — ported from morning_brief/transcripts.py,
// summary_llm.py and meeting_summary.py.
import { createHash } from "crypto";
import {
  Attendee,
  GraphEvent,
  getEvent,
  getEventsRange,
  getOnlineMeetingId,
  getTranscriptContent,
  getUserId,
  listTranscripts,
} from "@/lib/graph";
import { summaryChat } from "@/lib/llm";
import { sendLine } from "@/lib/line";
import { ActionItem, ingestActionItems } from "@/lib/followup";
import {
  markMeetingSummarized,
  seedMeetingsSeen,
  seenMeetingsReady,
  wasMeetingSummarized,
  claimMeetingSummary,
  alreadyGotSummary,
  noteSummaryDelivered,
  releaseMeetingSummary,
} from "@/lib/store";
import { isMeetingSummaryEnabled } from "@/lib/meetingSummaryPrefs";
import { runAsAppOnly } from "@/lib/graphAuth";
import {
  buildSummaryUrl,
  isLinkPilot,
  loadSummaryPage,
  saveSummaryPage,
  summaryIdFor,
  summaryTeaser,
} from "@/lib/summaryPage";
import { findLinkedLineAttendees } from "@/lib/meetingInvite";
import { meetingTasksOff } from "@/lib/opsPause";
import { trace } from "@/lib/trace";
import { addMinutes, fmtDateTime, nowWall, parseWall, wallIso } from "@/lib/time";

const TRANSCRIPT_LOOKBACK_HOURS = Number(process.env.TRANSCRIPT_LOOKBACK_HOURS || 24);

// ---------------------------------------------------------------------------
// Transcript fetching
// ---------------------------------------------------------------------------

/** Online meetings that ENDED within the last `lookbackHours`. */
export async function getRecentOnlineEvents(userUpn: string, lookbackHours: number): Promise<GraphEvent[]> {
  const now = nowWall();
  const start = addMinutes(now, -lookbackHours * 60);
  const events = await getEventsRange(userUpn, wallIso(start), wallIso(now));
  return events.filter((ev) => {
    if (!ev.onlineMeeting) return false;
    const end = ev.end?.dateTime ? parseWall(ev.end.dateTime) : null;
    return !!end && end <= now;
  });
}

function vttToText(vtt: string): string {
  const lines: string[] = [];
  for (const raw of vtt.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line === "WEBVTT") continue;
    if (line.includes("-->")) continue; // timestamp line
    if (/^\d+$/.test(line)) continue; // cue index
    const cleaned = line.replace(/<\/v>/g, "");
    if (cleaned.startsWith("<v ")) {
      const idx = cleaned.indexOf(">");
      const speaker = cleaned.slice(3, idx > 0 ? idx : undefined).trim();
      const text = idx > 0 ? cleaned.slice(idx + 1).trim() : "";
      lines.push(`${speaker}: ${text}`);
    } else {
      lines.push(cleaned);
    }
  }
  return lines.join("\n");
}

/**
 * Plain transcript text for a finished online meeting, or null if unavailable.
 * Transcripts live under the ORGANIZER's context — try organizer first, then the user.
 */
export async function getTranscriptText(userUpn: string, event: GraphEvent): Promise<string | null> {
  const joinUrl = event.onlineMeeting?.joinUrl;
  if (!joinUrl) return null;

  const organizer = event.organizer?.emailAddress?.address;
  const owners = [...new Set([organizer, userUpn].filter(Boolean))] as string[];

  // App-only, always — even when the caller has a delegated token.
  //
  // A transcript lives under the ORGANIZER's meeting, and a delegated token can
  // neither read another person's profile (/users/{organizer} → 403) nor look up
  // a meeting it does not own (/users/{me}/onlineMeetings?$filter=JoinWebUrl
  // returns nothing for someone else's meeting). So asking from chat found
  // nothing and reported "ไม่มี transcript", while the scheduled run — which has
  // no delegated token and therefore falls back to app-only — read the very same
  // transcript fine. Anyone in the meeting may ask for its summary, and the
  // application access policy is what grants that.
  return runAsAppOnly(async () => {
  for (const owner of owners) {
    let ownerId: string | null = null;
    try {
      ownerId = await getUserId(owner);
    } catch {
      continue;
    }
    if (!ownerId) continue;
    const meetingId = await getOnlineMeetingId(ownerId, joinUrl);
    if (!meetingId) continue;
    const transcripts = await listTranscripts(ownerId, meetingId);
    // newest-first until one returns real content
    for (const t of [...transcripts].reverse()) {
      const content = await getTranscriptContent(ownerId, meetingId, t.id);
      if (content) return vttToText(content);
    }
  }
  return null;
  });
}

// ---------------------------------------------------------------------------
// LLM summary
// ---------------------------------------------------------------------------
/**
 * สรุปให้คนที่ไม่ได้เข้าประชุมอ่านรู้เรื่อง
 *
 * ของเดิมสั่งว่า "สรุป 3-6 บรรทัด" ซึ่งได้ย่อหน้าเดียวที่อ่านแล้วยังไม่รู้ว่า
 * ในห้องคุยอะไรกัน ใครติดอะไร ตกลงอะไรได้ — คนอ่านคือคนที่ไม่ได้อยู่ในห้อง
 * จึงต้องได้บริบทพอจะเข้าใจ ไม่ใช่แค่หัวข้อ
 *
 * เพิ่ม topics เข้ามาเพื่อให้เล่าเป็นเรื่อง ๆ ได้ โดยยังคงคีย์เดิมทั้งหมดไว้
 * (summary / decisions / action_items) — สรุปเก่าที่เก็บไว้แล้วยังอ่านได้ปกติ
 */
const SUMMARY_SYSTEM = `คุณคือผู้ช่วยที่สรุปการประชุมจาก transcript ภาษาไทย
คนอ่านสรุปนี้ "ไม่ได้เข้าประชุม" — ต้องอ่านแล้วเข้าใจว่าคุยอะไรกัน ตกลงอะไรได้
และต้องทำอะไรต่อ โดยไม่ต้องกลับไปฟังเสียง
ตอบกลับเป็น JSON เท่านั้น ตามโครงสร้างนี้:

{
  "summary": "ภาพรวม 5-10 บรรทัด เล่าว่าประชุมเรื่องอะไร มีใครเกี่ยวข้อง สถานะปัจจุบันเป็นอย่างไร และจบด้วยอะไร",
  "topics": [
    {
      "title": "หัวข้อที่คุยกัน",
      "detail": "รายละเอียด 2-5 บรรทัด: ที่มา ปัญหาที่เจอ ตัวเลข/ชื่อระบบ/กำหนดเวลาที่พูดถึง ข้อโต้แย้งหรือทางเลือกที่พิจารณา และสรุปของหัวข้อนี้"
    }
  ],
  "decisions": ["ข้อตัดสินใจที่ได้จากที่ประชุม พร้อมเหตุผลสั้น ๆ ถ้ามีในบทสนทนา", "..."],
  "action_items": [
    {
      "task": "สิ่งที่ต้องทำ เขียนให้ชัดว่าทำอะไรกับอะไร",
      "owner": "ชื่อผู้รับผิดชอบ (ถ้าระบุได้จาก transcript ไม่งั้นใส่ 'ไม่ระบุ')",
      "due": "กำหนดส่ง เช่น '2026-07-25 15:00' หรือ 'วันนี้ 15:00' ถ้าไม่ระบุใส่ null"
    }
  ]
}

กติกา:
- ห้ามแต่งข้อมูลที่ไม่มีใน transcript — ไม่มีก็เว้นไว้ ดีกว่าเดา
- topics ให้ครบทุกเรื่องที่คุยกันจริง เรียงตามลำดับที่คุย (ปกติ 3-8 หัวข้อ)
- เก็บชื่อคน ชื่อระบบ ตัวเลข และกำหนดเวลาที่พูดถึงไว้ในรายละเอียด อย่าตัดทิ้ง
  เพราะอ่านแล้วห้วน — พวกนี้คือส่วนที่ทำให้สรุปใช้งานได้จริง
- ถ้ามีคนพูดว่าจะส่งไฟล์/งานภายในเวลาใด ให้ถือเป็น action_item เสมอ (สำคัญต่อการติดตาม)
- owner ให้ใช้ชื่อที่ปรากฏจริงใน transcript`;

/** รวมสรุปย่อยหลายก้อนให้เป็นฉบับเดียว */
const MERGE_SYSTEM = `คุณได้รับสรุปย่อยของการประชุมเดียวกันหลายช่วงตามลำดับเวลา
รวมให้เป็นสรุปฉบับเดียวที่อ่านต่อเนื่องเป็นเรื่องเดียว
- รวมหัวข้อที่เป็นเรื่องเดียวกันเข้าด้วยกัน อย่าให้ซ้ำ
- งานที่ต้องติดตามที่เป็นเรื่องเดียวกัน ให้เหลือรายการเดียว โดยใช้ฉบับที่ระบุ
  ผู้รับผิดชอบหรือกำหนดเวลาชัดที่สุด
- ห้ามเพิ่มข้อมูลที่ไม่มีในสรุปย่อย
ตอบกลับเป็น JSON โครงสร้างเดียวกับสรุปย่อยเท่านั้น`;

/* gemini-2.5-flash รับ context ระดับล้าน token — เพดาน 15,000 ตัวอักษรของเดิม
   มาจากสมัยที่ยังกลัวโควตา ผลคือประชุมยาวถูก "ตัดช่วงกลางออก" แล้วสรุปหายไป
   ทั้งท่อนที่คุยเรื่องจริงจัง ตอนนี้เก็บทั้งฉบับ ถ้ายาวเกินก็แบ่งเป็นก้อนแล้ว
   สรุปทีละก้อนก่อนรวม ไม่โยนช่วงกลางทิ้งอีก */
const MAX_CHARS = 120_000;
/** ยาวกว่านี้ค่อยแบ่งก้อน — แบ่งเมื่อไม่จำเป็นทำให้เสียบริบทข้ามก้อน */
const CHUNK_CHARS = 90_000;

export type SummaryResult = {
  summary?: string;
  topics?: { title?: string; detail?: string }[];
  decisions?: string[];
  action_items?: ActionItem[];
  _note?: string;
};

function parseResult(raw: string): SummaryResult {
  try {
    return JSON.parse(raw) as SummaryResult;
  } catch {
    return { summary: raw, decisions: [], action_items: [] };
  }
}

/** แบ่งตามรอยบรรทัด ไม่ตัดกลางประโยค */
function chunks(text: string, size: number): string[] {
  if (text.length <= size) return [text];
  const out: string[] = [];
  let buf = "";
  for (const line of text.split("\n")) {
    if (buf.length + line.length + 1 > size && buf) {
      out.push(buf);
      buf = "";
    }
    buf += (buf ? "\n" : "") + line;
  }
  if (buf) out.push(buf);
  return out;
}

async function askSummary(
  system: string,
  subject: string,
  body: string,
  label: string
): Promise<SummaryResult> {
  const raw = await summaryChat(system, `หัวข้อประชุม: ${subject}\n\n${body}`, {
    temperature: 0.2,
    json: true,
    timeoutMs: 60000,
    task: "meeting",
    traceStep: "compose",
    tracePrefix: label,
  });
  return parseResult(raw);
}

export async function summarize(transcriptText: string, meetingSubject: string): Promise<SummaryResult> {
  const full = transcriptText.trim().slice(0, MAX_CHARS);
  const parts = chunks(full, CHUNK_CHARS);

  if (parts.length === 1) {
    const one = await askSummary(
      SUMMARY_SYSTEM,
      meetingSubject,
      `Transcript:\n${parts[0]}`,
      "📋 สรุปประชุม"
    );
    if (transcriptText.trim().length > MAX_CHARS) {
      one._note = "ประชุมยาวมาก ระบบสรุปจากช่วงต้นเป็นหลัก";
    }
    return one;
  }

  /* ประชุมยาว: สรุปทีละช่วงแล้วรวม — ทุกช่วงได้ถูกอ่าน ไม่มีท่อนไหนถูกโยนทิ้ง */
  const pieces: SummaryResult[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    pieces.push(
      await askSummary(
        SUMMARY_SYSTEM,
        meetingSubject,
        `ช่วงที่ ${i + 1} จาก ${parts.length} ของ transcript:\n${parts[i]}`,
        `📋 สรุปประชุม ช่วง ${i + 1}/${parts.length}`
      )
    );
  }
  const merged = await askSummary(
    MERGE_SYSTEM,
    meetingSubject,
    `สรุปย่อยตามลำดับเวลา:\n${JSON.stringify(pieces)}`,
    "📋 รวมสรุปประชุม"
  );
  merged._note = `ประชุมยาว ${Math.round(full.length / 1000)}k ตัวอักษร — สรุปจาก ${parts.length} ช่วงรวมกัน`;
  return merged;
}

export function formatSummary(subject: string, result: SummaryResult): string {
  const lines = [`📋 สรุปประชุม: ${subject}`, "", (result.summary || "").trim()];
  if (result.topics?.length) {
    lines.push("", "🗂 เรื่องที่คุยกัน:");
    for (const t of result.topics) {
      const title = (t?.title || "").trim();
      const detail = (t?.detail || "").trim();
      if (!title && !detail) continue;
      lines.push("", `• ${title || "(ไม่มีหัวข้อ)"}`);
      if (detail) for (const d of detail.split(/\n+/)) lines.push(`   ${d.trim()}`);
    }
  }
  if (result.decisions?.length) {
    lines.push("", "✅ ข้อตัดสินใจ:");
    for (const d of result.decisions) lines.push(`  • ${d}`);
  }
  if (result.action_items?.length) {
    lines.push("", "📌 งานที่ต้องติดตาม:");
    for (const it of result.action_items) {
      lines.push(`  • ${it.task} — ${it.owner || "ไม่ระบุ"} (กำหนด: ${it.due || "ไม่ระบุกำหนด"})`);
    }
  }
  if (result._note) lines.push("", `ℹ️ ${result._note}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------
const subjectOf = (ev: GraphEvent) => ev.subject || "(ไม่มีหัวข้อ)";

/** "17 ส.ค. 09:00-10:30" — Bangkok wall clock, for the page header and teaser. */
function meetingWhen(ev: GraphEvent): string {
  const s = ev.start?.dateTime ? parseWall(ev.start.dateTime) : null;
  const e = ev.end?.dateTime ? parseWall(ev.end.dateTime) : null;
  if (!s) return "";
  const months = ["ม.ค.","ก.พ.","มี.ค.","เม.ย.","พ.ค.","มิ.ย.","ก.ค.","ส.ค.","ก.ย.","ต.ค.","พ.ย.","ธ.ค."];
  const pad = (n: number) => String(n).padStart(2, "0");
  const head = `${s.getUTCDate()} ${months[s.getUTCMonth()]} ${pad(s.getUTCHours())}:${pad(s.getUTCMinutes())}`;
  return e ? `${head}-${pad(e.getUTCHours())}:${pad(e.getUTCMinutes())}` : head;
}

/** How long the meeting ran, in minutes — 0 when either end is missing. */
export function meetingMinutes(ev: GraphEvent): number {
  const s = ev.start?.dateTime ? Date.parse(ev.start.dateTime) : 0;
  const e = ev.end?.dateTime ? Date.parse(ev.end.dateTime) : 0;
  if (!s || !e || e <= s) return 0;
  return Math.round((e - s) / 60000);
}

/** "1 ชม. 30 นาที" — minutes alone stop being readable past an hour. */
export function durationLabel(min: number): string {
  if (min <= 0) return "";
  if (min < 60) return `${min} นาที`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} ชม. ${m} นาที` : `${h} ชม.`;
}

function attendeesOf(ev: GraphEvent): Attendee[] {
  const people: Attendee[] = [];
  for (const a of ev.attendees || []) {
    if (a.emailAddress?.address) people.push({ name: a.emailAddress.name, email: a.emailAddress.address });
  }
  const org = ev.organizer?.emailAddress;
  if (org?.address && !people.some((p) => p.email?.toLowerCase() === org.address?.toLowerCase())) {
    people.push({ name: org.name, email: org.address });
  }
  return people;
}

/** Stable seen_meetings key so the same Teams meeting is only summarized once across calendars. */
function seenKeyForMeeting(ev: GraphEvent, eventId: string): string {
  const join = ev.onlineMeeting?.joinUrl?.trim();
  if (join) {
    const hash = createHash("sha256").update(join.toLowerCase()).digest("hex").slice(0, 48);
    return `jm:${hash}`;
  }
  return eventId;
}

/**
 * Push the summary to every calendar attendee/organizer who linked LINE
 * and has not opted out of meeting_summary_line.
 */
export async function deliverSummaryToLinkedAttendees(
  ev: GraphEvent,
  message: string,
  extraUpns: string[] = [],
  dedupeKey = "",
  pageId = ""
): Promise<{ sent: string[]; skipped: string[]; failed: string[] }> {
  const emails = [
    ...attendeesOf(ev).map((a) => a.email || ""),
    ...extraUpns,
  ].filter(Boolean);
  const linked = await findLinkedLineAttendees(emails);
  const sent: string[] = [];
  const skipped: string[] = [];
  // Opting out and failing to send both used to land in `skipped`, which made
  // "nobody wanted it" indistinguishable from "LINE refused every push".
  const failed: string[] = [];
  const seen = new Set<string>();

  for (const { upn } of linked) {
    const key = upn.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      if (!(await isMeetingSummaryEnabled(upn))) {
        skipped.push(upn);
        continue;
      }
      // Belt and braces: this person already has this meeting's summary.
      if (dedupeKey && (await alreadyGotSummary(upn, dedupeKey))) {
        skipped.push(upn);
        continue;
      }
      // Pilot accounts get a short note plus a link: one bubble however long
      // the meeting was, instead of the summary split across up to five.
      const asLink = pageId && (await isLinkPilot(upn));
      const body = asLink
        ? summaryTeaser(subjectOf(ev), meetingWhen(ev), message, buildSummaryUrl(pageId))
        : message;
      await sendLine(upn, "", body);
      if (dedupeKey) await noteSummaryDelivered(upn, dedupeKey);
      sent.push(upn);
    } catch (e) {
      console.log(`summary delivery failed for ${upn}: ${e}`);
      failed.push(upn);
    }
  }
  return { sent, skipped, failed };
}

export type SummarizeRunResult = {
  checked: number;
  summaries: string[];
  action_items: ActionItem[];
  no_transcript: string[];
  skipped: number;
  delivered?: string[];
  /** Summarized but reached nobody because every push failed — will retry. */
  undelivered?: number;
};

/** Summarize each finished online meeting that has a transcript. */
export async function summarizeRecent(
  userUpn: string,
  opts: { lookbackHours?: number; deliver?: boolean; skipSummarized?: boolean } = {}
): Promise<SummarizeRunResult> {
  const lookback = opts.lookbackHours ?? TRANSCRIPT_LOOKBACK_HOURS;
  const events = await getRecentOnlineEvents(userUpn, lookback);
  const out: SummarizeRunResult = {
    checked: events.length,
    summaries: [],
    action_items: [],
    no_transcript: [],
    skipped: 0,
    delivered: [],
  };

  // First run after install (or after the dedupe store was repaired): record the
  // window instead of summarizing it, so nobody gets a day of meetings re-sent.
  if (opts.skipSummarized && !(await seenMeetingsReady())) {
    await seedMeetingsSeen(
      events.map((ev) => seenKeyForMeeting(ev, (ev as { id?: string }).id || ""))
    );
    out.skipped = events.length;
    return out;
  }

  for (const ev of events) {
    const subject = ev.subject || "(ไม่มีหัวข้อ)";
    const eventId = (ev as { id?: string }).id || "";
    const seenKey = seenKeyForMeeting(ev, eventId);
    if (opts.skipSummarized && (await wasMeetingSummarized(seenKey))) {
      out.skipped += 1;
      continue;
    }
    const text = await getTranscriptText(userUpn, ev);
    if (!text) {
      out.no_transcript.push(subject); // not ready yet — retry next run
      continue;
    }

    // Claim the meeting BEFORE spending an LLM call and pushing to LINE. Marking
    // afterwards left a window in which a second run — another user's pass, or an
    // overlapping cron tick — saw the meeting as unsummarised and sent it again.
    if (opts.skipSummarized && !(await claimMeetingSummary(seenKey))) {
      out.skipped += 1;
      continue;
    }

    try {
      const result = await summarize(text, subject);
      const message = formatSummary(subject, result);
      out.summaries.push(message);
      if (opts.deliver) {
        // Keep a readable copy on the web before anything is sent — the link in
        // chat is worthless if the page it points at does not exist yet.
        const pageId = summaryIdFor(seenKey);
        await saveSummaryPage(pageId, {
          subject,
          when: meetingWhen(ev),
          text: message,
          actionItems: (result.action_items || []).map(
            (it) => `${it.task} — ${it.owner || "ไม่ระบุ"} (กำหนด: ${it.due || "ไม่ระบุกำหนด"})`
          ),
          createdAt: Date.now(),
        });
        const fanout = await deliverSummaryToLinkedAttendees(ev, message, [userUpn], seenKey, pageId);
        out.delivered!.push(...fanout.sent);
        // Reached nobody and the reason was a failed push (quota, outage) —
        // hand the claim back so a later run can deliver it. If everyone simply
        // opted out, the claim stands: that summary is done with.
        if (!fanout.sent.length && fanout.failed.length) {
          if (opts.skipSummarized) await releaseMeetingSummary(seenKey);
          out.summaries.pop();
          out.undelivered = (out.undelivered || 0) + 1;
          continue;
        }
      }
      const attendees = attendeesOf(ev);
      for (const item of result.action_items || []) {
        out.action_items.push({ ...item, _meeting: subject, _owner_user: userUpn, _attendees: attendees });
      }
      if (opts.skipSummarized) await markMeetingSummarized(seenKey, userUpn, subject);
    } catch (e) {
      // Nothing went out — give the claim back so the next run may retry.
      if (opts.skipSummarized) await releaseMeetingSummary(seenKey);
      throw e;
    }
  }
  return out;
}

/** Summarize a single chosen meeting (used by the chat "choose meeting" flow). */
export async function summarizeOne(
  userUpn: string,
  eventId: string
): Promise<{ ok: boolean; subject: string; summary?: string; action_items?: ActionItem[]; reason?: string }> {
  const ev = await getEvent(userUpn, eventId);
  const subject = ev.subject || "(ไม่มีหัวข้อ)";
  const text = await getTranscriptText(userUpn, ev);
  if (!text) {
    return {
      ok: false,
      subject,
      // The old wording blamed permissions and processing delays, which sent
      // people looking in the wrong place: with the app policy in place the
      // usual answer is simply that nobody switched transcription on.
      reason: ev.onlineMeeting?.joinUrl
        ? "ประชุมนี้ไม่มี transcript ให้สรุปครับ — Teams สร้าง transcript เฉพาะตอนที่เปิด “บันทึกและถอดเสียง” ในห้องประชุม (ถ้าเพิ่งจบ อาจต้องรอ 10-15 นาทีให้ประมวลผลก่อน)"
        : "ประชุมนี้ไม่ใช่ online meeting (ไม่มีลิงก์ Teams) จึงไม่มี transcript",
    };
  }
  let result: SummaryResult;
  try {
    result = await summarize(text, subject);
  } catch (e) {
    const { llmUserErrorMessage } = await import("@/lib/llm");
    return {
      ok: false,
      subject,
      reason: `สรุป transcript ไม่สำเร็จ — ${llmUserErrorMessage(e)} (ลองเลือกประชุมเดิมอีกครั้งได้ครับ)`,
    };
  }
  const message = formatSummary(subject, result);
  const attendees = attendeesOf(ev);
  const actions = (result.action_items || []).map((item) => ({
    ...item,
    _meeting: subject,
    _owner_user: userUpn,
    _attendees: attendees,
  }));
  return { ok: true, subject, summary: message, action_items: actions };
}

/** Finished online meetings (most recent first) as {event_id, label} choices. */
export async function listRecentOnline(userUpn: string, lookbackHours = 24 * 14) {
  const events = await getRecentOnlineEvents(userUpn, lookbackHours);
  return [...events].reverse().map((ev) => {
    const start = ev.start?.dateTime ? parseWall(ev.start.dateTime) : null;
    // The duration is the thing people ask for next ("ประชุมไปกี่นาที"), so it
    // travels with the row rather than being a second question.
    const mins = meetingMinutes(ev);
    const dur = durationLabel(mins);
    return {
      event_id: (ev as { id?: string }).id,
      label:
        `${start ? fmtDateTime(start) : "?"} — ${ev.subject || "(ไม่มีหัวข้อ)"}` +
        (dur ? ` · ${dur}` : ""),
      minutes: mins,
    };
  });
}

/** Scheduled-run flow: summarize new meetings, deliver, and ingest action items. */
export async function runScheduledForUser(
  userUpn: string
): Promise<{ summarized: number; tasksAdded: number; skipped: number; tasksOff?: boolean }> {
  const res = await summarizeRecent(userUpn, { deliver: true, skipSummarized: true });
  /* ปิดการเอางานจากประชุมมาเพิ่มไว้ — ยังสรุปและส่งสรุปให้ปกติ แค่ไม่เขียนลง
     ตารางงาน (เปิด/ปิดที่ _ops/meeting_tasks_off) */
  if ((await meetingTasksOff()).off) {
    trace("reply", `หยุดเพิ่มงานจากประชุมไว้ — ข้าม ${res.action_items.length} งาน`, "skip");
    return { summarized: res.summaries.length, tasksAdded: 0, skipped: res.skipped, tasksOff: true };
  }
  const added = await ingestActionItems(res.action_items);
  return { summarized: res.summaries.length, tasksAdded: added, skipped: res.skipped };
}

/**
 * Build a summary of this person's most recent finished meeting, for /test.
 * Real data on purpose — a preview made of invented text says nothing about
 * whether their own meetings render properly.
 *
 * Deliberately does NOT claim the meeting: the scheduled run must still deliver
 * it normally afterwards. Nothing is pushed from here.
 */
/**
 * A sample transcript, for testing the summariser when no real meeting has one.
 *
 * Every meeting in the last week can be transcript-less — Teams only produces
 * one when recording or transcription was switched on — and then there is
 * nothing to summarise and nothing to look at. This runs the real summariser
 * over invented text so the shape, the Thai, the action items and the link can
 * all be seen. It is labelled as invented wherever it is shown; a demo passed
 * off as a real summary would be worse than no demo.
 */
const DEMO_TRANSCRIPT = [
  "เอก: เปิดประชุมครับ วันนี้มี 3 เรื่อง — ความคืบหน้า AI Assistant, โควตา LINE, แล้วแผนอบรมผู้ใช้",
  "แบงค์: เรื่องแรก ระบบส่งบรีฟเช้าทำงานได้ปกติแล้วครับ แต่เดือนนี้โควตา push ของ LINE หมด ทำให้ส่งไม่ออกตั้งแต่กลางเดือน",
  "เอก: แปลว่าต้องอัปเกรดแพลนหรือรอรอบเดือนใหม่",
  "แบงค์: ครับ ผมจะทำตัวเลขเทียบราคาแพลนให้ดูภายในวันศุกร์",
  "นนท์: ฝั่งผู้ใช้ ผมเก็บ feedback มาได้ 8 คน ส่วนใหญ่ติดเรื่องต้องผูกบัญชีก่อนใช้ อยากให้มีคู่มือสั้น ๆ",
  "เอก: งั้นนนท์ทำคู่มือ 1 หน้า ส่งในกลุ่มภายในอังคารหน้านะ",
  "นนท์: รับครับ",
  "กร: เรื่องอบรม ผมขอจัดรอบแรก 27 ส.ค. บ่ายสอง ห้องประชุมชั้น 3 รับ 15 คน",
  "เอก: โอเค กรจองห้องแล้วส่งลิงก์ลงทะเบียนให้ผมดูก่อนประกาศ",
  "กร: ครับ จะจองวันนี้",
  "เอก: สรุปว่ารอตัวเลขแพลน LINE จากแบงค์ศุกร์นี้ คู่มือจากนนท์อังคารหน้า และห้องอบรมจากกร ปิดประชุมครับ",
].join("\n");

/** Run the real summariser over the sample transcript. */
export async function buildDemoSummary(): Promise<{
  id: string;
  subject: string;
  when: string;
  text: string;
  actionItems: string[];
}> {
  const subject = "ตัวอย่าง · ประชุมทีม AI Assistant (transcript สมมติ)";
  const result = await summarize(DEMO_TRANSCRIPT, subject);
  const message = formatSummary(subject, result);
  const actionItems = (result.action_items || []).map(
    (it) => `${it.task} — ${it.owner || "ไม่ระบุ"} (กำหนด: ${it.due || "ไม่ระบุกำหนด"})`
  );
  const pageId = summaryIdFor(`demo:${Date.now()}`);
  const payload = { subject, when: "ตัวอย่าง", text: message, actionItems, createdAt: Date.now() };
  await saveSummaryPage(pageId, payload);
  return { id: pageId, ...payload };
}

/** One line per meeting, for picking which to test. */
export type TestMeetingChoice = {
  index: number;
  subject: string;
  when: string;
  /** how long it ran, in minutes */
  minutes: number;
  hasTranscript: boolean;
  summarised: boolean;
};

/**
 * The meetings a summary can be tested against: online meetings that have
 * ended in the lookback window, newest first. Whether each one has a
 * transcript is checked here rather than left to fail later — "no transcript"
 * is the usual reason a summary never arrives, and it is worth seeing in the
 * list instead of after picking.
 */
export async function listTestMeetings(
  userUpn: string,
  lookbackHours = 24 * 7,
  max = 8
): Promise<TestMeetingChoice[]> {
  const events = await getRecentOnlineEvents(userUpn, lookbackHours);
  const ordered = [...events].sort((a, b) => {
    const ta = a.end?.dateTime ? Date.parse(a.end.dateTime) : 0;
    const tb = b.end?.dateTime ? Date.parse(b.end.dateTime) : 0;
    return tb - ta;
  });

  const out: TestMeetingChoice[] = [];
  for (const ev of ordered.slice(0, max)) {
    const eventId = (ev as { id?: string }).id || "";
    const pageId = summaryIdFor(seenKeyForMeeting(ev, eventId));
    const summarised = !!(await loadSummaryPage(pageId));
    let hasTranscript = summarised;
    if (!hasTranscript) {
      try {
        hasTranscript = !!(await getTranscriptText(userUpn, ev));
      } catch {
        hasTranscript = false;
      }
    }
    out.push({
      index: out.length + 1,
      subject: subjectOf(ev),
      when: meetingWhen(ev),
      minutes: meetingMinutes(ev),
      hasTranscript,
      summarised,
    });
  }
  return out;
}

/**
 * Summarise ONE named meeting on demand: the subject as typed (or its number
 * from listTestMeetings), rather than "whatever ran most recently". Reuses a
 * summary already built for that meeting, so asking twice costs one LLM call.
 */
export async function buildTestSummary(
  userUpn: string,
  query: string,
  lookbackHours = 24 * 7
): Promise<
  | { ok: true; id: string; subject: string; when: string; text: string; actionItems: string[]; reused: boolean }
  | { ok: false; reason: "not_found" | "no_transcript" | "none_at_all"; subject?: string; choices: TestMeetingChoice[] }
> {
  const events = await getRecentOnlineEvents(userUpn, lookbackHours);
  const ordered = [...events].sort((a, b) => {
    const ta = a.end?.dateTime ? Date.parse(a.end.dateTime) : 0;
    const tb = b.end?.dateTime ? Date.parse(b.end.dateTime) : 0;
    return tb - ta;
  });
  const choices = await listTestMeetings(userUpn, lookbackHours);
  if (!ordered.length) return { ok: false, reason: "none_at_all", choices };

  const q = query.trim().toLowerCase();
  const asIndex = /^\d+$/.test(q) ? parseInt(q, 10) : 0;
  const picked =
    asIndex >= 1 && asIndex <= ordered.length
      ? ordered[asIndex - 1]
      : ordered.find((ev) => subjectOf(ev).toLowerCase().includes(q)) ||
        // a looser pass: any word of the query in the subject
        ordered.find((ev) => {
          const s = subjectOf(ev).toLowerCase();
          return q.split(/\s+/).filter((w) => w.length > 1).some((w) => s.includes(w));
        });

  if (!picked) return { ok: false, reason: "not_found", choices };

  const eventId = (picked as { id?: string }).id || "";
  const pageId = summaryIdFor(seenKeyForMeeting(picked, eventId));
  const existing = await loadSummaryPage(pageId);
  if (existing) return { ok: true, id: pageId, ...existing, reused: true };

  const text = await getTranscriptText(userUpn, picked);
  if (!text) return { ok: false, reason: "no_transcript", subject: subjectOf(picked), choices };

  const result = await summarize(text, subjectOf(picked));
  const message = formatSummary(subjectOf(picked), result);
  const actionItems = (result.action_items || []).map(
    (it) => `${it.task} — ${it.owner || "ไม่ระบุ"} (กำหนด: ${it.due || "ไม่ระบุกำหนด"})`
  );
  const payload = {
    subject: subjectOf(picked),
    when: meetingWhen(picked),
    text: message,
    actionItems,
    createdAt: Date.now(),
  };
  await saveSummaryPage(pageId, payload);
  return { ok: true, id: pageId, ...payload, reused: false };
}

export async function buildPreviewSummary(
  userUpn: string,
  lookbackHours = 72
): Promise<{ id: string; subject: string; when: string; text: string; actionItems: string[] } | null> {
  const events = await getRecentOnlineEvents(userUpn, lookbackHours);
  // Newest first — the meeting they are most likely to remember.
  const ordered = [...events].sort((a, b) => {
    const ta = a.end?.dateTime ? Date.parse(a.end.dateTime) : 0;
    const tb = b.end?.dateTime ? Date.parse(b.end.dateTime) : 0;
    return tb - ta;
  });

  for (const ev of ordered.slice(0, 5)) {
    const eventId = (ev as { id?: string }).id || "";
    const seenKey = seenKeyForMeeting(ev, eventId);
    const pageId = summaryIdFor(seenKey);

    // Already summarised once — reuse that page rather than paying for another
    // LLM call to produce the same thing.
    const existing = await loadSummaryPage(pageId);
    if (existing) return { id: pageId, ...existing };

    const text = await getTranscriptText(userUpn, ev);
    if (!text) continue;
    const result = await summarize(text, subjectOf(ev));
    const message = formatSummary(subjectOf(ev), result);
    const actionItems = (result.action_items || []).map(
      (it) => `${it.task} — ${it.owner || "ไม่ระบุ"} (กำหนด: ${it.due || "ไม่ระบุกำหนด"})`
    );
    const payload = {
      subject: subjectOf(ev),
      when: meetingWhen(ev),
      text: message,
      actionItems,
      createdAt: Date.now(),
    };
    await saveSummaryPage(pageId, payload);
    return { id: pageId, ...payload };
  }
  return null;
}
