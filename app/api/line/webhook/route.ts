import { NextResponse } from "next/server";
import crypto from "crypto";
import { handleCommand, handleSelection, type CommandContext, type CommandResult } from "@/lib/commands";
import { getUpnByLineId, replyLine, replyLineMessages, showLineLoading, pushLineToId } from "@/lib/line";
import {
  handleNewsOnboardingPostback,
  handleNewsOnboardingText,
  isNewsOnboardingAction,
  openNewsSettings,
  startNewsOnboarding,
} from "@/lib/newsOnboarding";
import { getNewsPrefs, loadNewsDraft } from "@/lib/newsPrefs";
import { getSetting, setSetting, deleteSetting } from "@/lib/store";
import { createEvent, resolveUser } from "@/lib/graph";
import { calendarConsentNeededMessage, withDelegatedGraph } from "@/lib/msGraphOAuth";
import { respondMeetingInvite, tryHandleMeetingRsvpText, tryHandleMeetingRescheduleText, isMeetingRsvpText, isMeetingRescheduleText, getPendingRsvp, bookMeetingWithLineHold } from "@/lib/meetingInvite";
import { parseWall, wallIso, fmtDateTime, fmtTime, periodRange, nowWall, addMinutes, parseHHMM } from "@/lib/time";
import {
  appendChatTurns,
  chatMemoryExpired,
  pruneChatHistory,
  type ChatTurn,
  CHAT_MEMORY_TTL_MS,
} from "@/lib/chatMemory";
import {
  isSlashMenu,
  matchSlashCommand,
  parseSlashCommand,
  slashMenuMessage,
  slashToUserText,
  textWithDraftEscape,
} from "@/lib/slashCommands";
import { assertConfigured } from "@/lib/supabaseServer";

export const maxDuration = 60;

// LINE Messaging API webhook.
// Linked users chat with the assistant (same brain as the web); unlinked users
// get a link-account prompt. Webhook URL: https://<app-domain>/api/line/webhook

const LIFF_LINK_URL = `https://liff.line.me/${process.env.NEXT_PUBLIC_LIFF_ID || "2010856732-BFseuR2p"}`;

type LineEvent = {
  type: string;
  replyToken?: string;
  source?: { type: string; userId?: string };
  message?: { type: string; text?: string };
  postback?: { data?: string };
};

type Choice = {
  mail?: string;
  displayName?: string;
  period?: string;
  date?: string;
  event_id?: string;
  feed_id?: string;
  index?: number;
  label?: string;
  data?: string;
  lunch?: boolean;
};
type Slot = { start: string; end: string; label?: string };

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

