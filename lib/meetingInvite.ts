// After a meeting is booked, notify attendees who already linked LINE and
// ask them to confirm attendance. Responses are stored briefly and the
// organizer gets a LINE ping when someone accepts/declines.
import { admin } from "@/lib/supabaseServer";
import { getLineId, pushLineMessages } from "@/lib/line";
import { getSetting, setSetting, deleteSetting } from "@/lib/store";
import { fmtDateTime, fmtTime, parseWall, parseHHMM, addMinutes, wallIso, wallToUtcIso } from "@/lib/time";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Re-ping unanswered LINE invitees this often. */
const NUDGE_INTERVAL_MS = 60 * 60 * 1000;
/** Escalate to organizer after this long with no reply. */
const HOST_ESCALATE_DAY_MS = 24 * 60 * 60 * 1000;
/** Escalate to organizer when meeting starts within this window. */
const HOST_ESCALATE_NEAR_MS = 2 * 60 * 60 * 1000;
const PENDING_RSVP_KEY = "_mt_rsvp_pending";
const HOST_EDIT_KEY = "_mt_host_edit";

export type MeetingInviteRecord = {
  id: string;
  organizerUpn: string;
  organizerName?: string;
  subject: string;
  start: string;
  end: string;
  eventId?: string;
  detail?: string;
  attendees: string[];
  /** LINE-linked attendees we are waiting on (subset of attendees). */
  awaitLine?: string[];
  /** pending = waiting confirm before Outlook; booked = created; cancelled = declined */
  status?: "pending" | "booked" | "cancelled";
  responses: Record<string, "accept" | "decline">;
  /** Last nudge timestamp per attendee UPN (ms) — hourly follow-up while unanswered. */
  nudgeAt?: Record<string, number>;
  /** Host already got “waited 1 day” escalation. */
  hostAlertDay?: boolean;
  /** Host already got “near start time” escalation. */
  hostAlertNear?: boolean;
  /** Attendee-proposed new time (from “เปลี่ยนเวลาเป็น…”) */
  proposedBy?: string;
  proposedHint?: string;
  proposedStart?: string;
  proposedEnd?: string;
  ts: number;
};

type PendingRsvp = {
  organizerUpn: string;
  inviteId: string;
  subject: string;
  start: string;
  end: string;
  ts: number;
};

function inviteKey(id: string): string {
  return `_mt_invite_${id}`;
}

function shortId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function whenLabel(startIso: string, endIso: string): string {
  const s = parseWall(startIso);
  const e = parseWall(endIso);
  if (s && e) return `${fmtDateTime(s)}-${fmtTime(e)}`;
  return `${startIso} – ${endIso}`;
}

async function setPendingRsvp(attendeeUpn: string, rec: MeetingInviteRecord): Promise<void> {
  const pending: PendingRsvp = {
    organizerUpn: rec.organizerUpn,
    inviteId: rec.id,
    subject: rec.subject,
    start: rec.start,
    end: rec.end,
    ts: Date.now(),
  };
  await setSetting(attendeeUpn.toLowerCase(), PENDING_RSVP_KEY, JSON.stringify(pending));
}

export async function getPendingRsvp(attendeeUpn: string): Promise<PendingRsvp | null> {
  const who = attendeeUpn.toLowerCase();
  try {
    const raw = await getSetting(who, PENDING_RSVP_KEY);
    if (raw) {
      const p = JSON.parse(raw) as PendingRsvp;
      if (p?.inviteId && p?.organizerUpn && p.ts && Date.now() - p.ts <= INVITE_TTL_MS) {
        return p;
      }
      await deleteSetting(who, PENDING_RSVP_KEY).catch(() => undefined);
    }
  } catch {
    /* fall through */
  }
  // Fallback: scan recent invites that include this attendee (covers accepts before pending pointer existed)
  try {
    const { data } = await admin.from("settings").select("owner_upn, key, value").like("key", "_mt_invite_%");
    let best: PendingRsvp | null = null;
    for (const row of data || []) {
      try {
        const rec = JSON.parse(row.value) as MeetingInviteRecord;
        if (!rec?.id || !rec.ts || Date.now() - rec.ts > INVITE_TTL_MS) continue;
        const inList = (rec.attendees || []).some((a) => a.toLowerCase() === who);
        if (!inList) continue;
        if (!best || rec.ts > best.ts) {
          best = {
            organizerUpn: rec.organizerUpn,
            inviteId: rec.id,
            subject: rec.subject,
            start: rec.start,
            end: rec.end,
            ts: rec.ts,
          };
        }
      } catch {
        /* skip */
      }
    }
    if (best) {
      await setSetting(who, PENDING_RSVP_KEY, JSON.stringify(best)).catch(() => undefined);
      return best;
    }
  } catch (e) {
    console.warn("[mt-invite] scan pending", String(e).slice(0, 120));
  }
  return null;
}

/** Free-text RSVP while a LINE invite is pending (works even before news onboarding). */
export function classifyMeetingRsvpText(text: string): "accept" | "decline" | null {
  const t = (text || "").trim();
  if (!t) return null;
  // Reschedule asks are handled separately — don't treat as decline
  if (isMeetingRescheduleText(t)) return null;
  if (
    /^(ยืนยัน(เข้าร่วม(นัด)?)?|เข้าร่วม(นัด)?|ไปได้|รับนัด|ตกลง|ok)$/i.test(t) ||
    /^ยืนยันเข้าร่วม/.test(t)
  ) {
    return "accept";
  }
  if (
    /ไม่สะดวก|ไปไม่ได้|ขอถอน|ติดธุระ|ขอโทษ.*(ไม่|ยกเลิก)|decline/i.test(t) ||
    /ยกเลิก(นัด|การเข้าร่วม|ให้)?/.test(t) ||
    /^\/?ยกเลิก$/.test(t)
  ) {
    return "decline";
  }
  return null;
}

/** Attendee asking to move the meeting time (e.g. เปลี่ยนเวลาเป็นบ่าย3). */
export function isMeetingRescheduleText(text: string): boolean {
  const t = (text || "").trim();
  if (!t) return false;
  return /เปลี่ยนเวลา|เลื่อน(นัด|เวลา|ประชุม)?|ขอเลื่อน|ย้ายเวลา|เลื่อนไป|เปลี่ยนเป็น|ขอเปลี่ยน/.test(t);
}

