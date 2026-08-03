// After a meeting is booked, notify attendees who already linked LINE and
// ask them to confirm attendance. Responses are stored briefly and the
// organizer gets a LINE ping when someone accepts/declines.
import { admin } from "@/lib/supabaseServer";
import { getLineId, pushLineMessages } from "@/lib/line";
import { getSetting, setSetting, deleteSetting } from "@/lib/store";
import { fmtDateTime, fmtTime, parseWall } from "@/lib/time";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

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
  responses: Record<string, "accept" | "decline">;
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
  const text =
    "📅 คุณถูกเชิญเข้าประชุม\n\n" +
    `📌 ${rec.subject}\n` +
    `🕐 ${whenLabel(rec.start, rec.end)}\n` +
    `👤 จัดโดย: ${who}` +
    (rec.detail ? `\n📝 ${rec.detail}` : "") +
    "\n\nกรุณายืนยันการเข้าร่วมนัดนี้ครับ 👇";

  // postback data must stay under ~300 chars — keep id short
  const accept = `a=mtaccept&oid=${encodeURIComponent(rec.organizerUpn)}&id=${rec.id}`;
  const decline = `a=mtdecline&oid=${encodeURIComponent(rec.organizerUpn)}&id=${rec.id}`;

  return {
    type: "text",
    text,
    quickReply: {
      items: [
        {
          type: "action",
          action: { type: "postback", label: "✅ ยืนยันเข้าร่วม", data: accept, displayText: "ยืนยันเข้าร่วมนัด" },
        },
        {
          type: "action",
          action: { type: "postback", label: "❌ ไม่สะดวก", data: decline, displayText: "ไม่สะดวกเข้าร่วม" },
        },
      ],
    },
  };
}

/**
 * Push LINE confirmations to attendees who already added/linked the bot.
 * Returns how many were notified (for organizer feedback).
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
}): Promise<{ notified: number; names: string[] }> {
  const linked = await findLinkedLineAttendees(opts.attendees, opts.organizerUpn);
  if (!linked.length) return { notified: 0, names: [] };

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
    responses: {},
    ts: Date.now(),
  };
  await saveInvite(rec.organizerUpn, rec);

  // Also stash under each recipient so postback can find it if oid is mangled —
  // primary lookup uses organizer upn from postback.
  const msg = inviteMessage(rec);
  const names: string[] = [];
  for (const person of linked) {
    try {
      await pushLineMessages(person.lineUserId, [msg]);
      names.push(person.upn);
    } catch (e) {
      console.warn("[mt-invite] push failed", person.upn, String(e).slice(0, 120));
    }
  }
  return { notified: names.length, names };
}

export async function respondMeetingInvite(
  responderUpn: string,
  organizerUpn: string,
  inviteId: string,
  accept: boolean
): Promise<{ ok: boolean; reply: string }> {
  const rec = await readInvite(organizerUpn.toLowerCase(), inviteId);
  if (!rec) {
    return { ok: false, reply: "ไม่พบนัดนี้แล้วครับ (อาจหมดอายุหรือถูกยกเลิก) — ดูในปฏิทิน Outlook ได้ตามปกติ" };
  }

  const who = responderUpn.toLowerCase();
  rec.responses[who] = accept ? "accept" : "decline";
  await saveInvite(rec.organizerUpn, rec);

  const when = whenLabel(rec.start, rec.end);
  const reply = accept
    ? `✅ ยืนยันเข้าร่วมแล้วครับ\n📌 ${rec.subject}\n🕐 ${when}\n\nนัดนี้อยู่ในปฏิทิน Outlook ของคุณด้วยครับ`
    : `รับทราบครับ บันทึกว่าไม่สะดวกเข้าร่วม\n📌 ${rec.subject}\n🕐 ${when}`;

  // Notify organizer on LINE if linked
  try {
    const orgLine = await getLineId(rec.organizerUpn);
    if (orgLine) {
      const status = accept ? "ยืนยันเข้าร่วมแล้ว ✅" : "แจ้งว่าไม่สะดวก ❌";
      await pushLineMessages(orgLine, [
        {
          type: "text",
          text:
            `📬 อัปเดตการยืนยันนัด\n` +
            `📌 ${rec.subject}\n` +
            `🕐 ${when}\n` +
            `👤 ${who} ${status}`,
        },
      ]);
    }
  } catch {
    /* best-effort */
  }

  return { ok: true, reply };
}