// Turn a CommandResult that needs a choice (people / time slots / meetings to
// cancel) into LINE quick-reply buttons. Each tap sends a postback that
// handleSelection() completes. Returns null when nothing to pick.
function quickReplyFor(res: CommandResult): { items: object[] } | null {
  const items: object[] = [];
  // Button label is just the number (matches the numbered list in the message
  // body) so the full name/time is always readable above; the postback carries
  // the real selection data.
  const add = (num: number, data: string, displayText: string) => {
    if (data.length > 300 || items.length >= 12) return;
    items.push({ type: "action", action: { type: "postback", label: `${num}`, data, displayText: truncate(displayText, 60) } });
  };

  if (res.intent === "choose_person" && Array.isArray(res.choices)) {
    let n = 0;
    for (const c of res.choices as Choice[]) {
      if (!c.mail) continue;
      n++;
      const p = new URLSearchParams({ a: "avail", m: c.mail, n: c.displayName || c.mail });
      if (c.date) p.set("d", c.date); else p.set("p", c.period || "week");
      if (c.lunch) p.set("ln", "1");
      add(n, p.toString(), `เลือก ${n}) ${c.displayName || c.mail}`);
    }
  } else if (res.intent === "choose_mt_person" && Array.isArray(res.choices)) {
    let n = 0;
    for (const c of res.choices as Choice[]) {
      if (!c.data) continue;
      n++;
      add(n, c.data, `เลือก ${n}) ${c.displayName || c.mail}`);
    }
  } else if (Array.isArray(res.slots) && res.slots.length && (res.intent === "availability" || res.intent === "choose_slot")) {
    const meeting = (res.meeting as { attendees?: string[]; subject?: string; duration?: number }) || {};
    const attendees = meeting.attendees || (res.person?.mail ? [res.person.mail] : []);
    const subject = meeting.subject || "ประชุม";
    const duration = meeting.duration || 30;
    (res.slots as Slot[]).forEach((s, i) => {
      const p = new URLSearchParams({ a: "book", s: s.start, e: s.end, subj: subject, at: attendees.join(",") });
      add(i + 1, p.toString(), `จอง ${i + 1}) ${s.label || ""}`);
    });
    // Custom time — leave one slot for the button (LINE max 13)
    if (items.length < 13) {
      const p = new URLSearchParams({
        a: "bookcustom",
        subj: subject,
        at: attendees.join(","),
        dur: String(duration),
      });
      items.push({
        type: "action",
        action: {
          type: "postback",
          label: "✏️ กำหนดเอง",
          data: p.toString().slice(0, 300),
          displayText: "กำหนดเวลาเอง",
        },
      });
    }
  } else if (res.intent === "choose_cancel" && Array.isArray(res.choices)) {
    let n = 0;
    for (const c of res.choices as Choice[]) {
      if (!c.event_id) continue;
      n++;
      const p = new URLSearchParams({ a: "cancel", id: c.event_id });
      add(n, p.toString(), `ยกเลิก ${n}) ${c.label || ""}`);
    }
  } else if (res.intent === "choose_remove_feed" && Array.isArray(res.choices)) {
    let n = 0;
    for (const c of res.choices as Choice[]) {
      if (!c.feed_id) continue;
      n++;
      const p = new URLSearchParams({ a: "rmfeed", id: c.feed_id });
      add(n, p.toString(), `ลบ ${n}) ${c.label || ""}`);
    }
  } else if (res.intent === "choose_prep" && Array.isArray(res.choices)) {
    for (const c of res.choices as Choice[]) {
      if (!c.index) continue;
      const p = new URLSearchParams({ a: "prep", i: String(c.index) });
      add(c.index, p.toString(), `เตรียม ${c.index}) ${c.label || ""}`);
    }
  }

  // Follow-up suggestions (message taps) when no selection buttons above
  if (!items.length && Array.isArray(res.suggestions) && res.suggestions.length) {
    for (const s of res.suggestions.slice(0, 12)) {
      if (!s?.label || !s?.text) continue;
      items.push({
        type: "action",
        action: { type: "message", label: truncate(s.label, 20), text: s.text.slice(0, 300) },
      });
    }
  }
  return items.length ? { items } : null;
}

// LINE quick-reply labels are capped at 20 chars, so button text gets cut off.
// List the full options in the message body so nothing is hidden.
function detailText(res: CommandResult): string {
  let lines: string[] = [];
  if ((res.intent === "choose_person" || res.intent === "choose_mt_person") && Array.isArray(res.choices)) {
    lines = (res.choices as Choice[]).filter((c) => c.mail).map((c, i) => `${i + 1}) ${c.displayName || c.mail} — ${c.mail}`);
  } else if (Array.isArray(res.slots) && res.slots.length && (res.intent === "availability" || res.intent === "choose_slot")) {
    const ranges = Array.isArray(res.ranges) ? (res.ranges as Slot[]) : [];
    const parts: string[] = [];
    if (ranges.length) {
      parts.push("ช่วงว่างทั้งหมด:");
      ranges.forEach((s, i) => parts.push(`${i + 1}) ${s.label || `${s.start}-${s.end}`}`));
      parts.push("");
    }
    parts.push("เลือกเวลาเริ่ม:");
    (res.slots as Slot[]).forEach((s, i) => parts.push(`${i + 1}) ${s.label || `${s.start}-${s.end}`}`));
    parts.push("✏️) กำหนดเอง — พิมพ์วันเวลาเองได้");
    return "\n\n" + parts.join("\n");
  } else if (res.intent === "choose_cancel" && Array.isArray(res.choices)) {
    lines = (res.choices as Choice[]).filter((c) => c.event_id).map((c, i) => `${i + 1}) ${c.label || ""}`);
  } else if (res.intent === "choose_remove_feed" && Array.isArray(res.choices)) {
    lines = (res.choices as Choice[]).filter((c) => c.feed_id).map((c, i) => `${i + 1}) ${c.label || ""}`);
  } else if (res.intent === "choose_prep" && Array.isArray(res.choices)) {
    lines = (res.choices as Choice[]).map((c, i) => `${c.index || i + 1}) ${c.label || ""}`);
  }
  return lines.length ? "\n\n" + lines.join("\n") : "";
}

