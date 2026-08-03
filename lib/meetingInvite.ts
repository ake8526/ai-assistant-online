// After a meeting is booked, notify attendees who already linked LINE and
// ask them to confirm attendance. Responses are stored briefly and the
// organizer gets a LINE ping when someone accepts/declines.
import { admin } from "@/lib/supabaseServer";
import { getLineId, pushLineMessages } from "@/lib/line";
import { getSetting, setSetting, deleteSetting } from "@/lib/store";
import { fmtDateTime, fmtTime, parseWall } from "@/lib/time";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PENDING_RSVP_KEY = "_mt_rsvp_pending";

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

export async function tryHandleMeetingRescheduleText(
  responderUpn: string,
  text: string
): Promise<{ ok: boolean; reply: string } | null> {
  if (!isMeetingRescheduleText(text)) return null;
  const pending = await getPendingRsvp(responderUpn);
  if (!pending) return null; // let normal chat handle (e.g. host changing their own plan)

  const who = responderUpn.toLowerCase();
  const when = whenLabel(pending.start, pending.end);
  const hint = extractRescheduleHint(text);
  const orgLine = await getLineId(pending.organizerUpn);

  if (orgLine) {
    try {
      await pushLineMessages(orgLine, [
        {
          type: "text",
          text:
            `📬 คำขอเปลี่ยนเวลานัด\n` +
            `📌 ${pending.subject}\n` +
            `🕐 เดิม: ${when}\n` +
            `🙋 ${who} ขอเปลี่ยนเป็นประมาณ ${hint}\n` +
            `💬 ข้อความเดิม: “${text.trim().slice(0, 120)}”\n\n` +
            `กรุณาปรับใน Outlook / พิมพ์จองเวลาใหม่ได้ครับ`,
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
      `➡️ ขอเป็นประมาณ ${hint}\n\n` +
      `รอเจ้าของนัดปรับเวลาให้นะครับ`,
  };
}

export async function tryHandleMeetingRsvpText(
  responderUpn: string,
  text: string
): Promise<{ ok: boolean; reply: string; quickReply?: object } | null> {
  const kind = classifyMeetingRsvpText(text);
  if (!kind) return null;
  const pending = await getPendingRsvp(responderUpn);
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

function inviteMessage(rec: MeetingInviteRecord): object {
  const who = rec.organizerName || rec.organizerUpn;
  const pending = !rec.eventId && rec.status !== "booked";
  const text = pending
    ? "📅 มีคำขอนัดประชุมถึงคุณ\n\n" +
      `📌 ${rec.subject}\n` +
      `🕐 ${whenLabel(rec.start, rec.end)}\n` +
      `👤 จาก: ${who}` +
      (rec.detail ? `\n📝 ${rec.detail}` : "") +
      "\n\nยังไม่ได้สร้างใน Outlook — กรุณายืนยันก่อนครับ\n(กดปุ่ม หรือพิมพ์ “ไม่สะดวก” / “เปลี่ยนเวลาเป็น…”) 👇"
    : "📅 คุณถูกเชิญเข้าประชุม\n\n" +
      `📌 ${rec.subject}\n` +
      `🕐 ${whenLabel(rec.start, rec.end)}\n` +
      `👤 จัดโดย: ${who}` +
      (rec.detail ? `\n📝 ${rec.detail}` : "") +
      "\n\nกรุณายืนยันการเข้าร่วมนัดนี้ครับ\n(กดปุ่ม หรือพิมพ์ “ไม่สะดวก” / “ยกเลิก” ได้ครับ) 👇";

  const accept = `a=mtaccept&oid=${encodeURIComponent(rec.organizerUpn)}&id=${rec.id}`;
  const decline = `a=mtdecline&oid=${encodeURIComponent(rec.organizerUpn)}&id=${rec.id}`;

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
    awaitLine: linked.map((p) => p.upn),
    status: hold ? "pending" : opts.eventId ? "booked" : "pending",
    responses: {},
    ts: Date.now(),
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
  create: () => Promise<{ id?: string } | null | undefined>;
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
        `จะสร้างนัดให้อัตโนมัติเมื่ออีกฝั่งกดยืนยันครับ`,
    };
  }

  const ev = await opts.create();
  return {
    mode: "booked",
    notified: 0,
    names: [],
    eventId: ev?.id,
    note: opts.attendees.length
      ? "\n\n📲 ผู้เข้าร่วมยังไม่ได้ผูก LINE — ส่งคำเชิญทาง Outlook แล้วครับ"
      : "",
  };
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

  const when = whenLabel(rec.start, rec.end);
  const holding = !rec.eventId && rec.status !== "booked";
  const awaiting = linkedAwaitList(rec);

  // Decline while holding → cancel proposal, never create Outlook
  if (!accept && holding) {
    rec.status = "cancelled";
    await saveInvite(rec.organizerUpn, rec);
    try {
      const orgLine = await getLineId(rec.organizerUpn);
      if (orgLine) {
        await pushLineMessages(orgLine, [
          {
            type: "text",
            text:
              `📬 คำขอนัดถูกปฏิเสธ\n` +
              `📌 ${rec.subject}\n` +
              `🕐 ${when}\n` +
              `👤 ${who} ไม่สะดวก\n\n` +
              `ยังไม่ได้สร้างนัดใน Outlook ครับ`,
          },
        ]);
      }
    } catch {
      /* best-effort */
    }
    return {
      ok: true,
      reply: `รับทราบครับ บันทึกว่าไม่สะดวก\n📌 ${rec.subject}\n🕐 ${when}\n\nจะแจ้งเจ้าของนัดแล้ว (ยังไม่สร้างใน Outlook)`,
      quickReply: rsvpFollowUpQuickReply(rec, false),
    };
  }

  // Accept while holding → create Outlook only when everyone we're waiting on has accepted
  if (accept && holding) {
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

  // Already booked (legacy path) — just record RSVP
  const reply = accept
    ? `✅ ยืนยันเข้าร่วมแล้วครับ\n📌 ${rec.subject}\n🕐 ${when}\n\nนัดนี้อยู่ในปฏิทิน Outlook ของคุณด้วยครับ\nถ้าไม่สะดวกทีหลัง พิมพ์ “ยกเลิก” หรือกดปุ่มด้านล่างได้ครับ`
    : `รับทราบครับ บันทึกว่าไม่สะดวกเข้าร่วม\n📌 ${rec.subject}\n🕐 ${when}\n\nถ้าเปลี่ยนใจ พิมพ์ “ยืนยันเข้าร่วม” หรือกดปุ่มได้ครับ`;

  try {
    const orgLine = await getLineId(rec.organizerUpn);
    if (orgLine) {
      const status = accept ? "ยืนยันเข้าร่วมแล้ว ✅" : "แจ้งว่าไม่สะดวก ❌";
      await pushLineMessages(orgLine, [
        {
          type: "text",
          text: `📬 อัปเดตการยืนยันนัด\n📌 ${rec.subject}\n🕐 ${when}\n👤 ${who} ${status}`,
        },
      ]);
    }
  } catch {
    /* best-effort */
  }

  return { ok: true, reply, quickReply: rsvpFollowUpQuickReply(rec, accept) };
}