/** Best-effort parse of requested time for the host notification. */
export function extractRescheduleHint(text: string): string {
  const t = text.trim();
  const hhmm = t.match(/(\d{1,2})\s*[:.]\s*(\d{2})/);
  if (hhmm) {
    const h = Number(hhmm[1]);
    const m = Number(hhmm[2]);
    if (h < 24 && m < 60) return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  }
  const bai = t.match(/บ่าย\s*(\d{1,2}|หนึ่ง|สอง|สาม|สี่|ห้า|หก)/);
  if (bai) {
    const map: Record<string, number> = { หนึ่ง: 1, สอง: 2, สาม: 3, สี่: 4, ห้า: 5, หก: 6 };
    const n = map[bai[1]] ?? Number(bai[1]);
    if (n >= 1 && n <= 6) return `${String(n === 1 ? 13 : n + 12).padStart(2, "0")}:00`;
  }
  const chao = t.match(/เช้า\s*(\d{1,2})/);
  if (chao) {
    const n = Number(chao[1]);
    if (n >= 6 && n <= 11) return `${String(n).padStart(2, "0")}:00`;
  }
  const mong = t.match(/(\d{1,2})\s*โมง/);
  if (mong) {
    let h = Number(mong[1]);
    if (h < 7) h += 12;
    if (h < 24) return `${String(h).padStart(2, "0")}:00`;
  }
  return t.slice(0, 80);
}

/** Map a time hint onto the original meeting's calendar day, keeping duration. */
export function windowFromRescheduleHint(
  startIso: string,
  endIso: string,
  hint: string
): { start: string; end: string } | null {
  const start = parseWall(startIso);
  const end = parseWall(endIso);
  if (!start || !end) return null;
  const dur = Math.max(5, Math.round((end.getTime() - start.getTime()) / 60_000));
  let mins = parseHHMM(hint);
  if (mins == null) {
    const m = hint.match(/(\d{1,2})\s*[:.]\s*(\d{2})/);
    if (m) {
      const h = Number(m[1]);
      const mi = Number(m[2]);
      if (h < 24 && mi < 60) mins = h * 60 + mi;
    }
  }
  if (mins == null) {
    const normalized = extractRescheduleHint(hint);
    mins = parseHHMM(normalized);
  }
  if (mins == null) return null;
  const ns = new Date(start);
  ns.setUTCHours(Math.floor(mins / 60), mins % 60, 0, 0);
  const ne = addMinutes(ns, dur);
  return { start: wallIso(ns), end: wallIso(ne) };
}

export async function tryHandleMeetingRescheduleText(
  responderUpn: string,
  text: string
): Promise<{ ok: boolean; reply: string } | null> {
  if (!isMeetingRescheduleText(text)) return null;
  const pending = await getPendingRsvp(responderUpn);
  if (!pending) return null;

  const who = responderUpn.toLowerCase();
  const when = whenLabel(pending.start, pending.end);
  const hint = extractRescheduleHint(text);
  const win = windowFromRescheduleHint(pending.start, pending.end, hint);

  const rec = await readInvite(pending.organizerUpn, pending.inviteId);
  if (rec) {
    rec.proposedBy = who;
    rec.proposedHint = hint;
    if (win) {
      rec.proposedStart = win.start;
      rec.proposedEnd = win.end;
    }
    await saveInvite(rec.organizerUpn, rec);
  }

  const orgLine = await getLineId(pending.organizerUpn);
  const proposedLabel = win ? whenLabel(win.start, win.end) : hint;

  if (orgLine) {
    try {
      const oid = encodeURIComponent(pending.organizerUpn);
      await pushLineMessages(orgLine, [
        {
          type: "text",
          text:
            `📬 คำขอเปลี่ยนเวลานัด\n` +
            `📌 ${pending.subject}\n` +
            `🕐 เดิม: ${when}\n` +
            `🙋 ${who} ขอเป็นประมาณ ${proposedLabel}\n` +
            `💬 “${text.trim().slice(0, 120)}”\n\n` +
            `จะเอาตามที่ขอ เปลี่ยนเอง หรือยกเลิกนัดครับ?`,
          quickReply: {
            items: [
              {
                type: "action",
                action: {
                  type: "postback",
                  label: "✅ เอาตามที่ขอ",
                  data: `a=mthostok&oid=${oid}&id=${pending.inviteId}`,
                  displayText: "เอาตามที่อีกฝั่งขอ",
                },
              },
              {
                type: "action",
                action: {
                  type: "postback",
                  label: "🕐 เปลี่ยนเอง",
                  data: `a=mthostedit&oid=${oid}&id=${pending.inviteId}`,
                  displayText: "เปลี่ยนเวลาเอง",
                },
              },
              {
                type: "action",
                action: {
                  type: "postback",
                  label: "❌ ยกเลิกนัด",
                  data: `a=mthostcancel&oid=${oid}&id=${pending.inviteId}`,
                  displayText: "ยกเลิกนัดนี้",
                },
              },
            ],
          },
        },
      ]);
    } catch (e) {
      console.warn("[mt-invite] reschedule notify host", String(e).slice(0, 120));
      return {
        ok: false,
        reply: "รับทราบครับ แต่ส่งแจ้งเตือนถึงเจ้าของนัดไม่สำเร็จ ลองติดต่อโดยตรงอีกครั้งนะครับ",
      };
    }
  } else {
    return {
      ok: true,
      reply:
        `รับทราบครับ บันทึกว่าต้องการเปลี่ยนเป็นประมาณ ${hint}\n` +
        `แต่เจ้าของนัดยังไม่ได้เชื่อม LINE — กรุณาแจ้ง ${pending.organizerUpn} โดยตรงด้วยนะครับ`,
    };
  }

  return {
    ok: true,
    reply:
      `รับทราบครับ ส่งคำขอเปลี่ยนเวลาไปยังเจ้าของนัดแล้ว ✅\n` +
      `📌 ${pending.subject}\n` +
      `🕐 เดิม: ${when}\n` +
      `➡️ ขอเป็นประมาณ ${proposedLabel}\n\n` +
      `รอเจ้าของนัดตอบนะครับ`,
  };
}

export async function tryHandleMeetingRsvpText(
  responderUpn: string,
  text: string
): Promise<{ ok: boolean; reply: string; quickReply?: object } | null> {
  const t = text.trim();
  const pending = await getPendingRsvp(responderUpn);

  if (pending && /^(ยกเลิกนัดนี้|ยืนยันยกเลิก)$/i.test(t)) {
    return handleMeetingInviteChoice(responderUpn, "mtcancel", pending.organizerUpn, pending.inviteId);
  }
  if (pending && /^(ขอเปลี่ยนวันเวลา|เปลี่ยนวันเวลา)$/i.test(t)) {
    return handleMeetingInviteChoice(responderUpn, "mtresched", pending.organizerUpn, pending.inviteId);
  }

  const kind = classifyMeetingRsvpText(text);
  if (!kind) return null;
  if (!pending) return null;
  return respondMeetingInvite(responderUpn, pending.organizerUpn, pending.inviteId, kind === "accept");
}