// --- per-user conversation context (30-minute rolling memory) ---
const CTX_KEY = "_line_ctx";

async function loadCtx(upn: string): Promise<CommandContext | undefined> {
  try {
    const raw = await getSetting(upn, CTX_KEY);
    if (!raw) return undefined;
    const c = JSON.parse(raw);
    // No reply for > 30 min → brand-new topic
    if (chatMemoryExpired(c.ts)) {
      try {
        await deleteSetting(upn, CTX_KEY);
      } catch { /* ignore */ }
      return undefined;
    }
    const pruned = pruneChatHistory(
      Array.isArray(c.history)
        ? c.history.map((t: ChatTurn) => ({
            role: String(t.role || "user"),
            text: String(t.text || ""),
            ts: typeof t.ts === "number" ? t.ts : c.ts || Date.now(),
          }))
        : [],
      typeof c.summary === "string" ? c.summary : undefined
    );
    return {
      last_intent: c.last_intent,
      last_person: c.last_person,
      last_person_mail: c.last_person_mail,
      last_period: c.last_period,
      last_meeting: c.last_meeting,
      history: pruned.history,
      summary: pruned.summary,
    };
  } catch {
    return undefined;
  }
}

async function saveCtx(upn: string, prev: CommandContext | undefined, res: CommandResult, userText?: string): Promise<void> {
  const now = Date.now();
  const withNew = appendChatTurns(
    (prev?.history || []).map((t) => ({
      role: String(t.role || "user"),
      text: String(t.text || ""),
      ts: typeof t.ts === "number" ? t.ts : now,
    })),
    userText,
    res.reply,
    now
  );
  const pruned = pruneChatHistory(withNew, prev?.summary, now);

  const next: Record<string, unknown> = {
    ts: now,
    last_intent: res.intent || prev?.last_intent,
    last_person: prev?.last_person,
    last_person_mail: prev?.last_person_mail,
    last_period: res.period || prev?.last_period,
    last_meeting: prev?.last_meeting,
    history: pruned.history,
    summary: pruned.summary,
    ttl_ms: CHAT_MEMORY_TTL_MS,
  };
  if (res.person?.mail) {
    next.last_person = res.person.displayName || res.person.mail;
    next.last_person_mail = res.person.mail;
  }
  if (res.meeting?.attendees?.length) {
    next.last_meeting = res.meeting;
  }
  try {
    await setSetting(upn, CTX_KEY, JSON.stringify(next));
  } catch { /* context is best-effort */ }
}

// Send a reply, attaching quick-reply buttons when the result needs a choice.
async function sendResult(replyToken: string, res: CommandResult): Promise<void> {
  let reply = res.reply || "รับทราบครับ";
  if (res.map_url) reply += `\n🗺️ ${res.map_url}`;
  reply += detailText(res);
  const qr = quickReplyFor(res);
  if (qr) {
    await replyLineMessages(replyToken, [{ type: "text", text: reply.slice(0, 4900), quickReply: qr }]);
  } else {
    await replyLine(replyToken, reply);
  }
}

