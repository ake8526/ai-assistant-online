// Find common free slots + free/busy ranges — ported from morning_brief/scheduling.py.
// availabilityView: one char per interval: '0'=free, '1'=tentative, '2'=busy,
// '3'=out-of-office, '4'=working-elsewhere. A slot is bookable only if everyone is '0'.
import { getSchedule } from "@/lib/graph";
import { addDays, addMinutes, fmtDate, fmtDateTime, fmtTime, nowWall, wallIso } from "@/lib/time";

const INTERVAL = 30; // minutes per availability slot

const WORK_START_HOUR = Number(process.env.WORK_START_HOUR || 9);
const WORK_END_HOUR = Number(process.env.WORK_END_HOUR || 17);
const SCHEDULE_DAYS_AHEAD = Number(process.env.SCHEDULE_DAYS_AHEAD || 7);

export type Slot = { start: string; end: string; label: string };
export type BusyMap = Record<string, { start?: string; end?: string; subject: string; status?: string }[]>;

function searchWindow(): { start: Date; end: Date } {
  const now = nowWall();
  now.setUTCMinutes(0, 0, 0);
  const start = addMinutes(now, 60);
  return { start, end: addDays(start, SCHEDULE_DAYS_AHEAD) };
}

export async function findCommonSlots(
  organizerUpn: string,
  attendeeEmails: string[],
  durationMin: number,
  maxSlots = 5
): Promise<{ slots: Slot[]; busy: BusyMap }> {
  const { start, end } = searchWindow();
  const schedules = [organizerUpn, ...attendeeEmails.filter((a) => a && a !== organizerUpn)];
  const data = await getSchedule(organizerUpn, schedules, wallIso(start), wallIso(end), INTERVAL);

  const views = data.map((d) => d.availabilityView || "");
  const n = views.length ? Math.min(...views.map((v) => v.length)) : 0;
  const need = Math.max(1, Math.ceil(durationMin / INTERVAL));

  const slots: Slot[] = [];
  let i = 0;
  while (i < n && slots.length < maxSlots) {
    const slotStart = addMinutes(start, INTERVAL * i);
    const dow = slotStart.getUTCDay();
    const inHours =
      dow >= 1 &&
      dow <= 5 &&
      slotStart.getUTCHours() >= WORK_START_HOUR &&
      slotStart.getUTCHours() + durationMin / 60 <= WORK_END_HOUR;
    const allFree = views.every((v) => v.length < i + need || v.slice(i, i + need) === "0".repeat(need));
    if (inHours && allFree) {
      const slotEnd = addMinutes(slotStart, durationMin);
      slots.push({
        start: wallIso(slotStart),
        end: wallIso(slotEnd),
        label: `${fmtDateTime(slotStart)}-${fmtTime(slotEnd)}`,
      });
      i += need; // spread suggestions out
    } else {
      i += 1;
    }
  }

  const busy: BusyMap = {};
  for (const d of data) {
    const items = ((d.scheduleItems as Record<string, unknown>[]) || []).slice(0, 5).map((it) => {
      const s = it.start as { dateTime?: string } | undefined;
      const e = it.end as { dateTime?: string } | undefined;
      return {
        start: s?.dateTime,
        end: e?.dateTime,
        subject: (it.subject as string) || "(ไม่ระบุ)",
        status: it.status as string,
      };
    });
    busy[d.scheduleId || ""] = items;
  }
  return { slots, busy };
}

type Range = { start: Date; end: Date };

async function availabilityRanges(
  targetUpn: string,
  start: Date,
  end: Date,
  requesterUpn: string | undefined,
  keepFree: boolean
): Promise<Range[]> {
  const caller = requesterUpn || targetUpn;
  const data = await getSchedule(caller, [targetUpn], wallIso(start), wallIso(end), INTERVAL);
  const view = data[0]?.availabilityView || "";

  const ranges: Range[] = [];
  let cur: Range | null = null;
  for (let i = 0; i < view.length; i++) {
    const slot = addMinutes(start, INTERVAL * i);
    const dow = slot.getUTCDay();
    const inHours = dow >= 1 && dow <= 5 && slot.getUTCHours() >= WORK_START_HOUR && slot.getUTCHours() < WORK_END_HOUR;
    const match = keepFree ? inHours && view[i] === "0" : view[i] !== "0";
    if (match) {
      if (!cur) cur = { start: slot, end: addMinutes(slot, INTERVAL) };
      else cur.end = addMinutes(slot, INTERVAL);
    } else if (cur) {
      ranges.push(cur);
      cur = null;
    }
  }
  if (cur) ranges.push(cur);
  return ranges;
}

/** Free time blocks (within working hours) for targetUpn. */
export async function freeRanges(
  targetUpn: string,
  start: Date,
  end: Date,
  requesterUpn?: string
): Promise<Range[]> {
  const now = nowWall();
  if (start < now) {
    start = new Date(now);
    start.setUTCMinutes(0, 0, 0);
  }
  return availabilityRanges(targetUpn, start, end, requesterUpn, true);
}

/** Busy time blocks for targetUpn (when they're tied up — never meeting subjects). */
export async function busyRanges(
  targetUpn: string,
  start: Date,
  end: Date,
  requesterUpn?: string
): Promise<Range[]> {
  return availabilityRanges(targetUpn, start, end, requesterUpn, false);
}

export function formatFree(ranges: Range[], label: string, who = "คุณ"): string {
  if (!ranges.length) return `ช่วง${label} ${who}ไม่มีเวลาว่างในเวลาทำงานเลยครับ (คิวแน่นมาก! 😮)`;
  const lines = [`🗓️ เวลาว่างของ${who} (${label}):`, ""];
  let lastDay: string | null = null;
  for (const r of ranges) {
    const day = fmtDate(r.start);
    if (day !== lastDay) {
      lines.push(`— ${day} —`);
      lastDay = day;
    }
    lines.push(`  ${fmtTime(r.start)} - ${fmtTime(r.end)}`);
  }
  return lines.join("\n");
}

export function formatBusy(busy: BusyMap): string {
  const lines = ["หาเวลาที่ทุกคนว่างตรงกันไม่เจอในช่วงนี้ครับ 😅", "", "ตารางที่ติด:"];
  for (const [email, items] of Object.entries(busy)) {
    if (!items.length) {
      lines.push(`  • ${email}: ว่างตลอด`);
      continue;
    }
    const first = items[0];
    let endT = "?";
    if (first.end) {
      const d = new Date(first.end.replace(/\.\d+/, "") + "Z");
      if (!isNaN(d.getTime()))
        endT = `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")} ${fmtTime(d)}`;
    }
    lines.push(`  • ${email}: ติด “${first.subject}” ถึง ${endT}` + (items.length > 1 ? " (และมีอีก)" : ""));
  }
  lines.push("", "ลองขยายช่วงวัน หรือระบุวันที่ต้องการเจาะจงได้ครับ");
  return lines.join("\n");
}
