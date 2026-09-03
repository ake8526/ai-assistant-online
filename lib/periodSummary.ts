/**
 * สรุป "ช่วงเวลาหนึ่ง" ให้คนคนหนึ่ง — ใช้ร่วมกันสองที่
 *
 *  • รายงานสัปดาห์ (ศุกร์เย็น หรือสั่งเองเมื่อไรก็ได้)
 *  • "ช่วงที่ผมไม่อยู่มีอะไรบ้าง" ตอนกลับจากลา/ประชุมยาว
 *
 * ทั้งคู่ถามคำถามเดียวกันกับข้อมูลชุดเดียวกัน ต่างกันแค่มองไปข้างหลังเท่าไร
 * และเน้นอะไร จึงรวมส่วนที่ดึงข้อมูลไว้ที่เดียว
 *
 * ข้อจำกัดที่ต้องรู้: ตาราง tasks ไม่มีคอลัมน์ "ปิดเมื่อไร" (มีแต่ created_at
 * กับ status) จึงตอบไม่ได้ว่า "สัปดาห์นี้ปิดไปกี่งาน" — สิ่งที่ตอบได้จริงคือ
 * "งานที่ครบกำหนดในช่วงนี้ ตอนนี้ปิดไปแล้วกี่ใบ" ซึ่งเป็นคนละคำถามและต้องเขียน
 * ให้ตรงตามนั้น ไม่ใช่เดาแล้วเขียนตัวเลขที่ฟังดูดี
 */
import { getEventsRange, type GraphEvent } from "@/lib/graph";
import { listTasksVisibleTo, type Task } from "@/lib/store";
import { fmtDate, fmtTime, nowWall, parseWall, thaiWeekday, utcIsoToWall, wallIso } from "@/lib/time";

export type PeriodData = {
  start: Date;
  end: Date;
  /** ประชุมในช่วง (ไม่รวมรายการทั้งวันที่เป็นการกันเวลาของตัวเอง) */
  meetings: GraphEvent[];
  meetingMinutes: number;
  /** งานที่ครบกำหนดในช่วงนี้ */
  dueInRange: Task[];
  /** งานที่เพิ่งถูกสร้างในช่วงนี้ */
  createdInRange: Task[];
  /** งานที่คนอื่นมอบให้เราในช่วงนี้ */
  assignedToMe: Task[];
  /** งานค้างทั้งหมด ณ ตอนนี้ */
  openNow: Task[];
  overdueNow: Task[];
  /** งานที่เรามอบให้คนอื่นแล้วยังค้าง */
  delegatedOpen: Task[];
};

const isOpen = (t: Task) => t.status === "pending" || t.status === "overdue";

/** นาทีของประชุมหนึ่งรายการ — รายการทั้งวันนับ 0 เพราะไม่ใช่เวลาที่นั่งประชุมจริง */
function minutesOf(ev: GraphEvent): number {
  if (ev.isAllDay) return 0;
  const s = ev.start?.dateTime ? parseWall(ev.start.dateTime) : null;
  const e = ev.end?.dateTime ? parseWall(ev.end.dateTime) : null;
  if (!s || !e) return 0;
  const min = Math.round((e.getTime() - s.getTime()) / 60000);
  return min > 0 && min < 24 * 60 ? min : 0;
}

export async function collectPeriod(upn: string, start: Date, end: Date): Promise<PeriodData> {
  const [events, tasks] = await Promise.all([
    getEventsRange(upn, wallIso(start), wallIso(end)).catch(() => [] as GraphEvent[]),
    listTasksVisibleTo(upn).catch(() => [] as Task[]),
  ]);
  const me = upn.toLowerCase();
  const inRange = (iso: string | null): boolean => {
    if (!iso) return false;
    const d = utcIsoToWall(iso);
    if (!d) return false;
    return d >= start && d <= end;
  };
  const meetings = events.filter((e) => !e.isAllDay);
  return {
    start,
    end,
    meetings,
    meetingMinutes: meetings.reduce((sum, e) => sum + minutesOf(e), 0),
    dueInRange: tasks.filter((t) => inRange(t.due)),
    createdInRange: tasks.filter((t) => inRange(t.created_at)),
    assignedToMe: tasks.filter(
      (t) =>
        inRange(t.created_at) &&
        (t.responsible_upn || "").toLowerCase() === me &&
        (t.owner_upn || "").toLowerCase() !== me
    ),
    openNow: tasks.filter(isOpen),
    overdueNow: tasks.filter((t) => t.status === "overdue"),
    delegatedOpen: tasks.filter(
      (t) =>
        isOpen(t) &&
        (t.owner_upn || "").toLowerCase() === me &&
        ((t.responsible_upn && t.responsible_upn.toLowerCase() !== me) || (!t.responsible_upn && !!t.responsible))
    ),
  };
}

export function hoursLabel(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (!h) return `${m} นาที`;
  return m ? `${h} ชม. ${m} นาที` : `${h} ชม.`;
}

const dueLabel = (iso: string | null): string => {
  if (!iso) return "ไม่มีกำหนด";
  const d = utcIsoToWall(iso);
  if (!d) return iso;
  let t = fmtTime(d);
  if (t === "00:00") t = "06:00";
  return `${fmtDate(d)} ${t}`;
};