function validSignature(rawBody: string, signature: string | null): boolean {
  const secret = process.env.LINE_CHANNEL_SECRET || "";
  if (!secret || !signature) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("base64");
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

function linkPromptMessage() {
  return {
    type: "template",
    altText: "ผูกบัญชีเพื่อใช้งาน",
    template: {
      type: "buttons",
      text: "ผูกบัญชีเพื่อใช้งาน\nกดปุ่มด้านล่างเพื่อผูกบัญชี Microsoft 365 ของคุณ",
      actions: [{ type: "uri", label: "ผูกบัญชี", uri: LIFF_LINK_URL }],
    },
  };
}

// --- booking confirmation: tapping a time slot opens an editable draft (time,
// subject, details, attendees) that the user confirms before the invite is sent ---
const DRAFT_KEY = "_line_draft";
const DRAFT_TTL_MS = 30 * 60 * 1000;
type Draft = {
  start: string;
  end: string;
  attendees: string[];
  subject: string;
  detail: string;
  await?: "subject" | "detail" | "attendee" | "custom_time";
  durationMin?: number;
  ts: number;
};

async function loadDraft(upn: string): Promise<Draft | null> {
  try {
    const raw = await getSetting(upn, DRAFT_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw) as Draft;
    if (!d.ts || Date.now() - d.ts > DRAFT_TTL_MS) return null;
    return d;
  } catch {
    return null;
  }
}
const saveDraft = (upn: string, d: Draft) => setSetting(upn, DRAFT_KEY, JSON.stringify({ ...d, ts: Date.now() }));
const clearDraft = (upn: string) => deleteSetting(upn, DRAFT_KEY);

function draftWhen(d: Draft): string {
  const s = parseWall(d.start), e = parseWall(d.end);
  return s && e ? `${fmtDateTime(s)}-${fmtTime(e)}` : `${d.start} - ${d.end}`;
}

// A text message that shows the draft and offers confirm/edit quick replies.
function confirmCardMessage(d: Draft, prefix = ""): object {
  const text =
    `${prefix}📋 ตรวจสอบก่อนส่งนัดประชุม\n` +
    `🕐 ${draftWhen(d)}\n` +
    `📌 หัวข้อ: ${d.subject}\n` +
    (d.detail ? `📝 รายละเอียด: ${d.detail}\n` : "") +
    `👤 ผู้เข้าร่วม: ${d.attendees.length ? d.attendees.join(", ") : "(ยังไม่มี)"}\n\n` +
    `ยืนยันเพื่อส่งคำขอนัด (รออีกฝั่งยืนยันก่อนเข้า Outlook) หรือแก้ไขก่อนได้ครับ 👇`;
  return {
    type: "text",
    text,
    quickReply: {
      items: [
        { type: "action", action: { type: "postback", label: "✅ ยืนยันส่งคำขอ", data: "a=confirmbook", displayText: "ยืนยันส่งคำขอนัด" } },
        { type: "action", action: { type: "postback", label: "✏️ หัวข้อ", data: "a=setsubj", displayText: "ตั้งหัวข้อประชุม" } },
        { type: "action", action: { type: "postback", label: "📝 รายละเอียด", data: "a=setdetail", displayText: "ใส่รายละเอียด" } },
        { type: "action", action: { type: "postback", label: "➕ เพิ่มคน", data: "a=addppl", displayText: "เพิ่มคนเข้าประชุม" } },
        { type: "action", action: { type: "postback", label: "❌ ยกเลิก", data: "a=canceldraft", displayText: "ยกเลิกการนัด" } },
      ],
    },
  };
}

const BOOKING_ACTIONS = new Set(["book", "bookcustom", "confirmbook", "setsubj", "setdetail", "addppl", "canceldraft"]);
const MEETING_RSVP_ACTIONS = new Set(["mtaccept", "mtdecline"]);

/** Parse free-text meeting window, e.g. "พรุ่งนี้ 10:00-11:00", "10.00-11.00", "10 โมง 30 นาที". */
function parseCustomMeetingWindow(
  text: string,
  durationMin = 30
): { start: string; end: string } | null {
  let s = text.trim().replace(/\s+/g, " ");
  if (!s) return null;

  let day = nowWall();
  if (/มะรืน/.test(s)) {
    day = periodRange("tomorrow").start;
    day = addMinutes(day, 24 * 60);
    s = s.replace(/มะรืน(นี้)?/g, "").trim();
  } else if (/พรุ่งนี้/.test(s)) {
    day = periodRange("tomorrow").start;
    s = s.replace(/พรุ่งนี้/g, "").trim();
  } else if (/วันนี้/.test(s)) {
    day = periodRange("today").start;
    s = s.replace(/วันนี้/g, "").trim();
  } else {
    const iso = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
    const dmy = s.match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/);
    if (iso) {
      day = new Date(Date.UTC(+iso[1], +iso[2] - 1, +iso[3]));
      s = s.replace(iso[0], "").trim();
    } else if (dmy) {
      const y = dmy[3] ? (+dmy[3] < 100 ? 2000 + +dmy[3] : +dmy[3]) : day.getUTCFullYear();
      day = new Date(Date.UTC(y, +dmy[2] - 1, +dmy[1]));
      s = s.replace(dmy[0], "").trim();
    }
  }

  const y = day.getUTCFullYear();
  const mo = day.getUTCMonth();
  const d = day.getUTCDate();

  const range =
    s.match(/(\d{1,2})[:.](\d{2})\s*[-–ถึง]+\s*(\d{1,2})[:.](\d{2})/) ||
    s.match(/(\d{1,2})\s*[:.]\s*(\d{2})\s*(?:ถึง|-)\s*(\d{1,2})\s*[:.]\s*(\d{2})/);
  if (range) {
    const start = new Date(Date.UTC(y, mo, d, +range[1], +range[2], 0));
    const end = new Date(Date.UTC(y, mo, d, +range[3], +range[4], 0));
    if (end <= start) return null;
    return { start: wallIso(start), end: wallIso(end) };
  }

  // "10 โมง", "บ่าย 2", "09:00"
  let startMin: number | null = parseHHMM(s.match(/(\d{1,2}[:.]\d{2})/)?.[1] || "");
  if (startMin === null) {
    const th = s.match(/(?:บ่าย|เย็น)?\s*(\d{1,2})\s*โมง(?:\s*(\d{1,2}))?/);
    if (th) {
      let h = +th[1];
      const m = th[2] ? +th[2] : 0;
      if (/บ่าย|เย็น/.test(s) && h < 12) h += 12;
      if (/ทุ่ม/.test(s) && h < 12) h += 12;
      startMin = h * 60 + m;
    }
  }
  if (startMin === null) return null;
  const start = new Date(Date.UTC(y, mo, d, Math.floor(startMin / 60), startMin % 60, 0));
  const end = addMinutes(start, durationMin);
  return { start: wallIso(start), end: wallIso(end) };
}

