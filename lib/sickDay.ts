/**
 * "วันนี้ไปไม่ไหว" — จัดการนัดทั้งวันในครั้งเดียว
 *
 * ตอนป่วยคือตอนที่คนมีแรงน้อยที่สุด แต่กลับต้องไล่แจ้งทีละนัดทีละคน สิ่งที่
 * มักเกิดคือไม่แจ้งเลย แล้วมีคนนั่งรอในห้องประชุม
 *
 * ของนี้ยิงออกนอกระบบพร้อมกันหลายนัดหลายคน จึงออกแบบให้ปลอดภัยไว้ก่อน:
 *
 *  1. แยกสองระดับ ไม่รวมเป็นปุ่มเดียว
 *     - "แจ้งลา" (ค่าเริ่มต้น) กันเวลาในปฏิทินตัวเอง + แจ้งคนที่เกี่ยวข้องทาง LINE
 *       ไม่แตะปฏิทินใคร ย้อนกลับได้
 *     - "ยกเลิกนัดที่ฉันเป็นผู้จัด" ลบ event จริง ซึ่ง **เรียกคืนไม่ได้**
 *       จึงต้องพิมพ์คำยืนยันคนละคำกัน
 *  2. คำยืนยันเป็นคำเฉพาะเสมอ (ยืนยันแจ้งลาวันนี้ / ยืนยันยกเลิกนัดวันนี้)
 *     คำว่า "ยืนยัน" ลอย ๆ ห้ามมาถึงตรงนี้ (ดู AGENTS.md — เคยพังมาแล้ว)
 *  3. แผนที่ค้างไว้หมดอายุใน 10 นาที และผูกกับรายการนัดชุดที่ผู้ใช้เพิ่งเห็น
 *  4. นัดที่ไม่มีผู้เข้าร่วมคนอื่น (บล็อกเวลาของตัวเอง) ไม่ยุ่งด้วย
 *     ไม่มีใครรอ จึงไม่มีอะไรต้องแจ้งหรือยกเลิก
 */
import { deleteEvent, getEventsRange, type GraphEvent } from "@/lib/graph";
import { getLineId, pushLineToId, pushQuotaGone } from "@/lib/line";
import { getSetting, setSetting, deleteSetting } from "@/lib/store";
import { addDays, endOfDay, fmtDate, fmtTime, nowWall, parseWall, startOfDay, wallIso } from "@/lib/time";

const PLAN_KEY = "_sickday_plan";
const PLAN_TTL_MS = 10 * 60_000;
/** กันยิงรัวถ้ามีนัดเยอะผิดปกติ — เกินนี้ให้คนเลือกเองดีกว่า */
export const MAX_MEETINGS = 8;

export type SickMeeting = {
  id: string;
  subject: string;
  startIso: string;
  timeLabel: string;
  /** เราเป็นผู้จัดนัดนี้เอง */
  organized: boolean;
  /** อีเมลคนที่ต้องรู้ว่าเราไม่ไป — ผู้เข้าร่วมคนอื่น หรือผู้จัด */
  notify: string[];
};

export type SickPlan = { ts: number; day: string; meetings: SickMeeting[] };

const mailOf = (a?: { emailAddress?: { address?: string } }): string =>
  (a?.emailAddress?.address || "").toLowerCase();

/** นัดของวันนี้ที่ยังไม่ผ่านไป และมีคนอื่นเกี่ยวข้อง */
export async function collectTodayMeetings(upn: string): Promise<SickMeeting[]> {
  const now = nowWall();
  const events = await getEventsRange(upn, wallIso(now), wallIso(endOfDay(now)));
  const me = upn.toLowerCase();
  const out: SickMeeting[] = [];
  for (const ev of events as GraphEvent[]) {
    if (ev.isAllDay || !ev.id) continue;
    const start = ev.start?.dateTime ? parseWall(ev.start.dateTime) : null;
    const end = ev.end?.dateTime ? parseWall(ev.end.dateTime) : null;
    if (!start || (end && end < now)) continue;
    const organizerMail = mailOf(ev.organizer);
    const attendees = (ev.attendees || []).map(mailOf).filter(Boolean);
    const others = attendees.filter((a) => a && a !== me);
    // บล็อกเวลาของตัวเอง — ไม่มีใครรอ ไม่ต้องแจ้งหรือยกเลิก
    if (!others.length && (!organizerMail || organizerMail === me)) continue;
    const organized = !organizerMail || organizerMail === me;
    const notify = organized ? others : [organizerMail, ...others].filter((m) => m && m !== me);
    out.push({
      id: ev.id,
      subject: ev.subject || "(ไม่มีหัวข้อ)",
      startIso: ev.start?.dateTime || "",
      timeLabel: end ? `${fmtTime(start)}-${fmtTime(end)}` : fmtTime(start),
      organized,
      notify: [...new Set(notify)],
    });
  }
  return out.sort((a, b) => a.startIso.localeCompare(b.startIso));
}