/** True when text looks like RSVP (used to keep news onboarding from stealing it). */
export function isMeetingRsvpText(text: string): boolean {
  return classifyMeetingRsvpText(text) != null;
}

/** Look up LINE user ids for M365 emails that already linked the bot. */
export async function findLinkedLineAttendees(
  emails: string[],
  excludeUpn?: string
): Promise<{ upn: string; lineUserId: string }[]> {
  const wanted = Array.from(
    new Set(emails.map((e) => e.trim().toLowerCase()).filter((e) => e.includes("@")))
  ).filter((e) => !excludeUpn || e !== excludeUpn.toLowerCase());
  if (!wanted.length) return [];

  const { data } = await admin.from("line_links").select("upn, line_user_id").in("upn", wanted);
  return (data || [])
    .filter((r) => r.upn && r.line_user_id)
    .map((r) => ({ upn: String(r.upn).toLowerCase(), lineUserId: String(r.line_user_id) }));
}

async function saveInvite(ownerUpn: string, rec: MeetingInviteRecord): Promise<void> {
  await setSetting(ownerUpn, inviteKey(rec.id), JSON.stringify(rec));
}

export async function readInvite(ownerUpn: string, id: string): Promise<MeetingInviteRecord | null> {
  try {
    const raw = await getSetting(ownerUpn, inviteKey(id));
    if (!raw) return null;
    const rec = JSON.parse(raw) as MeetingInviteRecord;
    if (!rec.ts || Date.now() - rec.ts > INVITE_TTL_MS) {
      await deleteSetting(ownerUpn, inviteKey(id)).catch(() => undefined);
      return null;
    }
    return rec;
  } catch {
    return null;
  }
}

function inviteMessage(rec: MeetingInviteRecord, opts?: { nudge?: boolean }): object {
  const who = rec.organizerName || rec.organizerUpn;
  const pending = !rec.eventId && rec.status !== "booked";
  const oid = encodeURIComponent(rec.organizerUpn);
  const nudge = !!opts?.nudge;
  const text = nudge
    ? "⏰ ติดตามคำขอนัด — ยังไม่ได้คำตอบครับ\n\n" +
      `📌 ${rec.subject}\n` +
      `🕐 ${whenLabel(rec.start, rec.end)}\n` +
      `👤 จาก: ${who}` +
      (rec.detail ? `\n📝 ${rec.detail}` : "") +
      "\n\nกรุณายืนยันด้วยครับ (กดปุ่มด้านล่าง) 👇"
    : pending
      ? "📅 มีคำขอนัดประชุมถึงคุณ\n\n" +
        `📌 ${rec.subject}\n` +
        `🕐 ${whenLabel(rec.start, rec.end)}\n` +
        `👤 จาก: ${who}` +
        (rec.detail ? `\n📝 ${rec.detail}` : "") +
        "\n\nยังไม่ได้สร้างใน Outlook — กรุณายืนยันก่อนครับ\n(กดปุ่มด้านล่างได้เลยครับ) 👇"
      : "📅 คุณถูกเชิญเข้าประชุม\n\n" +
        `📌 ${rec.subject}\n` +
        `🕐 ${whenLabel(rec.start, rec.end)}\n` +
        `👤 จัดโดย: ${who}` +
        (rec.detail ? `\n📝 ${rec.detail}` : "") +
        "\n\nกรุณายืนยันการเข้าร่วมนัดนี้ครับ\n(กดปุ่มด้านล่างได้เลยครับ) 👇";

  const accept = `a=mtaccept&oid=${oid}&id=${rec.id}`;
  const decline = `a=mtdecline&oid=${oid}&id=${rec.id}`;
  const resched = `a=mtresched&oid=${oid}&id=${rec.id}`;

  return {
    type: "text",
    text,
    quickReply: {
      items: [
        {
          type: "action",
          action: {
            type: "postback",
            label: pending ? "✅ ยืนยันนัดนี้" : "✅ ยืนยันเข้าร่วม",
            data: accept,
            displayText: pending ? "ยืนยันนัดนี้" : "ยืนยันเข้าร่วมนัด",
          },
        },
        {
          type: "action",
          action: {
            type: "postback",
            label: "🕐 เปลี่ยนเวลา",
            data: resched,
            displayText: "ขอเปลี่ยนวันเวลา",
          },
        },
        {
          type: "action",
          action: { type: "postback", label: "❌ ไม่สะดวก", data: decline, displayText: "ไม่สะดวกเข้าร่วม" },
        },
      ],
    },
  };
}

function rsvpFollowUpQuickReply(rec: MeetingInviteRecord, accepted: boolean): object {
  const accept = `a=mtaccept&oid=${encodeURIComponent(rec.organizerUpn)}&id=${rec.id}`;
  const decline = `a=mtdecline&oid=${encodeURIComponent(rec.organizerUpn)}&id=${rec.id}`;
  return {
    items: accepted
      ? [
          {
            type: "action",
            action: { type: "postback", label: "❌ ยกเลิกการเข้าร่วม", data: decline, displayText: "ไม่สะดวกเข้าร่วม" },
          },
        ]
      : [
          {
            type: "action",
            action: { type: "postback", label: "✅ ยืนยันเข้าร่วม", data: accept, displayText: "ยืนยันเข้าร่วมนัด" },
          },
        ],
  };
}

/** After “ไม่สะดวก” — ask cancel vs reschedule. */
function declineChoiceQuickReply(rec: MeetingInviteRecord): object {
  const oid = encodeURIComponent(rec.organizerUpn);
  return {
    items: [
      {
        type: "action",
        action: {
          type: "postback",
          label: "❌ ยกเลิกนัดนี้",
          data: `a=mtcancel&oid=${oid}&id=${rec.id}`,
          displayText: "ยกเลิกนัดนี้",
        },
      },
      {
        type: "action",
        action: {
          type: "postback",
          label: "🕐 เปลี่ยนวันเวลา",
          data: `a=mtresched&oid=${oid}&id=${rec.id}`,
          displayText: "ขอเปลี่ยนวันเวลา",
        },
      },
    ],
  };
}

function hostRescheduleMessage(attendeeHint?: string): string {
  const who = (attendeeHint || "").trim().toLowerCase();
  if (!who) return "นัดประชุม ";
  // Prefer full email so Graph/resolve finds the person (local part alone often fails)
  return who.includes("@") ? `นัด ${who}` : `นัด ${who} `;
}

function hostNextStepQuickReply(attendeeHint?: string): object {
  return {
    items: [
      {
        type: "action",
        action: {
          type: "message",
          label: "📅 หาเวลาใหม่",
          text: hostRescheduleMessage(attendeeHint),
        },
      },
    ],
  };
}