async function handleBookingFlow(upn: string, act: string, params: URLSearchParams, replyToken: string): Promise<void> {
  if (act === "book") {
    const draft: Draft = {
      start: params.get("s") || "",
      end: params.get("e") || "",
      attendees: (params.get("at") || "").split(",").map((x) => x.trim()).filter(Boolean),
      subject: params.get("subj") || "ประชุม",
      detail: "",
      ts: Date.now(),
    };
    await saveDraft(upn, draft);
    await replyLineMessages(replyToken, [confirmCardMessage(draft)]);
    return;
  }

  if (act === "bookcustom") {
    const draft: Draft = {
      start: "",
      end: "",
      attendees: (params.get("at") || "").split(",").map((x) => x.trim()).filter(Boolean),
      subject: params.get("subj") || "ประชุม",
      detail: "",
      await: "custom_time",
      durationMin: Math.max(15, Math.min(240, Number(params.get("dur") || 30) || 30)),
      ts: Date.now(),
    };
    await saveDraft(upn, draft);
    await replyLineMessages(replyToken, [
      textWithDraftEscape(
        "พิมพ์วันและเวลาที่ต้องการจองได้เลยครับ เช่น\n" +
          "• พรุ่งนี้ 10:00-11:00\n" +
          "• วันนี้ 14:00-15:00\n" +
          "• 10:00-11:00\n" +
          "• พรุ่งนี้ 10 โมง (จะจอง " +
          `${draft.durationMin} นาที)\n\n` +
          "หรือกด /ล้างความจำ · /ยกเลิก ด้านล่างได้ครับ"
      ),
    ]);
    return;
  }

  const draft = await loadDraft(upn);
  if (!draft) {
    await replyLine(replyToken, "ไม่พบรายการนัดที่ค้างอยู่ (อาจหมดเวลา 30 นาที) — เริ่มเลือกช่วงเวลาใหม่อีกครั้งได้ครับ");
    return;
  }

  if (act === "setsubj") {
    draft.await = "subject";
    await saveDraft(upn, draft);
    await replyLineMessages(replyToken, [
      textWithDraftEscape("พิมพ์หัวข้อประชุมมาได้เลยครับ (เช่น “อัปเดตงาน IT”)"),
    ]);
    return;
  }
  if (act === "setdetail") {
    draft.await = "detail";
    await saveDraft(upn, draft);
    await replyLineMessages(replyToken, [
      textWithDraftEscape("พิมพ์รายละเอียด/วาระการประชุมมาได้เลยครับ (จะแนบไว้ในคำเชิญ)"),
    ]);
    return;
  }
  if (act === "addppl") {
    draft.await = "attendee";
    await saveDraft(upn, draft);
    await replyLineMessages(replyToken, [
      textWithDraftEscape("พิมพ์ชื่อคนที่จะเพิ่มเข้าประชุมครับ (หลายคนคั่นด้วย , หรือขึ้นบรรทัดใหม่)"),
    ]);
    return;
  }
  if (act === "canceldraft") {
    await clearDraft(upn);
    await replyLine(replyToken, "ยกเลิกแล้วครับ — ไม่มีการส่งนัดออกไป");
    return;
  }
  if (act === "confirmbook") {
    const s = parseWall(draft.start), e = parseWall(draft.end);
    if (!s || !e) {
      await replyLine(replyToken, "ช่วงเวลาไม่ถูกต้อง ลองเลือกใหม่ครับ");
      return;
    }
    try {
      let asUserOk = true;
      const result = await bookMeetingWithLineHold({
        organizerUpn: upn,
        subject: draft.subject,
        startIso: wallIso(s),
        endIso: wallIso(e),
        attendees: draft.attendees,
        detail: draft.detail || undefined,
        create: async () => {
          const { result: ev, asUser } = await withDelegatedGraph(upn, () =>
            createEvent(upn, draft.subject, wallIso(s), wallIso(e), draft.attendees, true, draft.detail || undefined)
          );
          asUserOk = asUser;
          return ev;
        },
      });
      if (result.mode === "booked" && !asUserOk) {
        await replyLine(replyToken, calendarConsentNeededMessage());
        return;
      }
      await clearDraft(upn);

      const headline =
        result.mode === "proposed"
          ? `⏳ ส่งคำขอนัดแล้ว — รออีกฝั่งยืนยัน\n📌 ${draft.subject}\n🕐 ${draftWhen(draft)}`
          : `✅ ส่งนัดประชุมแล้ว!\n📌 ${draft.subject}\n🕐 ${draftWhen(draft)}`;

      await replyLine(
        replyToken,
        headline +
          (draft.detail ? `\n📝 ${draft.detail}` : "") +
          `\n👤 ${draft.attendees.join(", ")}` +
          result.note
      );
    } catch (err) {
      await replyLine(replyToken, `⚠️ ส่งนัดไม่สำเร็จ: ${String(err).slice(0, 150)}`);
    }
    return;
  }
}