/** วันที่นัดแน่นที่สุดในช่วง — ใช้บอกว่าสัปดาห์หน้าหนักวันไหน */
function busiestDay(events: GraphEvent[]): { label: string; count: number } | null {
  const byDay = new Map<string, { d: Date; n: number }>();
  for (const e of events) {
    const s = e.start?.dateTime ? parseWall(e.start.dateTime) : null;
    if (!s) continue;
    const key = fmtDate(s);
    const cur = byDay.get(key) || { d: s, n: 0 };
    cur.n++;
    byDay.set(key, cur);
  }
  let best: { label: string; count: number } | null = null;
  for (const [key, v] of byDay) {
    if (!best || v.n > best.count) best = { label: `${thaiWeekday(v.d)} ${key}`, count: v.n };
  }
  return best && best.count > 1 ? best : null;
}

/** รายงานสัปดาห์ — มองย้อนหลังหนึ่งช่วง แล้วชี้ว่าช่วงถัดไปหนักแค่ไหน */
export function formatWeekly(past: PeriodData, ahead: PeriodData, label: string): string {
  const closedInRange = past.dueInRange.filter((t) => t.status === "done").length;
  const stillOpen = past.dueInRange.length - closedInRange;
  const lines = [`📈 ${label}`, ""];

  lines.push(`🗓 ประชุม ${past.meetings.length} นัด · รวม ${hoursLabel(past.meetingMinutes)}`);
  if (past.dueInRange.length) {
    lines.push(
      `✅ งานที่ครบกำหนดช่วงนี้ ${past.dueInRange.length} งาน — ปิดแล้ว ${closedInRange}` +
        (stillOpen ? ` · ยังค้าง ${stillOpen} ⚠️` : "")
    );
  }
  lines.push(
    `📌 ตอนนี้ค้างอยู่ ${past.openNow.length} งาน` + (past.overdueNow.length ? ` (เกินกำหนด ${past.overdueNow.length} ⚠️)` : "")
  );
  if (past.delegatedOpen.length) {
    const people = new Set(past.delegatedOpen.map((t) => t.responsible || t.responsible_upn));
    lines.push(`📤 มอบให้คนอื่นแล้วยังค้าง ${past.delegatedOpen.length} งาน · ${people.size} คน`);
  }

  const oldest = [...past.openNow]
    .filter((t) => t.due)
    .sort((a, b) => String(a.due).localeCompare(String(b.due)))[0];
  if (oldest) {
    const d = utcIsoToWall(oldest.due!);
    const days = d ? Math.floor((nowWall().getTime() - d.getTime()) / 86400000) : 0;
    if (days > 0) lines.push(`🕰 ค้างนานสุด: “${oldest.title}” (${days} วัน)`);
  }

  lines.push("", `— ช่วงถัดไป —`);
  lines.push(`🗓 มีนัดแล้ว ${ahead.meetings.length} นัด`);
  const busy = busiestDay(ahead.meetings);
  if (busy) lines.push(`   หนักสุด ${busy.label} (${busy.count} นัด)`);
  if (ahead.dueInRange.length) lines.push(`✅ งานครบกำหนด ${ahead.dueInRange.length} งาน`);

  return lines.join("\n");
}

/** "ช่วงที่ไม่อยู่มีอะไรบ้าง" — เรียงตามสิ่งที่คนเพิ่งกลับมาต้องรู้ก่อน */
export function formatCatchUp(past: PeriodData, ahead: PeriodData, label: string): string {
  const lines = [`📋 สรุปช่วง${label}ที่คุณไม่อยู่`, ""];
  let any = false;

  if (past.meetings.length) {
    any = true;
    lines.push(`🗓 ประชุมที่ผ่านไป ${past.meetings.length} นัด`);
    past.meetings.slice(0, 5).forEach((e) => {
      const s = e.start?.dateTime ? parseWall(e.start.dateTime) : null;
      lines.push(`   • ${e.subject || "(ไม่มีหัวข้อ)"}${s ? ` — ${fmtDate(s)} ${fmtTime(s)}` : ""}`);
    });
    if (past.meetings.length > 5) lines.push(`   (และอีก ${past.meetings.length - 5} นัด)`);
    lines.push(`   พิมพ์ “สรุปประชุม” เพื่ออ่านสรุปของนัดที่เปิดถอดเสียงไว้`);
    lines.push("");
  }

  if (past.assignedToMe.length) {
    any = true;
    lines.push(`✅ งานใหม่ที่ถูกมอบให้คุณ ${past.assignedToMe.length} งาน`);
    past.assignedToMe.forEach((t) =>
      lines.push(`   • ${t.title} — ${dueLabel(t.due)}${t.status === "overdue" ? " ⚠️ เลยกำหนด" : ""}`)
    );
    lines.push("");
  }

  const missedDue = past.dueInRange.filter(isOpen);
  if (missedDue.length) {
    any = true;
    lines.push(`⚠️ งานที่ครบกำหนดระหว่างที่ไม่อยู่ และยังไม่ปิด ${missedDue.length} งาน`);
    missedDue.forEach((t) => lines.push(`   • ${t.title} — ${dueLabel(t.due)}`));
    lines.push("");
  }

  if (ahead.meetings.length) {
    lines.push(`📥 นัดที่กำลังจะถึง ${ahead.meetings.length} นัด`);
    ahead.meetings.slice(0, 4).forEach((e) => {
      const s = e.start?.dateTime ? parseWall(e.start.dateTime) : null;
      lines.push(`   • ${e.subject || "(ไม่มีหัวข้อ)"}${s ? ` — ${fmtDate(s)} ${fmtTime(s)}` : ""}`);
    });
    any = true;
  }

  if (!any) return `ช่วง${label}ไม่มีอะไรค้างไว้เลยครับ 👍 สบายใจได้`;
  return lines.join("\n").trim();
}