export async function savePlan(upn: string, meetings: SickMeeting[]): Promise<void> {
  const plan: SickPlan = { ts: Date.now(), day: fmtDate(nowWall()), meetings };
  await setSetting(upn.toLowerCase(), PLAN_KEY, JSON.stringify(plan));
}

/** แผนที่ค้างอยู่ — หมดอายุตามเวลา และหมดอายุเมื่อข้ามวันด้วย */
export async function loadPlan(upn: string): Promise<SickPlan | null> {
  try {
    const raw = await getSetting(upn.toLowerCase(), PLAN_KEY);
    if (!raw) return null;
    const plan = JSON.parse(raw) as SickPlan;
    if (!plan?.meetings?.length) return null;
    if (Date.now() - (plan.ts || 0) > PLAN_TTL_MS) return null;
    if (plan.day !== fmtDate(nowWall())) return null;
    return plan;
  } catch {
    return null;
  }
}

export async function clearPlan(upn: string): Promise<void> {
  await deleteSetting(upn.toLowerCase(), PLAN_KEY).catch(() => {});
}

/** ข้อความที่ส่งถึงคนอื่น — บอกให้ชัดว่าใครลาและนัดไหน */
function noticeText(who: string, m: SickMeeting, cancelled: boolean): string {
  const head = cancelled ? "❌ นัดวันนี้ถูกยกเลิก" : `🤒 แจ้งลา: ${who} เข้าร่วมไม่ได้วันนี้`;
  const body = `🕐 ${m.timeLabel} · ${m.subject}\n\n${who} ลาป่วยวันนี้ครับ` +
    (cancelled ? "\nนัดนี้ถูกยกเลิกแล้ว — จะนัดใหม่อีกครั้ง" : "\nนัดยังอยู่ตามเดิม แต่ขาดคนนี้ไปหนึ่งคน");
  return `${head}\n\n${body}`;
}

export type SickResult = {
  cancelled: string[];
  notified: number;
  couldNotNotify: string[];
  blocked: boolean;
  errors: string[];
};

/**
 * ลงมือตามแผน — `cancelOwn` จริงเมื่อผู้ใช้พิมพ์คำยืนยันชุด "ยกเลิก" เท่านั้น
 * ทุกขั้นแยก try เพราะพลาดนัดเดียวไม่ควรทำให้นัดอื่นค้างครึ่งทาง
 */
export async function applySickDay(opts: {
  upn: string;
  displayName: string;
  plan: SickPlan;
  cancelOwn: boolean;
  createEventFn: (subject: string, startIso: string, endIso: string) => Promise<unknown>;
}): Promise<SickResult> {
  const { upn, displayName, plan, cancelOwn } = opts;
  const res: SickResult = { cancelled: [], notified: 0, couldNotNotify: [], blocked: false, errors: [] };
  const quotaGone = await pushQuotaGone().catch(() => true);

  for (const m of plan.meetings) {
    const willCancel = cancelOwn && m.organized;
    if (willCancel) {
      try {
        await deleteEvent(upn, m.id);
        res.cancelled.push(`${m.timeLabel} ${m.subject}`);
      } catch (e) {
        res.errors.push(`ยกเลิก “${m.subject}” ไม่สำเร็จ: ${String(e).slice(0, 80)}`);
        continue;
      }
    }
    for (const mail of m.notify) {
      try {
        const lineId = quotaGone ? null : await getLineId(mail);
        if (!lineId) {
          res.couldNotNotify.push(mail);
          continue;
        }
        await pushLineToId(lineId, noticeText(displayName, m, willCancel));
        res.notified++;
      } catch (e) {
        res.errors.push(`แจ้ง ${mail} ไม่สำเร็จ: ${String(e).slice(0, 60)}`);
      }
    }
  }

  // กันเวลาทั้งวันในปฏิทินตัวเอง เพื่อไม่ให้ใครมานัดทับระหว่างที่ลา
  try {
    const today = startOfDay(nowWall());
    await opts.createEventFn("ลาป่วย", wallIso(today), wallIso(addDays(today, 1)));
    res.blocked = true;
  } catch (e) {
    res.errors.push(`กันเวลาในปฏิทินไม่สำเร็จ: ${String(e).slice(0, 80)}`);
  }
  return res;
}