async function notifyHostDeclineFinal(rec: MeetingInviteRecord, who: string, kind: "cancel" | "busy"): Promise<void> {
  const when = whenLabel(rec.start, rec.end);
  const orgLine = await getLineId(rec.organizerUpn);
  if (!orgLine) return;
  const holding = !rec.eventId && rec.status !== "booked";
  await pushLineMessages(orgLine, [
    {
      type: "text",
      text:
        (kind === "cancel" ? `📬 อีกฝั่งยกเลิกคำขอนัด\n` : `📬 อัปเดตการยืนยันนัด\n`) +
        `📌 ${rec.subject}\n` +
        `🕐 ${when}\n` +
        `👤 ${who} ไม่สะดวก ❌\n\n` +
        (holding ? "ยังไม่ได้สร้างนัดใน Outlook ครับ\n\n" : "") +
        `ต้องการหาเวลาใหม่ไหมครับ?`,
      quickReply: hostNextStepQuickReply(who),
    },
  ]);
}

/**
 * Push a meeting proposal to LINE-linked attendees WITHOUT creating Outlook yet.
 * Host creates the calendar event only after they accept.
 */
export async function notifyMeetingInviteOnLine(opts: {
  organizerUpn: string;
  organizerName?: string;
  subject: string;
  startIso: string;
  endIso: string;
  attendees: string[];
  eventId?: string;
  detail?: string;
  /** When true (default), do not require an existing Outlook event — wait for accept first. */
  holdUntilAccept?: boolean;
}): Promise<{ notified: number; names: string[]; held: boolean }> {
  const linked = await findLinkedLineAttendees(opts.attendees, opts.organizerUpn);
  if (!linked.length) return { notified: 0, names: [], held: false };

  const hold = opts.holdUntilAccept !== false && !opts.eventId;
  const id = shortId();
  const now = Date.now();
  const linkedUpns = linked.map((p) => p.upn);
  const nudgeAt: Record<string, number> = {};
  for (const u of linkedUpns) nudgeAt[u] = now;
  const rec: MeetingInviteRecord = {
    id,
    organizerUpn: opts.organizerUpn.toLowerCase(),
    organizerName: opts.organizerName,
    subject: opts.subject,
    start: opts.startIso,
    end: opts.endIso,
    eventId: opts.eventId,
    detail: opts.detail,
    attendees: opts.attendees.map((a) => a.toLowerCase()),
    awaitLine: linkedUpns,
    status: hold ? "pending" : opts.eventId ? "booked" : "pending",
    responses: {},
    nudgeAt,
    ts: now,
  };
  await saveInvite(rec.organizerUpn, rec);

  const msg = inviteMessage(rec);
  const names: string[] = [];
  for (const person of linked) {
    try {
      await setPendingRsvp(person.upn, rec);
      await pushLineMessages(person.lineUserId, [msg]);
      names.push(person.upn);
    } catch (e) {
      console.warn("[mt-invite] push failed", person.upn, String(e).slice(0, 120));
    }
  }
  return { notified: names.length, names, held: hold && names.length > 0 };
}

export type BookWithHoldResult = {
  mode: "proposed" | "booked";
  notified: number;
  names: string[];
  eventId?: string;
  joinUrl?: string;
  note: string;
};

/**
 * Prefer LINE confirm-first when attendees are linked; otherwise create Outlook immediately.
 * `create` runs only when we are not holding for LINE confirm.
 */
export async function bookMeetingWithLineHold(opts: {
  organizerUpn: string;
  subject: string;
  startIso: string;
  endIso: string;
  attendees: string[];
  detail?: string;
  create: () => Promise<
    | { id?: string; onlineMeeting?: { joinUrl?: string } | null }
    | null
    | undefined
  >;
}): Promise<BookWithHoldResult> {
  const linked = await findLinkedLineAttendees(opts.attendees, opts.organizerUpn);
  if (linked.length > 0) {
    const ping = await notifyMeetingInviteOnLine({
      organizerUpn: opts.organizerUpn,
      subject: opts.subject,
      startIso: opts.startIso,
      endIso: opts.endIso,
      attendees: opts.attendees,
      detail: opts.detail,
      holdUntilAccept: true,
    });
    return {
      mode: "proposed",
      notified: ping.notified,
      names: ping.names,
      note:
        `\n\n⏳ ยังไม่สร้างใน Outlook — ส่งคำขอทาง LINE แล้ว ${ping.notified} คน\n` +
        `จะสร้างนัดให้อัตโนมัติเมื่ออีกฝั่งกดยืนยันครับ\n` +
        `ถ้ายังไม่ตอบ ระบบจะติดตามทุก 1 ชม. และถ้าครบ 1 วันหรือใกล้ถึงเวลานัด จะถามคุณว่าจะทำอย่างไรต่อครับ`,
    };
  }

  const ev = await opts.create();
  const joinUrl = ev?.onlineMeeting?.joinUrl || undefined;
  return {
    mode: "booked",
    notified: 0,
    names: [],
    eventId: ev?.id,
    joinUrl,
    note: opts.attendees.length
      ? "\n\n📲 ผู้เข้าร่วมยังไม่ได้ผูก LINE — ส่งคำเชิญทาง Outlook แล้วครับ" + teamsNoteForChat(joinUrl)
      : teamsNoteForChat(joinUrl),
  };
}