// If the user is filling in a pending draft (subject or attendees), capture that
// free text; returns true when handled so the normal command flow is skipped.
async function handleDraftInput(upn: string, text: string, replyToken: string): Promise<boolean> {
  const draft = await loadDraft(upn);
  if (!draft?.await) return false;

  if (draft.await === "custom_time") {
    const parsed = parseCustomMeetingWindow(text, draft.durationMin || 30);
    if (!parsed) {
      await replyLineMessages(replyToken, [
        textWithDraftEscape(
          "ยังอ่านเวลาไม่ชัดครับ ลองพิมพ์แบบนี้:\n• พรุ่งนี้ 10:00-11:00\n• วันนี้ 14:00-15:00\n• 10:00-11:00\n\nหรือกด /ล้างความจำ · /ยกเลิก ด้านล่างได้ครับ"
        ),
      ]);
      return true;
    }
    draft.start = parsed.start;
    draft.end = parsed.end;
    draft.await = undefined;
    await saveDraft(upn, draft);
    await replyLineMessages(replyToken, [confirmCardMessage(draft, "ตั้งเวลาเองแล้ว ✅\n\n")]);
    return true;
  }

  if (draft.await === "subject") {
    draft.subject = text.trim().slice(0, 200) || "ประชุม";
    draft.await = undefined;
    await saveDraft(upn, draft);
    await replyLineMessages(replyToken, [confirmCardMessage(draft, "ตั้งหัวข้อแล้ว ✅\n\n")]);
    return true;
  }

  if (draft.await === "detail") {
    draft.detail = text.trim().slice(0, 1000);
    draft.await = undefined;
    await saveDraft(upn, draft);
    await replyLineMessages(replyToken, [confirmCardMessage(draft, "ใส่รายละเอียดแล้ว ✅\n\n")]);
    return true;
  }

  // await === "attendee"
  const names = text.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
  const notFound: string[] = [];
  for (const nm of names) {
    const em = await resolveUser(nm);
    if (em) {
      if (!draft.attendees.includes(em)) draft.attendees.push(em);
    } else {
      notFound.push(nm);
    }
  }
  draft.await = undefined;
  await saveDraft(upn, draft);
  const extra = notFound.length ? `(หาไม่เจอ: ${notFound.join(", ")})\n\n` : "";
  await replyLineMessages(replyToken, [confirmCardMessage(draft, `เพิ่มคนแล้ว ✅ ${extra}`)]);
  return true;
}

