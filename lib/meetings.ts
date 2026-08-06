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
import { markMeetingSummarized, wasMeetingSummarized } from "@/lib/store";
import { isMeetingSummaryEnabled } from "@/lib/meetingSummaryPrefs";
import { findLinkedLineAttendees } from "@/lib/meetingInvite";
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
}

// ---------------------------------------------------------------------------
// LLM summary
// ---------------------------------------------------------------------------
const SUMMARY_SYSTEM = `คุณคือผู้ช่วยที่สรุปการประชุมจาก transcript ภาษาไทย
สรุปให้กระชับ ตรงประเด็น และดึงงานที่ต้องติดตามออกมาให้ครบ
ตอบกลับเป็น JSON เท่านั้น ตามโครงสร้างนี้:

{
  "summary": "สรุปประชุม 3-6 บรรทัด ครอบคลุมประเด็นหลักและข้อสรุป",
  "decisions": ["ข้อตัดสินใจที่ได้จากที่ประชุม", "..."],
  "action_items": [
    {
      "task": "สิ่งที่ต้องทำ",
      "owner": "ชื่อผู้รับผิดชอบ (ถ้าระบุได้จาก transcript ไม่งั้นใส่ 'ไม่ระบุ')",
      "due": "กำหนดส่ง เช่น '2026-07-25 15:00' หรือ 'วันนี้ 15:00' ถ้าไม่ระบุใส่ null"
    }
  ]
}

กติกา:
- ห้ามแต่งข้อมูลที่ไม่มีใน transcript
- ถ้ามีคนพูดว่าจะส่งไฟล์/งานภายในเวลาใด ให้ถือเป็น action_item เสมอ (สำคัญต่อการติดตาม)
- owner ให้ใช้ชื่อที่ปรากฏจริงใน transcript`;

// Keep one request within free-tier token limits (Thai ≈ 1 token/char).
const MAX_CHARS = 15000;

export type SummaryResult = {
  summary?: string;
  decisions?: string[];
  action_items?: ActionItem[];
  _note?: string;
};

function clip(text: string): { text: string; clipped: boolean } {
  const t = text.trim();
  if (t.length <= MAX_CHARS) return { text: t, clipped: false };
  const head = Math.floor(MAX_CHARS * 0.6);
  const tail = MAX_CHARS - head;
  return {
    text: t.slice(0, head) + "\n\n...[ตัดช่วงกลางออกเพราะประชุมยาวมาก]...\n\n" + t.slice(-tail),
    clipped: true,
  };
}

export async function summarize(transcriptText: string, meetingSubject: string): Promise<SummaryResult> {
  const { text, clipped } = clip(transcriptText);
  const raw = await summaryChat(SUMMARY_SYSTEM, `หัวข้อประชุม: ${meetingSubject}\n\nTranscript:\n${text}`, {
    temperature: 0.2,
    json: true,
    timeoutMs: 45000,
    traceStep: "compose",
    tracePrefix: "📋 สรุปประชุม",
  });
  let result: SummaryResult;
  try {
    result = JSON.parse(raw);
  } catch {
    result = { summary: raw, decisions: [], action_items: [] };
  }
  if (clipped) result._note = "หมายเหตุ: ประชุมยาวมาก ระบบสรุปจากช่วงต้นและช่วงท้าย (โมเดลฟรีมีขีดจำกัด)";
  return result;
}

export function formatSummary(subject: string, result: SummaryResult): string {
  const lines = [`📋 สรุปประชุม: ${subject}`, "", (result.summary || "").trim()];
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
  extraUpns: string[] = []
): Promise<{ sent: string[]; skipped: string[] }> {
  const emails = [
    ...attendeesOf(ev).map((a) => a.email || ""),
    ...extraUpns,
  ].filter(Boolean);
  const linked = await findLinkedLineAttendees(emails);
  const sent: string[] = [];
  const skipped: string[] = [];
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
      await sendLine(upn, "", message);
      sent.push(upn);
    } catch (e) {
      console.log(`summary delivery failed for ${upn}: ${e}`);
      skipped.push(upn);
    }
  }
  return { sent, skipped };
}

export type SummarizeRunResult = {
  checked: number;
  summaries: string[];
  action_items: ActionItem[];
  no_transcript: string[];
  skipped: number;
  delivered?: string[];
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
    const result = await summarize(text, subject);
    const message = formatSummary(subject, result);
    out.summaries.push(message);
    if (opts.deliver) {
      const fanout = await deliverSummaryToLinkedAttendees(ev, message, [userUpn]);
      out.delivered!.push(...fanout.sent);
    }
    const attendees = attendeesOf(ev);
    for (const item of result.action_items || []) {
      out.action_items.push({ ...item, _meeting: subject, _owner_user: userUpn, _attendees: attendees });
    }
    if (opts.skipSummarized) await markMeetingSummarized(seenKey, userUpn, subject);
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
      reason: ev.onlineMeeting?.joinUrl
        ? "เจอ meeting แล้วแต่ยังดึง transcript ไม่ได้ (อาจยังประมวลผลไม่เสร็จ หรือไม่มีสิทธิ์เข้าถึง)"
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
    return {
      event_id: (ev as { id?: string }).id,
      label: `${start ? fmtDateTime(start) : "?"} — ${ev.subject || "(ไม่มีหัวข้อ)"}`,
    };
  });
}

/** Scheduled-run flow: summarize new meetings, deliver, and ingest action items. */
export async function runScheduledForUser(userUpn: string): Promise<{ summarized: number; tasksAdded: number }> {
  const res = await summarizeRecent(userUpn, { deliver: true, skipSummarized: true });
  const added = await ingestActionItems(res.action_items);
  return { summarized: res.summaries.length, tasksAdded: added };
}