function teamsNoteForChat(joinUrl?: string): string {
  if (!joinUrl) return "\n\n⚠️ นัดมีใน Outlook แล้ว — เปิด Outlook เพื่อดูลิงก์ Teams";
  const short = joinUrl.match(/https:\/\/teams\.microsoft\.com\/meet\/[^\s"'<>]+/i)?.[0];
  if (short) return `\n\n🔗 Teams: ${short}`;
  return "\n\n🔗 ดูลิงก์ Teams ใน Outlook / อีเมลคำเชิญ";
}

function linkedAwaitList(rec: MeetingInviteRecord): string[] {
  if (rec.awaitLine?.length) return rec.awaitLine.map((a) => a.toLowerCase());
  return (rec.attendees || []).map((a) => a.toLowerCase());
}

export async function respondMeetingInvite(
  responderUpn: string,
  organizerUpn: string,
  inviteId: string,
  accept: boolean
): Promise<{ ok: boolean; reply: string; quickReply?: object }> {
  const rec = await readInvite(organizerUpn.toLowerCase(), inviteId);
  if (!rec) {
    return { ok: false, reply: "ไม่พบนัดนี้แล้วครับ (อาจหมดอายุหรือถูกยกเลิก)" };
  }
  if (rec.status === "cancelled") {
    return { ok: false, reply: "คำขอนัดนี้ถูกยกเลิกไปแล้วครับ" };
  }

  const who = responderUpn.toLowerCase();
  rec.responses[who] = accept ? "accept" : "decline";
  await saveInvite(rec.organizerUpn, rec);
  await setPendingRsvp(who, rec).catch(() => undefined);

  // Decline → notify host immediately, then ask attendee cancel vs reschedule
  if (!accept) {
    const when = whenLabel(rec.start, rec.end);
    const holding = !rec.eventId && rec.status !== "booked";
    try {
      const orgLine = await getLineId(rec.organizerUpn);
      if (orgLine) {
        const oid = encodeURIComponent(rec.organizerUpn);
        await pushLineMessages(orgLine, [
          {
            type: "text",
            text:
              `📬 อัปเดตคำขอนัด\n` +
              `📌 ${rec.subject}\n` +
              `🕐 ${when}\n` +
              `👤 ${who} กดไม่สะดวก ❌\n\n` +
              (holding ? "ยังไม่ได้สร้างใน Outlook ครับ\n" : "") +
              `ระบบกำลังถามอีกฝั่งว่าจะยกเลิก หรือขอเปลี่ยนวันเวลา — รอสักครู่ หรือกดหาเวลาใหม่ได้เลยครับ`,
            quickReply: {
              items: [
                {
                  type: "action",
                  action: {
                    type: "message",
                    label: "📅 หาเวลาใหม่",
                    text: hostRescheduleMessage(who),
                  },
                },
                {
                  type: "action",
                  action: {
                    type: "postback",
                    label: "❌ ยกเลิกคำขอ",
                    data: `a=mthostcancel&oid=${oid}&id=${rec.id}`,
                    displayText: "ยกเลิกนัดนี้",
                  },
                },
                {
                  type: "action",
                  action: { type: "message", label: "รออีกฝั่งก่อน", text: "รับทราบ รออีกฝั่ง" },
                },
              ],
            },
          },
        ]);
      } else {
        console.warn("[mt-invite] host has no LINE link", rec.organizerUpn);
      }
    } catch (e) {
      console.warn("[mt-invite] notify host on decline", String(e).slice(0, 150));
    }
    return {
      ok: true,
      reply:
        `รับทราบว่าช่วงนี้ไม่สะดวกครับ\n📌 ${rec.subject}\n🕐 ${when}\n\n` +
        `แจ้งเจ้าของนัดแล้ว — ต้องการยกเลิกนัดนี้ หรือขอเปลี่ยนวันเวลาครับ?`,
      quickReply: declineChoiceQuickReply(rec),
    };
  }

  const holding = !rec.eventId && rec.status !== "booked";
  const awaiting = linkedAwaitList(rec);
  const when = whenLabel(rec.start, rec.end);

  // Accept while holding → create Outlook only when everyone we're waiting on has accepted
  if (holding) {
    const allAccepted = awaiting.every((u) => rec.responses[u] === "accept");
    if (!allAccepted) {
      const pending = awaiting.filter((u) => rec.responses[u] !== "accept");
      try {
        const orgLine = await getLineId(rec.organizerUpn);
        if (orgLine) {
          await pushLineMessages(orgLine, [
            {
              type: "text",
              text:
                `📬 อัปเดตคำขอนัด\n` +
                `📌 ${rec.subject}\n` +
                `🕐 ${when}\n` +
                `👤 ${who} ยืนยันแล้ว ✅\n` +
                `⏳ รออีก ${pending.length} คนก่อนสร้างใน Outlook`,
            },
          ]);
        }
      } catch {
        /* ignore */
      }
      return {
        ok: true,
        reply:
          `✅ บันทึกการยืนยันแล้วครับ\n📌 ${rec.subject}\n🕐 ${when}\n\n` +
          `รอผู้เข้าร่วมคนอื่นยืนยันครบก่อน จึงจะสร้างนัดใน Outlook`,
        quickReply: rsvpFollowUpQuickReply(rec, true),
      };
    }

    // Everyone accepted → create Outlook event as the organizer
    let createdId: string | undefined;
    let createErr: string | undefined;
    try {
      const { withDelegatedGraph } = await import("@/lib/msGraphOAuth");
      const { createEvent } = await import("@/lib/graph");
      const { result: ev, asUser } = await withDelegatedGraph(rec.organizerUpn, () =>
        createEvent(rec.organizerUpn, rec.subject, rec.start, rec.end, rec.attendees, true, rec.detail)
      );
      if (!asUser) {
        createErr = "เจ้าของนัดยังไม่ได้ให้สิทธิ์ปฏิทิน";
      } else {
        createdId = ev?.id;
      }
    } catch (e) {
      createErr = String(e).slice(0, 120);
      console.warn("[mt-invite] create on accept", createErr);
    }

    if (createdId) {
      rec.eventId = createdId;
      rec.status = "booked";
      await saveInvite(rec.organizerUpn, rec);
    }

    try {
      const orgLine = await getLineId(rec.organizerUpn);
      if (orgLine) {
        await pushLineMessages(orgLine, [
          {
            type: "text",
            text: createdId
              ? `📬 อีกฝั่งยืนยันแล้ว — สร้างนัดใน Outlook แล้ว ✅\n📌 ${rec.subject}\n🕐 ${when}\n👤 ${who}`
              : `📬 อีกฝั่งยืนยันแล้ว แต่สร้างนัดใน Outlook ไม่สำเร็จ\n📌 ${rec.subject}\n🕐 ${when}\n⚠️ ${createErr || "unknown"}\nกรุณาสร้างนัดเองใน Outlook ครับ`,
          },
        ]);
      }
    } catch {
      /* ignore */
    }

    return {
      ok: true,
      reply: createdId
        ? `✅ ยืนยันแล้วครับ — สร้างนัดใน Outlook ให้แล้ว\n📌 ${rec.subject}\n🕐 ${when}\n\nถ้าไม่สะดวกทีหลัง พิมพ์ “ยกเลิก” ได้ครับ`
        : `✅ ยืนยันแล้วครับ\n📌 ${rec.subject}\n🕐 ${when}\n\nแต่ยังสร้างใน Outlook ไม่ได้ ระบบแจ้งเจ้าของนัดแล้วครับ`,
      quickReply: rsvpFollowUpQuickReply(rec, true),
    };
  }

  // Already booked (legacy path) — accept only (decline returns earlier with choice ask)
  try {
    const orgLine = await getLineId(rec.organizerUpn);
    if (orgLine) {
      await pushLineMessages(orgLine, [
        {
          type: "text",
          text: `📬 อัปเดตการยืนยันนัด\n📌 ${rec.subject}\n🕐 ${when}\n👤 ${who} ยืนยันเข้าร่วมแล้ว ✅`,
        },
      ]);
    }
  } catch {
    /* best-effort */
  }

  return {
    ok: true,
    reply:
      `✅ ยืนยันเข้าร่วมแล้วครับ\n📌 ${rec.subject}\n🕐 ${when}\n\n` +
      `นัดนี้อยู่ในปฏิทิน Outlook ของคุณด้วยครับ\nถ้าไม่สะดวกทีหลัง พิมพ์ “ยกเลิก” หรือกดปุ่มด้านล่างได้ครับ`,
    quickReply: rsvpFollowUpQuickReply(rec, true),
  };
}

/** Attendee chose “ยกเลิกนัดนี้” or “เปลี่ยนวันเวลา” after ไม่สะดวก. */
export async function handleMeetingInviteChoice(
  responderUpn: string,
  act: string,
  organizerUpn: string,
  inviteId: string
): Promise<{ ok: boolean; reply: string; quickReply?: object } | null> {
  if (act !== "mtcancel" && act !== "mtresched") return null;

  const rec = await readInvite(organizerUpn.toLowerCase(), inviteId);
  if (!rec) {
    return { ok: false, reply: "ไม่พบนัดนี้แล้วครับ (อาจหมดอายุหรือถูกยกเลิก)" };
  }

  const who = responderUpn.toLowerCase();
  await setPendingRsvp(who, rec).catch(() => undefined);

  if (act === "mtresched") {
    return {
      ok: true,
      reply:
        `ได้ครับ พิมพ์วันเวลาที่สะดวกมาได้เลย เช่น\n` +
        `• พรุ่งนี้ 15:00\n` +
        `• เปลี่ยนเวลาเป็นบ่าย 3\n` +
        `• วันนี้ 16:00-16:30\n\n` +
        `ระบบจะส่งคำขอไปให้เจ้าของนัดครับ`,
    };
  }

  // mtcancel — finalize
  rec.responses[who] = "decline";
  rec.status = "cancelled";
  await saveInvite(rec.organizerUpn, rec);

  // If Outlook event already existed, try delete
  if (rec.eventId) {
    try {
      const { withDelegatedGraph } = await import("@/lib/msGraphOAuth");
      const { deleteEvent } = await import("@/lib/graph");
      await withDelegatedGraph(rec.organizerUpn, () => deleteEvent(rec.organizerUpn, rec.eventId!));
    } catch (e) {
      console.warn("[mt-invite] delete on cancel", String(e).slice(0, 120));
    }
  }

  try {
    await notifyHostDeclineFinal(rec, who, "cancel");
  } catch {
    /* best-effort */
  }

  const when = whenLabel(rec.start, rec.end);
  return {
    ok: true,
    reply: `รับทราบครับ ยกเลิกคำขอนัดแล้ว\n📌 ${rec.subject}\n🕐 ${when}\n\nแจ้งเจ้าของนัดเรียบร้อยแล้วครับ`,
  };
}

async function notifyAttendeeOfHostDecision(
  rec: MeetingInviteRecord,
  text: string
): Promise<void> {
  const targets = Array.from(
    new Set([...(rec.awaitLine || []), ...(rec.attendees || []), rec.proposedBy || ""].map((x) => x.toLowerCase()).filter(Boolean))
  ).filter((u) => u !== rec.organizerUpn);
  for (const upn of targets) {
    try {
      const lineId = await getLineId(upn);
      if (lineId) await pushLineMessages(lineId, [{ type: "text", text }]);
    } catch {
      /* ignore */
    }
  }
}

async function createOrUpdateOutlook(
  rec: MeetingInviteRecord,
  startIso: string,
  endIso: string
): Promise<{ id?: string; error?: string }> {
  try {
    const { withDelegatedGraph } = await import("@/lib/msGraphOAuth");
    const { createEvent, deleteEvent } = await import("@/lib/graph");
    if (rec.eventId) {
      try {
        await withDelegatedGraph(rec.organizerUpn, () => deleteEvent(rec.organizerUpn, rec.eventId!));
      } catch {
        /* best-effort replace */
      }
    }
    const { result: ev, asUser } = await withDelegatedGraph(rec.organizerUpn, () =>
      createEvent(rec.organizerUpn, rec.subject, startIso, endIso, rec.attendees, true, rec.detail)
    );
    if (!asUser) return { error: "ยังไม่ได้ให้สิทธิ์ปฏิทิน" };
    return { id: ev?.id };
  } catch (e) {
    return { error: String(e).slice(0, 120) };
  }
}

/** Host replies to attendee reschedule / escalation: accept / edit / cancel / force / wait. */
export async function handleHostRescheduleChoice(
  hostUpn: string,
  act: string,
  organizerUpn: string,
  inviteId: string
): Promise<{ ok: boolean; reply: string; quickReply?: object } | null> {
  if (!["mthostok", "mthostedit", "mthostcancel", "mthostforce", "mthostwait"].includes(act)) return null;

  if (hostUpn.toLowerCase() !== organizerUpn.toLowerCase()) {
    return { ok: false, reply: "เฉพาะเจ้าของนัดเท่านั้นที่ตอบคำขอนี้ได้ครับ" };
  }

  const rec = await readInvite(organizerUpn.toLowerCase(), inviteId);
  if (!rec) {
    return { ok: false, reply: "ไม่พบคำขอนัดนี้แล้วครับ" };
  }

  if (act === "mthostwait") {
    const awaiting = linkedAwaitList(rec).filter((u) => !rec.responses[u]);
    return {
      ok: true,
      reply:
        `รับทราบครับ — จะรอและติดตามอีกฝั่งต่อให้\n` +
        `📌 ${rec.subject}\n🕐 ${whenLabel(rec.start, rec.end)}\n` +
        (awaiting.length ? `⏳ ยังรอ: ${awaiting.join(", ")}` : ""),
    };
  }

  if (act === "mthostforce") {
    if (rec.status === "cancelled") {
      return { ok: false, reply: "คำขอนัดนี้ถูกยกเลิกไปแล้วครับ" };
    }
    if (rec.eventId && rec.status === "booked") {
      return {
        ok: true,
        reply: `นัดนี้อยู่ใน Outlook แล้วครับ\n📌 ${rec.subject}\n🕐 ${whenLabel(rec.start, rec.end)}`,
      };
    }
    const created = await createOrUpdateOutlook(rec, rec.start, rec.end);
    if (created.id) {
      rec.eventId = created.id;
      rec.status = "booked";
      await saveInvite(rec.organizerUpn, rec);
      await notifyAttendeeOfHostDecision(
        rec,
        `📬 เจ้าของนัดสร้างนัดใน Outlook แล้ว (ยังไม่รอคำยืนยันเพิ่ม)\n` +
          `📌 ${rec.subject}\n🕐 ${whenLabel(rec.start, rec.end)}\n\n` +
          `ถ้าไม่สะดวก แจ้งเจ้าของนัดได้โดยตรงครับ`
      );
      return {
        ok: true,
        reply:
          `✅ สร้างนัดใน Outlook แล้วครับ\n📌 ${rec.subject}\n🕐 ${whenLabel(rec.start, rec.end)}\n\n` +
          `แจ้งอีกฝั่งแล้วว่าสร้างนัดโดยไม่รอคำยืนยัน`,
        quickReply: hostNextStepQuickReply(rec.attendees[0]),
      };
    }
    return {
      ok: false,
      reply: `⚠️ สร้างนัดไม่สำเร็จ: ${created.error || "unknown"}\nลองให้สิทธิ์ปฏิทินแล้วกดอีกครั้งได้ครับ`,
    };
  }

  if (act === "mthostedit") {
    await setSetting(
      hostUpn.toLowerCase(),
      HOST_EDIT_KEY,
      JSON.stringify({ inviteId: rec.id, organizerUpn: rec.organizerUpn, ts: Date.now() })
    );
    return {
      ok: true,
      reply:
        `ได้ครับ พิมพ์วันเวลาใหม่มาได้เลย เช่น\n` +
        `• พรุ่งนี้ 16:00\n` +
        `• 15:30\n` +
        `• วันนี้ 17:00-17:30`,
    };
  }

  if (act === "mthostcancel") {
    rec.status = "cancelled";
    await saveInvite(rec.organizerUpn, rec);
    await deleteSetting(hostUpn.toLowerCase(), HOST_EDIT_KEY).catch(() => undefined);
    if (rec.eventId) {
      try {
        const { withDelegatedGraph } = await import("@/lib/msGraphOAuth");
        const { deleteEvent } = await import("@/lib/graph");
        await withDelegatedGraph(rec.organizerUpn, () => deleteEvent(rec.organizerUpn, rec.eventId!));
      } catch {
        /* ignore */
      }
    }
    const when = whenLabel(rec.start, rec.end);
    await notifyAttendeeOfHostDecision(
      rec,
      `📬 เจ้าของนัดยกเลิกคำขอนัดแล้ว\n📌 ${rec.subject}\n🕐 ${when}`
    );
    return {
      ok: true,
      reply: `ยกเลิกนัดแล้วครับ\n📌 ${rec.subject}\n🕐 ${when}\n\nแจ้งอีกฝั่งเรียบร้อยแล้ว`,
    };
  }

  // mthostok — accept proposed time
  const startIso = rec.proposedStart || "";
  const endIso = rec.proposedEnd || "";
  if (!startIso || !endIso) {
    await setSetting(
      hostUpn.toLowerCase(),
      HOST_EDIT_KEY,
      JSON.stringify({ inviteId: rec.id, organizerUpn: rec.organizerUpn, ts: Date.now() })
    );
    return {
      ok: false,
      reply:
        `ยังอ่านเวลาที่อีกฝั่งขอไม่ชัดครับ (ได้แค่ “${rec.proposedHint || "?"}”)\n` +
        `พิมพ์วันเวลาที่ต้องการจองมาได้เลย เช่น 15:00 หรือ พรุ่งนี้ 15:00`,
    };
  }

  const created = await createOrUpdateOutlook(rec, startIso, endIso);
  if (created.id) {
    rec.start = startIso;
    rec.end = endIso;
    rec.eventId = created.id;
    rec.status = "booked";
    // Clear soft decline so attendees are treated as confirmed for this slot
    if (rec.proposedBy) rec.responses[rec.proposedBy] = "accept";
    await saveInvite(rec.organizerUpn, rec);
  }

  const when = whenLabel(startIso, endIso);
  await notifyAttendeeOfHostDecision(
    rec,
    created.id
      ? `📬 เจ้าของนัดตกลงตามเวลาที่คุณขอแล้ว ✅\n📌 ${rec.subject}\n🕐 ${when}\n\nสร้างใน Outlook แล้วครับ`
      : `📬 เจ้าของนัดตกลงเวลา ${when} แต่สร้างใน Outlook ไม่สำเร็จ\n⚠️ ${created.error || ""}\nรอเจ้าของนัดสร้างให้อีกครั้งนะครับ`
  );

  return {
    ok: !!created.id,
    reply: created.id
      ? `✅ เอาตามที่อีกฝั่งขอแล้ว — สร้างนัดใน Outlook แล้ว\n📌 ${rec.subject}\n🕐 ${when}`
      : `⚠️ ตกลงเวลาแล้ว แต่สร้าง Outlook ไม่สำเร็จ: ${created.error || "unknown"}`,
  };
}

/** Host typed a new time after tapping “เปลี่ยนเอง”. */
export async function tryHandleHostEditText(
  hostUpn: string,
  text: string
): Promise<{ ok: boolean; reply: string; quickReply?: object } | null> {
  let raw: string | null = null;
  try {
    raw = await getSetting(hostUpn.toLowerCase(), HOST_EDIT_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  let draft: { inviteId: string; organizerUpn: string; ts: number };
  try {
    draft = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!draft?.inviteId || Date.now() - (draft.ts || 0) > INVITE_TTL_MS) {
    await deleteSetting(hostUpn.toLowerCase(), HOST_EDIT_KEY).catch(() => undefined);
    return null;
  }

  // Only treat as time if it looks like a time / reschedule phrase
  if (!isMeetingRescheduleText(text) && !/\d/.test(text)) return null;

  const rec = await readInvite(draft.organizerUpn, draft.inviteId);
  if (!rec) {
    await deleteSetting(hostUpn.toLowerCase(), HOST_EDIT_KEY).catch(() => undefined);
    return { ok: false, reply: "ไม่พบคำขอนัดแล้วครับ" };
  }

  const hint = extractRescheduleHint(text);
  const win = windowFromRescheduleHint(rec.start, rec.end, text.includes(":") || text.includes(".") ? text : hint);
  if (!win) {
    return {
      ok: false,
      reply: "ยังอ่านเวลาไม่ชัดครับ ลองพิมพ์แบบ 15:00 หรือ พรุ่งนี้ 15:00",
    };
  }

  const created = await createOrUpdateOutlook(rec, win.start, win.end);
  await deleteSetting(hostUpn.toLowerCase(), HOST_EDIT_KEY).catch(() => undefined);
  if (created.id) {
    rec.start = win.start;
    rec.end = win.end;
    rec.eventId = created.id;
    rec.status = "booked";
    rec.proposedHint = hint;
    rec.proposedStart = win.start;
    rec.proposedEnd = win.end;
    await saveInvite(rec.organizerUpn, rec);
  }

  const when = whenLabel(win.start, win.end);
  await notifyAttendeeOfHostDecision(
    rec,
    created.id
      ? `📬 เจ้าของนัดกำหนดเวลาใหม่แล้ว ✅\n📌 ${rec.subject}\n🕐 ${when}`
      : `📬 เจ้าของนัดเลือกเวลา ${when} แต่สร้าง Outlook ไม่สำเร็จ`
  );

  return {
    ok: !!created.id,
    reply: created.id
      ? `✅ ตั้งเวลาใหม่และสร้างนัดแล้ว\n📌 ${rec.subject}\n🕐 ${when}\n\nแจ้งอีกฝั่งแล้วครับ`
      : `⚠️ สร้างนัดไม่สำเร็จ: ${created.error || "unknown"}`,
  };
}

/**
 * Cron: re-ping unanswered LINE invitees every ~1 hour, and escalate to the
 * organizer after 1 day or when the meeting is near — ask what to do next.
 */
export async function nudgePendingMeetingInvites(): Promise<{
  scanned: number;
  nudged: number;
  hostAlerts: number;
  details: { inviteId: string; upn: string }[];
}> {
  const now = Date.now();
  const details: { inviteId: string; upn: string }[] = [];
  let scanned = 0;
  let nudged = 0;
  let hostAlerts = 0;

  let rows: { owner_upn: string; key: string; value: string }[] = [];
  try {
    const { data } = await admin.from("settings").select("owner_upn, key, value").like("key", "_mt_invite_%");
    rows = (data || []) as typeof rows;
  } catch (e) {
    console.warn("[mt-invite] nudge scan failed", String(e).slice(0, 120));
    return { scanned: 0, nudged: 0, hostAlerts: 0, details };
  }

  for (const row of rows) {
    let rec: MeetingInviteRecord;
    try {
      rec = JSON.parse(row.value) as MeetingInviteRecord;
    } catch {
      continue;
    }
    if (!rec?.id || !rec.ts) continue;
    if (now - rec.ts > INVITE_TTL_MS) continue;
    if (rec.status === "cancelled" || rec.status === "booked") continue;
    // Only follow up on LINE-hold invites (not yet in Outlook)
    if (rec.eventId) continue;
    if (rec.status && rec.status !== "pending") continue;

    const start = parseWall(rec.start);
    let startMs = 0;
    if (start) {
      startMs = new Date(wallToUtcIso(start)).getTime();
      if (startMs <= now) continue; // meeting already started / past
    }

    scanned++;
    const awaiting = linkedAwaitList(rec).filter((u) => !rec.responses[u]);
    if (!awaiting.length) continue;

    rec.nudgeAt = rec.nudgeAt || {};
    let changed = false;
    const msg = inviteMessage(rec, { nudge: true });

    for (const upn of awaiting) {
      const last = rec.nudgeAt[upn] ?? rec.ts;
      if (now - last < NUDGE_INTERVAL_MS) continue;

      try {
        const lineId = await getLineId(upn);
        if (!lineId) continue;
        await setPendingRsvp(upn, rec);
        await pushLineMessages(lineId, [msg]);
        rec.nudgeAt[upn] = now;
        nudged++;
        changed = true;
        details.push({ inviteId: rec.id, upn });
      } catch (e) {
        console.warn("[mt-invite] nudge push failed", upn, String(e).slice(0, 120));
      }
    }

    // Escalate to organizer: 1 day unanswered, or near meeting start
    let escalate: "day" | "near" | null = null;
    const untilStart = startMs > 0 ? startMs - now : Number.POSITIVE_INFINITY;
    if (untilStart > 0 && untilStart <= HOST_ESCALATE_NEAR_MS && !rec.hostAlertNear) {
      escalate = "near";
    } else if (now - rec.ts >= HOST_ESCALATE_DAY_MS && !rec.hostAlertDay) {
      escalate = "day";
    }

    if (escalate) {
      const ok = await notifyHostUnanswered(rec, awaiting, escalate);
      if (ok) {
        if (escalate === "near") rec.hostAlertNear = true;
        if (escalate === "day") rec.hostAlertDay = true;
        hostAlerts++;
        changed = true;
      }
    }

    if (changed) {
      await saveInvite(rec.organizerUpn, rec).catch((e) =>
        console.warn("[mt-invite] save nudgeAt", String(e).slice(0, 80))
      );
    }
  }

  return { scanned, nudged, hostAlerts, details };
}

async function notifyHostUnanswered(
  rec: MeetingInviteRecord,
  awaiting: string[],
  kind: "day" | "near"
): Promise<boolean> {
  const orgLine = await getLineId(rec.organizerUpn);
  if (!orgLine) return false;
  const oid = encodeURIComponent(rec.organizerUpn);
  const when = whenLabel(rec.start, rec.end);
  const who = awaiting.join(", ");
  const reason =
    kind === "near"
      ? "ใกล้ถึงเวลานัดแล้ว แต่อีกฝั่งยังไม่ตอบกลับ"
      : "รอครบ 1 วันแล้ว แต่อีกฝั่งยังไม่ตอบกลับ";

  try {
    await pushLineMessages(orgLine, [
      {
        type: "text",
        text:
          `⚠️ ${reason}\n\n` +
          `📌 ${rec.subject}\n` +
          `🕐 ${when}\n` +
          `👤 รอ: ${who}\n\n` +
          `จะเอายังไงต่อดีครับ? กดปุ่มด้านล่างได้เลย 👇`,
        quickReply: {
          items: [
            {
              type: "action",
              action: {
                type: "postback",
                label: "✅ สร้าง Outlook เลย",
                data: `a=mthostforce&oid=${oid}&id=${rec.id}`,
                displayText: "สร้างนัด Outlook เลย",
              },
            },
            {
              type: "action",
              action: {
                type: "postback",
                label: "⏳ รอต่อ",
                data: `a=mthostwait&oid=${oid}&id=${rec.id}`,
                displayText: "รออีกฝั่งต่อ",
              },
            },
            {
              type: "action",
              action: {
                type: "message",
                label: "📅 หาเวลาใหม่",
                text: hostRescheduleMessage(awaiting[0]),
              },
            },
            {
              type: "action",
              action: {
                type: "postback",
                label: "❌ ยกเลิกคำขอ",
                data: `a=mthostcancel&oid=${oid}&id=${rec.id}`,
                displayText: "ยกเลิกคำขอนัด",
              },
            },
          ],
        },
      },
    ]);
    return true;
  } catch (e) {
    console.warn("[mt-invite] host escalate failed", String(e).slice(0, 120));
    return false;
  }
}