async function handleTextMessage(ev: LineEvent): Promise<void> {
  const userId = ev.source?.userId;
  let text = (ev.message?.text || "").trim();
  if (!ev.replyToken || !userId || !text) return;

  const upn = await getUpnByLineId(userId);
  if (!upn) {
    await replyLineMessages(ev.replyToken, [linkPromptMessage()]);
    return;
  }
  try {
    void showLineLoading(userId, 60);

    // Meeting RSVP / reschedule by text — before news onboarding
    {
      const reschedule = await tryHandleMeetingRescheduleText(upn, text);
      if (reschedule) {
        await replyLine(ev.replyToken, reschedule.reply);
        return;
      }
      const rsvp = await tryHandleMeetingRsvpText(upn, text);
      if (rsvp) {
        await replyLineMessages(ev.replyToken, [
          {
            type: "text",
            text: rsvp.reply,
            ...(rsvp.quickReply ? { quickReply: rsvp.quickReply } : {}),
          },
        ]);
        return;
      }
      // Attendee typed cancel/decline/reschedule but invite pointer missing — don't dump into news welcome
      if (isMeetingRsvpText(text) || isMeetingRescheduleText(text)) {
        const prefs = await getNewsPrefs(upn);
        if (!prefs.onboardingDone) {
          await replyLine(
            ev.replyToken,
            isMeetingRescheduleText(text)
              ? "รับทราบว่าอยากเปลี่ยนเวลาครับ แต่ยังผูกกับนัดล่าสุดไม่เจอในระบบ\nให้เจ้าของนัดส่งคำเชิญใหม่ หรือแจ้งโดยตรงได้ครับ"
              : "รับทราบครับ แต่ยังผูกกับนัดล่าสุดไม่เจอในระบบ\nให้กดปุ่ม ❌ ไม่สะดวก จากข้อความเชิญนัด หรือให้เจ้าของนัดส่งคำเชิญใหม่ได้ครับ"
          );
          return;
        }
      }
    }

    // Slash commands always win over booking drafts / onboarding text input
    if (isSlashMenu(text)) {
      await replyLineMessages(ev.replyToken, [slashMenuMessage()]);
      return;
    }
    const slashBody = parseSlashCommand(text);
    if (slashBody) {
      const cmd = matchSlashCommand(slashBody);
      if (!cmd) {
        await replyLineMessages(ev.replyToken, [
          {
            type: "text",
            text: `ไม่รู้จักคำสั่ง /${slashBody} ครับ\nพิมพ์ / เพื่อดูรายการคำสั่ง`,
            quickReply: (slashMenuMessage() as { quickReply: object }).quickReply,
          },
        ]);
        return;
      }
      if (cmd.cmd === "ล้างความจำ") {
        try {
          await deleteSetting(upn, CTX_KEY);
        } catch { /* ignore */ }
        try {
          await clearDraft(upn);
        } catch { /* ignore */ }
        await replyLineMessages(ev.replyToken, [
          {
            type: "text",
            text: "ล้างความจำการสนทนาแล้วครับ — เริ่มเรื่องใหม่ได้เลย 🧹\n(ยกเลิกงานจองนัดที่ค้างไว้ด้วย)",
            quickReply: (slashMenuMessage() as { quickReply: object }).quickReply,
          },
        ]);
        return;
      }
      if (cmd.cmd === "ยกเลิก") {
        const pending = await getPendingRsvp(upn);
        if (pending) {
          const rsvp = await respondMeetingInvite(upn, pending.organizerUpn, pending.inviteId, false);
          await replyLineMessages(ev.replyToken, [
            {
              type: "text",
              text: rsvp.reply,
              ...(rsvp.quickReply ? { quickReply: rsvp.quickReply } : {}),
            },
          ]);
          return;
        }
        await clearDraft(upn);
        await replyLine(ev.replyToken, "ยกเลิกงานที่ค้างไว้แล้วครับ — พิมพ์คำสั่งใหม่หรือพิมพ์ / เพื่อเลือกคำสั่ง");
        return;
      }
      if (cmd.cmd === "ตั้งค่าข่าว") {
        const prefs = await getNewsPrefs(upn);
        if (prefs.onboardingDone) await openNewsSettings(upn, "reply", ev.replyToken);
        else await startNewsOnboarding(upn, "reply", ev.replyToken);
        return;
      }
      // Map other slash cmds to normal assistant text
      text = slashToUserText(cmd);
    }

    // A pending booking draft awaiting subject/attendee input takes priority
    // (only after slash commands were checked).
    if (await handleDraftInput(upn, text, ev.replyToken)) return;
    // News onboarding (custom topic text / resume)
    if (await handleNewsOnboardingText(upn, text, ev.replyToken)) return;
    if (/^(ตั้งค่าข่าว|ตั้งค่าติดตามข่าว|เริ่มติดตามข่าว)$/i.test(text)) {
      const prefs = await getNewsPrefs(upn);
      if (prefs.onboardingDone) {
        await openNewsSettings(upn, "reply", ev.replyToken);
      } else {
        await startNewsOnboarding(upn, "reply", ev.replyToken);
      }
      return;
    }
    // First-time linked user → news onboarding before normal chat
    {
      const prefs = await getNewsPrefs(upn);
      if (!prefs.onboardingDone) {
        const draft = await loadNewsDraft(upn);
        if (!draft) {
          await startNewsOnboarding(upn, "reply", ev.replyToken);
          return;
        }
        await startNewsOnboarding(upn, "reply", ev.replyToken);
        return;
      }
    }
    const ctx = await loadCtx(upn);
    const { result: res } = await withDelegatedGraph(upn, () => handleCommand(upn, text, ctx, true));
    try {
      await sendResult(ev.replyToken, res);
    } catch (replyErr) {
      console.warn("[line] reply failed, pushing:", String(replyErr).slice(0, 120));
      await pushLineToId(userId, (res.reply || "รับทราบครับ") + detailText(res));
    }
    if (res.intent === "clear_memory") {
      try {
        await deleteSetting(upn, CTX_KEY);
      } catch { /* ignore */ }
      try {
        await clearDraft(upn);
      } catch { /* ignore */ }
      return;
    }
    await saveCtx(upn, ctx, res, text);
  } catch (e) {
    try {
      await replyLine(ev.replyToken, `ขออภัยครับ เกิดข้อผิดพลาด: ${String(e).slice(0, 200)}`);
    } catch {
      try {
        await pushLineToId(userId, `ขออภัยครับ เกิดข้อผิดพลาด: ${String(e).slice(0, 200)}`);
      } catch { /* give up */ }
    }
  }
}

