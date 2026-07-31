import { NextResponse } from "next/server";
import crypto from "crypto";
import { handleCommand, handleSelection, type CommandContext, type CommandResult } from "@/lib/commands";
import { getUpnByLineId, replyLine, replyLineMessages } from "@/lib/line";
import { getSetting, setSetting, deleteSetting } from "@/lib/store";
import { createEvent, resolveUser } from "@/lib/graph";
import { parseWall, wallIso, fmtDateTime, fmtTime } from "@/lib/time";
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

type Choice = { mail?: string; displayName?: string; period?: string; date?: string; event_id?: string; label?: string; data?: string };
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
    const meeting = (res.meeting as { attendees?: string[]; subject?: string }) || {};
    const attendees = meeting.attendees || (res.person?.mail ? [res.person.mail] : []);
    const subject = meeting.subject || "ประชุม";
    (res.slots as Slot[]).forEach((s, i) => {
      const p = new URLSearchParams({ a: "book", s: s.start, e: s.end, subj: subject, at: attendees.join(",") });
      add(i + 1, p.toString(), `จอง ${i + 1}) ${s.label || ""}`);
    });
  } else if (res.intent === "choose_cancel" && Array.isArray(res.choices)) {
    let n = 0;
    for (const c of res.choices as Choice[]) {
      if (!c.event_id) continue;
      n++;
      const p = new URLSearchParams({ a: "cancel", id: c.event_id });
      add(n, p.toString(), `ยกเลิก ${n}) ${c.label || ""}`);
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
    lines = (res.slots as Slot[]).map((s, i) => `${i + 1}) ${s.label || `${s.start}-${s.end}`}`);
  } else if (res.intent === "choose_cancel" && Array.isArray(res.choices)) {
    lines = (res.choices as Choice[]).filter((c) => c.event_id).map((c, i) => `${i + 1}) ${c.label || ""}`);
  }
  return lines.length ? "\n\n" + lines.join("\n") : "";
}

// --- per-user conversation context (so "วันนี้ 10 โมง ติดอะไร" keeps talking
// about the same person as the previous turn, like the web app does) ---
const CTX_KEY = "_line_ctx";
const CTX_TTL_MS = 30 * 60 * 1000; // forget the thread after 30 min idle

async function loadCtx(upn: string): Promise<CommandContext | undefined> {
  try {
    const raw = await getSetting(upn, CTX_KEY);
    if (!raw) return undefined;
    const c = JSON.parse(raw);
    if (!c.ts || Date.now() - c.ts > CTX_TTL_MS) return undefined;
    return { last_intent: c.last_intent, last_person: c.last_person, last_person_mail: c.last_person_mail };
  } catch {
    return undefined;
  }
}

async function saveCtx(upn: string, prev: CommandContext | undefined, res: CommandResult): Promise<void> {
  const next: Record<string, unknown> = {
    ts: Date.now(),
    last_intent: res.intent || prev?.last_intent,
    last_person: prev?.last_person,
    last_person_mail: prev?.last_person_mail,
  };
  if (res.person?.mail) {
    next.last_person = res.person.displayName || res.person.mail;
    next.last_person_mail = res.person.mail;
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
  start: string; end: string; attendees: string[];
  subject: string; detail: string; await?: "subject" | "detail" | "attendee"; ts: number;
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
    `ยืนยันเพื่อส่งนัด หรือแก้ไขก่อนได้ครับ 👇`;
  return {
    type: "text",
    text,
    quickReply: {
      items: [
        { type: "action", action: { type: "postback", label: "✅ ยืนยันส่งนัด", data: "a=confirmbook", displayText: "ยืนยันส่งนัด" } },
        { type: "action", action: { type: "postback", label: "✏️ หัวข้อ", data: "a=setsubj", displayText: "ตั้งหัวข้อประชุม" } },
        { type: "action", action: { type: "postback", label: "📝 รายละเอียด", data: "a=setdetail", displayText: "ใส่รายละเอียด" } },
        { type: "action", action: { type: "postback", label: "➕ เพิ่มคน", data: "a=addppl", displayText: "เพิ่มคนเข้าประชุม" } },
        { type: "action", action: { type: "postback", label: "❌ ยกเลิก", data: "a=canceldraft", displayText: "ยกเลิกการนัด" } },
      ],
    },
  };
}

const BOOKING_ACTIONS = new Set(["book", "confirmbook", "setsubj", "setdetail", "addppl", "canceldraft"]);

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

  const draft = await loadDraft(upn);
  if (!draft) {
    await replyLine(replyToken, "ไม่พบรายการนัดที่ค้างอยู่ (อาจหมดเวลา 30 นาที) — เริ่มเลือกช่วงเวลาใหม่อีกครั้งได้ครับ");
    return;
  }

  if (act === "setsubj") {
    draft.await = "subject";
    await saveDraft(upn, draft);
    await replyLine(replyToken, "พิมพ์หัวข้อประชุมมาได้เลยครับ (เช่น “อัปเดตงาน IT”)");
    return;
  }
  if (act === "setdetail") {
    draft.await = "detail";
    await saveDraft(upn, draft);
    await replyLine(replyToken, "พิมพ์รายละเอียด/วาระการประชุมมาได้เลยครับ (จะแนบไว้ในคำเชิญ)");
    return;
  }
  if (act === "addppl") {
    draft.await = "attendee";
    await saveDraft(upn, draft);
    await replyLine(replyToken, "พิมพ์ชื่อคนที่จะเพิ่มเข้าประชุมครับ (หลายคนคั่นด้วย , หรือขึ้นบรรทัดใหม่)");
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
      await createEvent(upn, draft.subject, wallIso(s), wallIso(e), draft.attendees, true, draft.detail || undefined);
      await clearDraft(upn);
      await replyLine(
        replyToken,
        `✅ ส่งนัดประชุมแล้ว!\n📌 ${draft.subject}\n🕐 ${draftWhen(draft)}` +
          (draft.detail ? `\n📝 ${draft.detail}` : "") +
          `\n👤 ${draft.attendees.join(", ")}`
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
  const text = (ev.message?.text || "").trim();
  if (!ev.replyToken || !userId || !text) return;

  const upn = await getUpnByLineId(userId);
  if (!upn) {
    await replyLineMessages(ev.replyToken, [linkPromptMessage()]);
    return;
  }
  try {
    // A pending booking draft awaiting subject/attendee input takes priority.
    if (await handleDraftInput(upn, text, ev.replyToken)) return;
    // Otherwise run the assistant (lite mode: no slow per-meeting enrichment)
    const ctx = await loadCtx(upn);
    const res = await handleCommand(upn, text, ctx, true);
    await sendResult(ev.replyToken, res);
    await saveCtx(upn, ctx, res);
  } catch (e) {
    await replyLine(ev.replyToken, `ขออภัยครับ เกิดข้อผิดพลาด: ${String(e).slice(0, 200)}`);
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
    // Booking confirmation flow (tap slot → draft → confirm) is handled here.
    if (BOOKING_ACTIONS.has(act)) {
      await handleBookingFlow(upn, act, data, ev.replyToken);
      return;
    }
    const res = await handleSelection(upn, data);
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