// User tapped a quick-reply button → complete that selection.
async function handlePostback(ev: LineEvent): Promise<void> {
  const userId = ev.source?.userId;
  if (!ev.replyToken || !userId) return;
  const upn = await getUpnByLineId(userId);
  if (!upn) {
    await replyLineMessages(ev.replyToken, [linkPromptMessage()]);
    return;
  }
  try {
    const data = new URLSearchParams(ev.postback?.data || "");
    const act = data.get("a") || "";
    // Attendee RSVP on LINE after being invited
    if (MEETING_RSVP_ACTIONS.has(act)) {
      const oid = decodeURIComponent(data.get("oid") || "");
      const id = data.get("id") || "";
      const result = await respondMeetingInvite(upn, oid, id, act === "mtaccept");
      await replyLineMessages(ev.replyToken, [
        {
          type: "text",
          text: result.reply,
          ...(result.quickReply ? { quickReply: result.quickReply } : {}),
        },
      ]);
      return;
    }
    // Booking confirmation flow (tap slot → draft → confirm) is handled here.
    if (BOOKING_ACTIONS.has(act)) {
      await handleBookingFlow(upn, act, data, ev.replyToken);
      return;
    }
    if (isNewsOnboardingAction(act)) {
      await handleNewsOnboardingPostback(upn, data, ev.replyToken);
      return;
    }
    if (act === "prep") void showLineLoading(userId, 60);
    const { result: res } = await withDelegatedGraph(upn, () => handleSelection(upn, data));
    await sendResult(ev.replyToken, res);
    // Remember who this selection was about so text follow-ups continue on them.
    await saveCtx(upn, await loadCtx(upn), res);
  } catch (e) {
    await replyLine(ev.replyToken, `ขออภัยครับ เกิดข้อผิดพลาด: ${String(e).slice(0, 200)}`);
  }
}

export async function POST(req: Request) {
  const rawBody = await req.text();
  if (!validSignature(rawBody, req.headers.get("x-line-signature"))) {
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  try {
    assertConfigured();
    const events: LineEvent[] = JSON.parse(rawBody).events || [];

    for (const ev of events) {
      try {
        if (ev.type === "message" && ev.message?.type === "text") {
          await handleTextMessage(ev);
        } else if (ev.type === "postback") {
          await handlePostback(ev);
        } else if (ev.type === "follow" && ev.replyToken) {
          await replyLineMessages(ev.replyToken, [linkPromptMessage()]);
        }
      } catch (e) {
        console.log(`line webhook event failed: ${e}`);
      }
    }

    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({
    ok: true,
    endpoint: "line webhook",
    version: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) || "local",
  });
}
